/**
 * Worker BullMQ — webhook-delivery queue.
 *
 * Consome jobs enfileirados pelo inbound webhook receiver (task #20) e:
 *   1. Carrega Subscription + InboundEvent.
 *   2. Decifra secret via envelope (MA-008).
 *   3. Constrói payload canônico Bevox.
 *   4. Assina HMAC-SHA256 e POSTa.
 *   5. Status 2xx → delivered. Não-2xx ou timeout → retry com backoff.
 *   6. Após `MAX_ATTEMPTS` tentativas: dead_letter.
 *
 * TLS é OBRIGATÓRIO: URLs http:// são rejeitadas no enqueue (idealmente
 * validar no admin endpoint quando o consumer registra a subscription —
 * task #22). Aqui também checamos como defesa em profundidade.
 */

import { createHmac } from "node:crypto";

import { Worker } from "bullmq";
import { request } from "undici";

import { env } from "@/config/env.js";
import { errors, isAppError } from "@/lib/errors.js";
import { logger } from "@/lib/logger.js";
import { webhookDeliveryTotal, workerJobsTotal } from "@/lib/metrics.js";
import {
  getWebhookBackoffDelay,
  WEBHOOK_BACKOFF_STRATEGY,
  WEBHOOK_DELIVERY_QUEUE,
} from "@/lib/queues.js";
import { closeRedis, createBullMQConnection } from "@/lib/redis.js";
import { installShutdownHandlers, registerShutdownHook } from "@/lib/shutdown.js";
import { startWorkerMetricsServer } from "@/lib/worker-metrics-server.js";
import { findInboundEventById } from "@/modules/inbound/repository.js";

const WORKER_NAME = "webhook-delivery";

import {
  findOrCreateDelivery,
  findSubscriptionById,
  updateDeliveryAttempt,
} from "@/modules/webhooks/repository.js";
import { resolveSubscriptionSecret } from "@/modules/webhooks/secret-resolver.js";

export interface WebhookDeliveryJob {
  subscription_id: string;
  inbound_event_id: string;
  event_type: string;
}

/**
 * Máximo de tentativas antes de marcar a delivery como `dead_letter`.
 *
 * C3 fix: alinhado com `env().WEBHOOK_DELIVERY_MAX_RETRIES` (default 8) — o
 * mesmo valor que `webhookDeliveryJobOptions()` injeta no job BullMQ. Sem
 * esse alinhamento, BullMQ encerrava antes do branch terminal
 * (`>= MAX_ATTEMPTS`) e a delivery jamais virava `dead_letter` →
 * `listDeadLetterDeliveries` retornava 0 → replay admin não recuperava nada.
 */
export const MAX_ATTEMPTS = env().WEBHOOK_DELIVERY_MAX_RETRIES;
const REQUEST_TIMEOUT_MS = 10_000;

interface CanonicalPayload {
  event_id: string;
  event_type: string;
  tenant_id: string | null;
  occurred_at: string;
  data: unknown;
}

function signPayload(secret: string, body: string): { header: string; ts: number } {
  const ts = Math.floor(Date.now() / 1000);
  const signedString = `${ts}.${body}`;
  const sig = createHmac("sha256", secret).update(signedString).digest("hex");
  return { header: `t=${ts},v1=${sig}`, ts };
}

interface DeliveryResult {
  ok: boolean;
  status: number | null;
  errorMessage: string | null;
}

