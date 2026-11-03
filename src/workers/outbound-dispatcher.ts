/**
 * Worker BullMQ — outbound-meta queue.
 *
 * Consome jobs enfileirados por POST /v1/messages/async e:
 *   1. Resolve sender + token (igual sync).
 *   2. Chama Meta send.
 *   3. Atualiza OutboundJob (sent ou failed).
 *   4. Se callback_url: POST com HMAC-SHA256.
 *   5. Errors retryable propagam → BullMQ retenta com backoff exponencial
 *      (até `attempts` configurado em queues.ts).
 *
 * Spawned via `pnpm worker:out` em produção. Em testes, exportamos a função
 * `processOutboundJob` para invocação direta.
 */

import { createHmac } from "node:crypto";

import { Worker } from "bullmq";
import { request } from "undici";

import { errors, isAppError } from "@/lib/errors.js";
import { logger } from "@/lib/logger.js";
import { workerJobsTotal } from "@/lib/metrics.js";
import { createBullMQConnection, closeRedis } from "@/lib/redis.js";
import { OUTBOUND_QUEUE, type OutboundJobPayload } from "@/lib/queues.js";
import { unsealOutboundJobSecrets } from "@/lib/job-seal.js";
import { installShutdownHandlers, registerShutdownHook } from "@/lib/shutdown.js";
import { startWorkerMetricsServer } from "@/lib/worker-metrics-server.js";
import { incrementAttempts, updateJobStatus } from "@/modules/messages/repository.js";
import { sendMessage } from "@/modules/messages/service.js";
import type { SendMessageBody } from "@/modules/messages/schemas.js";

const WORKER_NAME = "outbound-dispatcher";

interface CallbackPayload {
  job_id: string;
  status: "sent" | "failed";
  channel: "whatsapp" | "instagram";
  provider_message_id: string | null;
  error: { code: string; message: string } | null;
}

async function deliverCallback(
  url: string,
  secret: string | undefined,
  payload: CallbackPayload,
): Promise<void> {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secret) {
    const sig = createHmac("sha256", secret).update(body).digest("hex");
    headers["x-bevox-signature-256"] = `sha256=${sig}`;
  }
  // Best-effort: timeout curto, falha não derruba o job (já está persistido).
  try {
    const res = await request(url, {
      method: "POST",
      headers,
      body,
      headersTimeout: 5_000,
      bodyTimeout: 5_000,
    });
    if (res.statusCode >= 400) {
      logger().warn(
        { callback_url: url, status: res.statusCode, job_id: payload.job_id },
        "callback delivery returned non-2xx",
      );
    }
  } catch (err) {
    logger().warn(
      { callback_url: url, err, job_id: payload.job_id },
      "callback delivery failed (best-effort, ignoring)",
    );
  }
}

export async function processOutboundJob(payload: OutboundJobPayload): Promise<void> {
  await incrementAttempts(payload.job_id);
  await updateJobStatus(payload.job_id, { status: "sending" });

  // Fix A3 (audit 2026-06-02): decifra request_body + callback_secret a partir
  // do envelope sealed do payload. Falha decryption (auth tag inválida, AAD
  // swap, ciphertext adulterado) é tratada como erro INTERNAL — não retryable.
  // O encryption_context amarra ao { app_id, tenant_id, job_id } deste job.
  const secrets = await unsealOutboundJobSecrets(payload.sealed_secrets);
  const requestBody = secrets.request_body;
  const callbackSecret = secrets.callback_secret;

  // Reusa caminho síncrono — mesma lógica de validação + envio + persist.
  // `sendMessage` cria um NOVO row de OutboundJob; aqui já temos um (queued).
  // Para evitar duplicação, atualizamos o job existente em vez de delegar
  // 100% para sendMessage. Reuso parcial:
  //   - Reusamos service helpers via copy mínima abaixo.

  // V1 simplificação: chamamos sendMessage e depois "merge" o resultado no
  // job queued via update. Isso cria duas linhas (audit + queued) — aceitável
  // em V1; refinar quando audit-log plugin estiver pronto.
  let result;
  let callbackPayload: CallbackPayload;
  try {
    result = await sendMessage({
      appId: payload.app_id,
      tenantId: payload.tenant_id,
      // Idempotency key derivada do job_id pra não conflitar com outras chaves.
      idempotencyKey: `async:${payload.job_id}`,
      body: requestBody as unknown as SendMessageBody,
    });
    await updateJobStatus(payload.job_id, {
      status: "sent",
      providerMessageId: result.provider_message_id,
      lastError: null,
      completedAt: new Date(),
    });
    callbackPayload = {
      job_id: payload.job_id,
      status: "sent",
      channel: payload.channel,
      provider_message_id: result.provider_message_id,
      error: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = isAppError(err) ? err.code : "INTERNAL";
    const isRetryable =
      isAppError(err) && (err.code === "META_UNAVAILABLE" || err.code === "RATE_LIMITED");

    await updateJobStatus(payload.job_id, {
      status: isRetryable ? "queued" : "failed",
      lastError: `${code}: ${message}`,
      completedAt: isRetryable ? null : new Date(),
    });

    if (isRetryable) {
      // Re-throw para que BullMQ aplique backoff exponencial.
      throw err;
    }

    callbackPayload = {
      job_id: payload.job_id,
      status: "failed",
      channel: payload.channel,
      provider_message_id: null,
      error: { code, message },
    };
  }

  if (payload.callback_url) {
    await deliverCallback(payload.callback_url, callbackSecret, callbackPayload);
  }
}

/**
 * Inicia o Worker (chamado por `pnpm worker:out`).
 */
export function startOutboundWorker(): Worker {
  const worker = new Worker<OutboundJobPayload>(
    OUTBOUND_QUEUE,
    async (job) => {
      await processOutboundJob(job.data);
    },
    {
      connection: createBullMQConnection(),
      concurrency: 10,
    },
  );

  worker.on("completed", () => {
    workerJobsTotal.inc({ worker: WORKER_NAME, outcome: "ok" });
  });
  worker.on("failed", (job, err) => {
    workerJobsTotal.inc({ worker: WORKER_NAME, outcome: "failed" });
    logger().error(
      { job_id: job?.id, err, attempts_made: job?.attemptsMade },
      "outbound job failed",
    );
  });
  worker.on("error", (err) => {
    logger().error({ err }, "outbound worker error");
  });

  registerShutdownHook("outbound-worker", () => worker.close());

  return worker;
}

// Entry point quando rodado como script (`pnpm worker:out`).
const isMain =
  typeof process.argv[1] === "string" && /outbound-dispatcher\.(ts|js)$/.test(process.argv[1]);

if (isMain) {
  installShutdownHandlers();
  registerShutdownHook("redis", () => closeRedis());
  void startWorkerMetricsServer({ workerName: WORKER_NAME }).catch((err) => {
    logger().error({ err }, "failed to start worker metrics server");
  });
  startOutboundWorker();
  logger().info("outbound dispatcher started");
}

// Re-export para testes.
export { OUTBOUND_QUEUE };

// Defensivo: chamar errors aqui evita "unused import" se path acima muda.
void errors;
