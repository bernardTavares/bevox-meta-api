/**
 * Worker cron — cleanup de registros expirados.
 *
 * Política de retenção:
 *   - IdempotencyRecord: TTL 24h (expires_at em row); deletar tudo expirado.
 *   - InboundEvent: 90 dias (mantém histórico para audit/replay).
 *   - OutboundJob: 30 dias (status terminal apenas).
 *
 * Roda diariamente às 3am UTC (baixo tráfego). Tickagem inicial no boot
 * para garantir convergência caso o worker fique offline.
 */

import { cleanupDeletedTotal, workerJobsTotal } from "@/lib/metrics.js";
import { logger } from "@/lib/logger.js";
import { closeRedis } from "@/lib/redis.js";
import { installShutdownHandlers, registerShutdownHook } from "@/lib/shutdown.js";
import { startWorkerMetricsServer } from "@/lib/worker-metrics-server.js";
import {
  cleanExpiredIdempotency,
  cleanOldInboundEvents,
  cleanOldOutboundJobs,
} from "@/modules/cleanup/repository.js";

const WORKER_NAME = "cleanup";

const DAY_MS = 24 * 60 * 60 * 1000;
const INBOUND_RETENTION_DAYS = 90;
const OUTBOUND_RETENTION_DAYS = 30;
const POLL_INTERVAL_MS = DAY_MS;

export interface CleanupResult {
  idempotency_records: number;
  inbound_events: number;
  outbound_jobs: number;
}

export async function runCleanup(now: Date = new Date()): Promise<CleanupResult> {
  const inboundCutoff = new Date(now.getTime() - INBOUND_RETENTION_DAYS * DAY_MS);
  const outboundCutoff = new Date(now.getTime() - OUTBOUND_RETENTION_DAYS * DAY_MS);

  const [idem, inbound, outbound] = await Promise.all([
    cleanExpiredIdempotency(now),
    cleanOldInboundEvents(inboundCutoff),
    cleanOldOutboundJobs(outboundCutoff),
  ]);

  cleanupDeletedTotal.inc({ table: "idempotency_records" }, idem);
  cleanupDeletedTotal.inc({ table: "inbound_events" }, inbound);
  cleanupDeletedTotal.inc({ table: "outbound_jobs" }, outbound);

  return {
    idempotency_records: idem,
    inbound_events: inbound,
    outbound_jobs: outbound,
  };
}

let intervalHandle: NodeJS.Timeout | null = null;

export function startCleanupWorker(): void {
  const tick = async () => {
    try {
      const result = await runCleanup();
      workerJobsTotal.inc({ worker: WORKER_NAME, outcome: "ok" });
      logger().info({ ...result }, "cleanup tick complete");
    } catch (err) {
      workerJobsTotal.inc({ worker: WORKER_NAME, outcome: "failed" });
      logger().error({ err }, "cleanup tick failed");
    }
  };
  void tick();
  intervalHandle = setInterval(() => void tick(), POLL_INTERVAL_MS);
  registerShutdownHook("cleanup-worker", () => {
    if (intervalHandle) {
      clearInterval(intervalHandle);
      intervalHandle = null;
    }
  });
}

const isMain = typeof process.argv[1] === "string" && /cleanup\.(ts|js)$/.test(process.argv[1]);

if (isMain) {
  installShutdownHandlers();
  registerShutdownHook("redis", () => closeRedis());
  void startWorkerMetricsServer({ workerName: WORKER_NAME }).catch((err) => {
    logger().error({ err }, "failed to start worker metrics server");
  });
  startCleanupWorker();
  logger().info("cleanup worker started");
}