async function deliverPost(
  url: string,
  body: string,
  signatureHeader: string,
): Promise<DeliveryResult> {
  try {
    const res = await request(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-bevox-signature": signatureHeader,
      },
      body,
      headersTimeout: REQUEST_TIMEOUT_MS,
      bodyTimeout: REQUEST_TIMEOUT_MS,
    });
    // Drena body pra liberar socket.
    await res.body.dump();
    if (res.statusCode >= 200 && res.statusCode < 300) {
      return { ok: true, status: res.statusCode, errorMessage: null };
    }
    return {
      ok: false,
      status: res.statusCode,
      errorMessage: `HTTP ${res.statusCode}`,
    };
  } catch (err) {
    return {
      ok: false,
      status: null,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function processWebhookDelivery(
  payload: WebhookDeliveryJob,
  attemptsMade: number,
): Promise<void> {
  const sub = await findSubscriptionById(payload.subscription_id);
  if (!sub) {
    logger().warn(
      { subscription_id: payload.subscription_id },
      "subscription not found, dropping job",
    );
    return;
  }
  if (sub.status !== "active") {
    logger().info(
      { subscription_id: sub.id, status: sub.status },
      "subscription not active, dropping job",
    );
    return;
  }
  if (!sub.url.startsWith("https://")) {
    throw errors.invalidInput("Webhook URL must use https://", { url: sub.url });
  }

  const event = await findInboundEventById(payload.inbound_event_id);
  if (!event) {
    logger().warn(
      { inbound_event_id: payload.inbound_event_id },
      "inbound event vanished, dropping job",
    );
    return;
  }

  const delivery = await findOrCreateDelivery({
    subscriptionId: sub.id,
    inboundEventId: event.id,
  });
  if (delivery.status === "delivered") {
    logger().info({ delivery_id: delivery.id }, "already delivered, skipping");
    return;
  }

  const canonical: CanonicalPayload = {
    event_id: event.id,
    event_type: payload.event_type,
    tenant_id: event.tenantId,
    occurred_at: event.receivedAt.toISOString(),
    data: event.payloadJson,
  };
  const body = JSON.stringify(canonical);

  const secret = await resolveSubscriptionSecret(sub);
  const { header } = signPayload(secret, body);

  const result = await deliverPost(sub.url, body, header);

  const newAttempts = (delivery.attempts ?? 0) + 1;
  // attemptsMade vem do BullMQ (1-indexed após primeiro processamento).
  // Usamos o maior dos dois para resiliência a inserts paralelos.
  const totalAttempts = Math.max(newAttempts, attemptsMade);

  if (result.ok) {
    await updateDeliveryAttempt(delivery.id, {
      status: "delivered",
      attempts: totalAttempts,
      lastResponseStatus: result.status,
      lastError: null,
      lastAttemptAt: new Date(),
      nextRetryAt: null,
    });
    // A6 fix: contador estava declarado mas nunca incrementado.
    webhookDeliveryTotal.inc({ outcome: "delivered" });
    return;
  }

  const isTerminal = totalAttempts >= MAX_ATTEMPTS;
  await updateDeliveryAttempt(delivery.id, {
    status: isTerminal ? "dead_letter" : "failed",
    attempts: totalAttempts,
    lastResponseStatus: result.status,
    lastError: result.errorMessage,
    lastAttemptAt: new Date(),
    nextRetryAt: isTerminal ? null : new Date(Date.now() + 30_000),
  });
  // A6 fix: cada falha incrementa, distinguindo `failed` (retriable) de
  // `dead_letter` (terminal) — operador precisa do ratio para alerting.
  webhookDeliveryTotal.inc({ outcome: isTerminal ? "dead_letter" : "failed" });

  if (!isTerminal) {
    // Re-throw para BullMQ aplicar backoff (até MAX_ATTEMPTS).
    throw new Error(`webhook delivery failed: ${result.errorMessage}`);
  }
  // Terminal: NÃO re-throw → BullMQ marca como completed (com nosso registro
  // já em dead_letter). TODO: emitir evento webhook.dead_letter próprio.
}

export function startWebhookDeliveryWorker(): Worker {
  const worker = new Worker<WebhookDeliveryJob>(
    WEBHOOK_DELIVERY_QUEUE,
    async (job) => {
      await processWebhookDelivery(job.data, job.attemptsMade);
    },
    {
      connection: createBullMQConnection(),
      concurrency: 20,
      // C3: custom backoff PRD §10.2 [0s,30s,2min,10min,1h,6h]. Jobs
      // enfileirados com `backoff: { type: WEBHOOK_BACKOFF_STRATEGY }`
      // (ver `webhookDeliveryJobOptions()` em lib/queues.ts) resolvem o
      // delay aqui.
      settings: {
        backoffStrategy: (attemptsMade, type) => {
          if (type === WEBHOOK_BACKOFF_STRATEGY) {
            return getWebhookBackoffDelay(attemptsMade);
          }
          // Fallback defensivo para qualquer outra strategy custom inesperada.
          return 0;
        },
      },
    },
  );

  worker.on("completed", () => {
    workerJobsTotal.inc({ worker: WORKER_NAME, outcome: "ok" });
  });
  worker.on("failed", (job, err) => {
    workerJobsTotal.inc({ worker: WORKER_NAME, outcome: "failed" });
    logger().warn(
      { job_id: job?.id, attempts_made: job?.attemptsMade, err },
      "webhook delivery attempt failed",
    );
  });
  worker.on("error", (err) => {
    logger().error({ err }, "webhook delivery worker error");
  });

  registerShutdownHook("webhook-delivery-worker", () => worker.close());
  return worker;
}

const isMain =
  typeof process.argv[1] === "string" && /webhook-delivery\.(ts|js)$/.test(process.argv[1]);

if (isMain) {
  installShutdownHandlers();
  registerShutdownHook("redis", () => closeRedis());
  void startWorkerMetricsServer({ workerName: WORKER_NAME }).catch((err) => {
    logger().error({ err }, "failed to start worker metrics server");
  });
  startWebhookDeliveryWorker();
  logger().info("webhook-delivery worker started");
}

// Defensivo: garante que isAppError fica disponível mesmo se loggers mudarem.
void isAppError;
