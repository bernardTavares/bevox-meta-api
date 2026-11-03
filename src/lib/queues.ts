/**
 * BullMQ queues — fábricas centralizadas para evitar drift de configuração.
 *
 * Cada Worker/QueueScheduler precisa de conexão Redis dedicada com
 * `maxRetriesPerRequest: null` (createBullMQConnection já cuida disso).
 *
 * Convenções:
 *   - removeOnComplete TTL 7 dias.
 *   - outbound/media: attempts 5 + backoff exponencial (5s base).
 *   - webhook-delivery: attempts = WEBHOOK_DELIVERY_MAX_RETRIES (default 8)
 *     + backoff custom PRD §10.2 [0s, 30s, 2min, 10min, 1h, 6h]. Necessário
 *     para que o branch terminal `dead_letter` do worker (ver
 *     `src/workers/webhook-delivery.ts`) seja efetivamente alcançado.
 *   - jobId = OutboundJob.id (UUIDv7) ou `${subscription}:${event}` em
 *     webhook-delivery → idempotência da inserção.
 */

import { Queue, type JobsOptions } from "bullmq";

import { env } from "@/config/env.js";

import { createBullMQConnection } from "./redis.js";
import type { SealedSecrets } from "./job-seal.js";

export const OUTBOUND_QUEUE = "outbound-meta";
export const WEBHOOK_DELIVERY_QUEUE = "webhook-delivery";
export const MEDIA_DOWNLOAD_QUEUE = "media-download";

const SEVEN_DAYS_SECONDS = 7 * 24 * 3600;

export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 5_000 },
  removeOnComplete: { age: SEVEN_DAYS_SECONDS, count: 10_000 },
  removeOnFail: { age: SEVEN_DAYS_SECONDS, count: 5_000 },
};

/**
 * Identificador da custom backoff strategy registrada no worker
 * webhook-delivery. Jobs apontam para este nome via
 * `backoff: { type: WEBHOOK_BACKOFF_STRATEGY }`; o worker resolve o delay
 * via `getWebhookBackoffDelay(attemptsMade)`.
 */
export const WEBHOOK_BACKOFF_STRATEGY = "bevox-prd-10-2";

/**
 * PRD §10.2 — sequência de espera entre retries de webhook-delivery, em ms.
 * Índice 0 = delay APÓS a 1ª falha; índice 5 = APÓS a 6ª falha; tentativas
 * adicionais (caso `WEBHOOK_DELIVERY_MAX_RETRIES` seja maior) repetem o
 * último valor (6h).
 *
 * Schedule canônico (PRD §10.2):
 *   1ª falha →    0s
 *   2ª falha →   30s
 *   3ª falha →  2min
 *   4ª falha → 10min
 *   5ª falha →    1h
 *   6ª falha →    6h
 *   demais   →    6h (clamp)
 */
export const WEBHOOK_BACKOFF_SCHEDULE_MS: readonly number[] = [
  0, 30_000, 120_000, 600_000, 3_600_000, 21_600_000,
] as const;

/**
 * Resolve o delay (em ms) para a próxima tentativa de webhook-delivery.
 * `attemptsMade` é 1-indexed (BullMQ passa 1 após a 1ª falha). Valores
 * <= 0 caem em 0; valores acima do array repetem o último (6h).
 */
export function getWebhookBackoffDelay(attemptsMade: number): number {
  if (attemptsMade <= 0) return 0;
  const idx = Math.min(attemptsMade - 1, WEBHOOK_BACKOFF_SCHEDULE_MS.length - 1);
  return WEBHOOK_BACKOFF_SCHEDULE_MS[idx]!;
}

/**
 * Job options para `webhook-delivery`: explicita `attempts` (env-driven) e
 * a strategy de backoff PRD §10.2. Lazy (chamado por enqueue-time) para
 * refletir a env atual mesmo em testes que mexem em `process.env`.
 */
export function webhookDeliveryJobOptions(): JobsOptions {
  return {
    attempts: env().WEBHOOK_DELIVERY_MAX_RETRIES,
    backoff: { type: WEBHOOK_BACKOFF_STRATEGY },
    removeOnComplete: { age: SEVEN_DAYS_SECONDS, count: 10_000 },
    removeOnFail: { age: SEVEN_DAYS_SECONDS, count: 5_000 },
  };
}

let outbound: Queue | null = null;
let webhookDelivery: Queue | null = null;
let mediaDownload: Queue | null = null;

export function getOutboundQueue(): Queue {
  if (!outbound) {
    outbound = new Queue(OUTBOUND_QUEUE, {
      connection: createBullMQConnection(),
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });
  }
  return outbound;
}

export function getWebhookDeliveryQueue(): Queue {
  if (!webhookDelivery) {
    webhookDelivery = new Queue(WEBHOOK_DELIVERY_QUEUE, {
      connection: createBullMQConnection(),
      // Default da queue refletindo o contrato (C3): jobs herdam attempts +
      // strategy PRD §10.2 mesmo se o produtor esquecer de passar
      // `webhookDeliveryJobOptions()` no `.add()`.
      defaultJobOptions: webhookDeliveryJobOptions(),
    });
  }
  return webhookDelivery;
}

export function getMediaDownloadQueue(): Queue {
  if (!mediaDownload) {
    mediaDownload = new Queue(MEDIA_DOWNLOAD_QUEUE, {
      connection: createBullMQConnection(),
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });
  }
  return mediaDownload;
}

export async function closeQueues(): Promise<void> {
  if (outbound) {
    await outbound.close();
    outbound = null;
  }
  if (webhookDelivery) {
    await webhookDelivery.close();
    webhookDelivery = null;
  }
  if (mediaDownload) {
    await mediaDownload.close();
    mediaDownload = null;
  }
}

export function __resetQueuesForTests(): void {
  outbound = null;
  webhookDelivery = null;
  mediaDownload = null;
}

/**
 * Payload sealed do outbound-job — formato armazenado em Redis (BullMQ).
 *
 * Fix A3 (audit 2026-06-02): `request_body` (PII: número de telefone,
 * conteúdo de mensagem) e `callback_secret` (segredo HMAC) NÃO podem
 * ficar em plaintext na fila; o blob em Redis é visível a qualquer
 * reader (operador, snapshot, backup). Os campos sensíveis são cifrados
 * via envelope encryption (MA-008) em `sealed_secrets` (ver
 * `src/lib/redact.ts`); o worker decifra no consumo via
 * `unsealOutboundJobSecrets`.
 *
 * `callback_url` permanece em plaintext: NÃO é segredo (URL pública do
 * consumidor) e ops costuma precisar dele para debug de delivery sem
 * abrir o envelope.
 */
export interface OutboundJobPayload {
  job_id: string;
  app_id: string;
  tenant_id: string;
  idempotency_key: string;
  channel: "whatsapp" | "instagram";
  /**
   * Bloco AES-256-GCM (envelope encryption MA-008) com
   * `{ request_body, callback_secret? }`. Decifrável apenas pelo worker
   * com o encryption_context exato deste job (binding por app_id +
   * tenant_id + job_id).
   */
  sealed_secrets: SealedSecrets;
  callback_url?: string;
}

export interface MediaDownloadJobPayload {
  app_id: string;
  tenant_id: string;
  media_id: string;
}
