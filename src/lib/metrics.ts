/**
 * Métricas Prometheus — PRD §13.3.
 *
 * Registry global + métricas-chave (HTTP, Meta upstream, queue, webhook
 * delivery, token refresh). Default Node metrics (event loop lag, GC, heap)
 * são coletadas automaticamente.
 *
 * Uso:
 *   import { httpRequestDuration, metaRequestDuration, ... } from '@/lib/metrics.js';
 *   httpRequestDuration.observe({...labels}, durationSec);
 */

import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";

export const registry = new Registry();

collectDefaultMetrics({ register: registry, prefix: "bevox_meta_api_" });

// ---------------------------------------------------------------------------
// HTTP server (Fastify)
// ---------------------------------------------------------------------------

export const httpRequestDuration = new Histogram({
  name: "bevox_meta_api_http_request_duration_seconds",
  help: "Latência de requests HTTP por método/rota/status",
  labelNames: ["method", "route", "status_code"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const httpRequestsTotal = new Counter({
  name: "bevox_meta_api_http_requests_total",
  help: "Total de requests HTTP (rotuladas por method/route/status/app)",
  labelNames: ["method", "route", "status_code", "app_id"],
  registers: [registry],
});

// ---------------------------------------------------------------------------
// Meta upstream
// ---------------------------------------------------------------------------

export const metaRequestDuration = new Histogram({
  name: "bevox_meta_api_meta_request_duration_seconds",
  help: "Latência de chamadas à Graph API",
  labelNames: ["endpoint", "outcome"],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [registry],
});

// ---------------------------------------------------------------------------
// BullMQ
// ---------------------------------------------------------------------------

export const queueSize = new Gauge({
  name: "bevox_meta_api_queue_size",
  help: "Tamanho atual da fila (waiting + active)",
  labelNames: ["queue"],
  registers: [registry],
});

// ---------------------------------------------------------------------------
// Webhook delivery
// ---------------------------------------------------------------------------

/**
 * A6 fix (audit 2026-06-02): counter estava declarado mas nunca incrementado
 * — operador ficava cego para taxa de falhas / dead_letter saturada. Agora
 * `processWebhookDelivery` (worker) emite `delivered`, `failed` ou
 * `dead_letter` para cada tentativa.
 */
export const webhookDeliveryTotal = new Counter({
  name: "bevox_meta_api_webhook_delivery_total",
  help: "Tentativas de entrega de webhook por outcome",
  labelNames: ["outcome"], // delivered | failed | dead_letter
  registers: [registry],
});

// ---------------------------------------------------------------------------
// Inbound webhook (Meta) — recepção
// ---------------------------------------------------------------------------

/**
 * A6 fix (audit 2026-06-02): caminho de HMAC inválido emitia 0 métrica →
 * cego para tentativas de forgery / config drift do app secret. Counter
 * labeled por `outcome` (ok | invalid_signature | missing_signature |
 * parse_error) permite alerting em surges.
 */
export const metaWebhookReceivedTotal = new Counter({
  name: "bevox_meta_api_meta_webhook_received_total",
  help: "Webhooks POST /webhooks/meta por outcome de validação",
  labelNames: ["outcome"], // ok | invalid_signature | missing_signature | parse_error
  registers: [registry],
});

/**
 * A6 fix (audit 2026-06-02): pipeline de processamento (pós-HMAC) também
 * estava cego. Cada evento decomposto do payload entra em UM destes outcomes:
 *   - `persisted`: InboundEvent gravado com tenant resolvido.
 *   - `deduplicated`: meta_event_id já visto na janela TTL (24h Redis).
 *   - `orphan`: persistido mas sem tenant resolvido (WABA/IG desconhecido).
 *
 * Permite alerting em surges de dedup (Meta replayed?) ou orphans (config
 * drift / WABA/IG desconectado).
 */
export const metaWebhookProcessedTotal = new Counter({
  name: "bevox_meta_api_meta_webhook_processed_total",
  help: "Eventos individuais processados após HMAC ok, por outcome",
  labelNames: ["outcome"], // persisted | deduplicated | orphan
  registers: [registry],
});

// ---------------------------------------------------------------------------
// Token refresh
// ---------------------------------------------------------------------------

export const tokenRefreshTotal = new Counter({
  name: "bevox_meta_api_token_refresh_total",
  help: "Outcomes de refresh de tokens Meta",
  labelNames: ["channel", "outcome"], // channel=waba|ig, outcome=refreshed|failed|disconnected
  registers: [registry],
});

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

export const cleanupDeletedTotal = new Counter({
  name: "bevox_meta_api_cleanup_deleted_total",
  help: "Linhas deletadas pelo cleanup worker (por tabela)",
  labelNames: ["table"],
  registers: [registry],
});

// ---------------------------------------------------------------------------
// Workers (genérico por processo BullMQ)
// ---------------------------------------------------------------------------

/**
 * A17 fix (audit 2026-06-02): workers tsx rodavam SEM servidor HTTP exposto,
 * portanto métricas Prometheus ficavam fisicamente inaccessíveis. Mesmo
 * `cleanupDeletedTotal`, `tokenRefreshTotal`, `webhookDeliveryTotal` etc.
 * incrementavam in-memory mas nunca eram scrapeados → cego para SLO.
 *
 * Counter por worker/outcome alimentado por cada start*Worker(); o servidor
 * HTTP exposto por `startWorkerMetricsServer()` em workers/* expõe o
 * registry global no /metrics na porta WORKER_METRICS_PORT (default 9090),
 * permitindo scrape via ServiceMonitor `bevox-meta-api-workers`.
 */
export const workerJobsTotal = new Counter({
  name: "bevox_meta_api_worker_jobs_total",
  help: "Jobs processados por worker, rotulados por outcome",
  labelNames: ["worker", "outcome"], // outcome=ok | failed | skipped
  registers: [registry],
});

export async function renderMetrics(): Promise<{
  contentType: string;
  body: string;
}> {
  return {
    contentType: registry.contentType,
    body: await registry.metrics(),
  };
}

/**
 * APENAS para testes — limpa todos os contadores/histogramas.
 */
export function __resetMetricsForTests(): void {
  registry.resetMetrics();
}
