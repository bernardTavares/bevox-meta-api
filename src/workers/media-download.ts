/**
 * Worker BullMQ — media-download queue.
 *
 * Consome jobs enfileirados pelo inbound webhook receiver quando um evento
 * inbound traz mídia (image/audio/video/document). Baixa os bytes da temp
 * CDN url da Meta DENTRO da janela de ~5 min e os persiste no MinIO.
 *
 * Eager fire-and-forget: o evento inbound em si é encaminhado em separado /
 * imediatamente por outra task — este worker apenas faz download + store.
 *
 * Idempotente: se a key já existe no storage, não re-baixa.
 *
 * O plaintext token resolvido NUNCA é logado (CLAUDE.md §5.4).
 */

import { Worker } from "bullmq";

import { env } from "@/config/env.js";
import { logger } from "@/lib/logger.js";
import { mediaObjectKey, putMedia, headMedia } from "@/lib/media-storage.js";
import { workerJobsTotal } from "@/lib/metrics.js";
import { MEDIA_DOWNLOAD_QUEUE } from "@/lib/queues.js";
import { closeRedis, createBullMQConnection } from "@/lib/redis.js";
import { installShutdownHandlers, registerShutdownHook } from "@/lib/shutdown.js";
import { startWorkerMetricsServer } from "@/lib/worker-metrics-server.js";
import { getMetaOAuthClient } from "@/integration/meta-client.js";
import { listWabasByTenant } from "@/modules/wabas/repository.js";
import { resolveActiveWabaToken } from "@/modules/wabas/token-resolver.js";

const WORKER_NAME = "media-download";

export interface MediaDownloadJob {
  app_id: string;
  tenant_id: string;
  media_id: string;
}

const CONCURRENCY = 10;

export async function processMediaDownload(job: MediaDownloadJob): Promise<void> {
  const key = mediaObjectKey(job.tenant_id, job.media_id);

  // Idempotência: já no storage → nada a fazer.
  if (await headMedia(key)) {
    return;
  }

  // listWabasByTenant já filtra desconectados (active = disconnectedAt IS NULL);
  // a primeira linha é a conexão ativa.
  const wabas = await listWabasByTenant(job.app_id, job.tenant_id);
  const active = wabas[0];
  if (!active) {
    logger().warn({ tenant_id: job.tenant_id }, "no active waba; media skipped");
    return;
  }

  const { accessToken } = await resolveActiveWabaToken(active.id);
  const client = getMetaOAuthClient();

  const meta = await client.getMediaMetadata(job.media_id, accessToken);
  if (meta.file_size > env().MEDIA_MAX_BYTES) {
    logger().warn(
      { media_id: job.media_id, size: meta.file_size },
      "media exceeds MEDIA_MAX_BYTES; skipped",
    );
    return;
  }

  const bytes = await client.downloadMedia(meta.url, accessToken);
  await putMedia(key, bytes, meta.mime_type);
  logger().info({ media_id: job.media_id, size: meta.file_size }, "media stored");
}

export function startMediaDownloadWorker(): Worker {
  const worker = new Worker<MediaDownloadJob>(
    MEDIA_DOWNLOAD_QUEUE,
    async (job) => {
      await processMediaDownload(job.data);
    },
    {
      connection: createBullMQConnection(),
      concurrency: CONCURRENCY,
    },
  );

  worker.on("completed", () => {
    workerJobsTotal.inc({ worker: WORKER_NAME, outcome: "ok" });
  });
  worker.on("failed", (job, err) => {
    workerJobsTotal.inc({ worker: WORKER_NAME, outcome: "failed" });
    logger().warn({ job_id: job?.id, err }, "media download failed");
  });
  worker.on("error", (err) => {
    logger().error({ err }, "media download worker error");
  });

  registerShutdownHook("media-download-worker", () => worker.close());
  return worker;
}

const isMain =
  typeof process.argv[1] === "string" && /media-download\.(ts|js)$/.test(process.argv[1]);

if (isMain) {
  installShutdownHandlers();
  registerShutdownHook("redis", () => closeRedis());
  void startWorkerMetricsServer({ workerName: WORKER_NAME }).catch((err) => {
    logger().error({ err }, "failed to start worker metrics server");
  });
  startMediaDownloadWorker();
  logger().info("media-download worker started");
}
