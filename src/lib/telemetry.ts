/**
 * OpenTelemetry + Sentry — observabilidade (PRD §13, ADR MA-007).
 *
 * Inicialização CONDICIONAL:
 *   - OTEL_EXPORTER_OTLP_ENDPOINT setado → SDK ativa com auto-instrumentation
 *     (fastify, pg, ioredis, undici/fetch) + exporter OTLP/HTTP.
 *   - SENTRY_DSN setado → Sentry captura unhandledException + Promise rejection.
 *
 * Sem essas envs: no-op silencioso (dev/test).
 *
 * IMPORTANTE: chamar `initTelemetry()` ANTES de qualquer outro import de
 * módulo da app, idealmente em src/index.ts top of file. Auto-instrumentation
 * monkey-patcha módulos via require/import hook.
 */

import * as Sentry from "@sentry/node";

import { env } from "@/config/env.js";
import { logger } from "@/lib/logger.js";
import { redactStringSecrets } from "@/lib/redact.js";

let started = false;

/**
 * Resolve a URL final do OTLP/HTTP traces exporter a partir do valor de
 * `OTEL_EXPORTER_OTLP_ENDPOINT`. A convenção OTLP/HTTP é que o endpoint base
 * é a raiz do collector (ex.: `http://otel-collector:4318`) e o SDK acrescenta
 * `/v1/traces`. Mas operadores frequentemente colocam o path completo na env
 * (copia-cola de exemplos da Meta/Tempo/Jaeger). Aceitamos as duas formas —
 * fix A18 (audit 2026-06-02): sem isso, valor com `/v1/traces` virava
 * `/v1/traces/v1/traces`, silenciando todos os traces em produção.
 *
 * Exportada (não-default) para test direto.
 */
export function resolveOtlpTracesUrl(endpoint: string): string {
  // Drop trailing slashes.
  const base = endpoint.replace(/\/+$/, "");
  // Se já termina em /v1/traces, não acrescentar de novo.
  if (base.endsWith("/v1/traces")) {
    return base;
  }
  return `${base}/v1/traces`;
}

export async function initTelemetry(): Promise<void> {
  if (started) return;
  started = true;

  const cfg = env();

  // ---- Sentry ----
  if (cfg.SENTRY_DSN) {
    Sentry.init({
      dsn: cfg.SENTRY_DSN,
      environment: cfg.NODE_ENV,
      // PII: scrubbed pelo logger.redact() na app; Sentry default já remove
      // headers Authorization/Cookie. Não enviar request body.
      maxBreadcrumbs: 50,
      sendDefaultPii: false,
      // A2 fix (audit 2026-06-02): `beforeSend` passa stack/message/values
      // de exception por `redactStringSecrets` antes do envio — cobre o
      // caso de token concatenado a Error.message ou aparecendo na stack
      // de libs externas. Mantém shape Sentry intacto; só rewrites strings
      // que casem shapes JWT (`eyJ…`)/Meta long-lived (`EAA…`)/Bearer.
      beforeSend: scrubSentryEvent,
    });
    logger().info({ env: cfg.NODE_ENV }, "Sentry initialized");
  }

  // ---- OpenTelemetry ----
  if (cfg.OTEL_EXPORTER_OTLP_ENDPOINT) {
    // Imports dinâmicos para que projetos sem OTel ativo não paguem o custo.
    const [
      { NodeSDK },
      { getNodeAutoInstrumentations },
      { OTLPTraceExporter },
      { resourceFromAttributes },
    ] = await Promise.all([
      import("@opentelemetry/sdk-node"),
      import("@opentelemetry/auto-instrumentations-node"),
      import("@opentelemetry/exporter-trace-otlp-http"),
      import("@opentelemetry/resources"),
    ]);
    const semconv = await import("@opentelemetry/semantic-conventions");

    const sdk = new NodeSDK({
      resource: resourceFromAttributes({
        [semconv.ATTR_SERVICE_NAME]: cfg.OTEL_SERVICE_NAME,
        ["service.namespace"]: "bevox",
        ["deployment.environment"]: cfg.NODE_ENV,
      }),
      traceExporter: new OTLPTraceExporter({
        url: resolveOtlpTracesUrl(cfg.OTEL_EXPORTER_OTLP_ENDPOINT),
      }),
      instrumentations: [
        getNodeAutoInstrumentations({
          // Fastify, http, pg, ioredis, undici são auto. Deixar tudo on é
          // razoável em V1; refinar quando virmos volume.
          "@opentelemetry/instrumentation-fs": { enabled: false },
        }),
      ],
    });

    sdk.start();
    logger().info(
      {
        endpoint: cfg.OTEL_EXPORTER_OTLP_ENDPOINT,
        traces_url: resolveOtlpTracesUrl(cfg.OTEL_EXPORTER_OTLP_ENDPOINT),
        service: cfg.OTEL_SERVICE_NAME,
      },
      "OpenTelemetry SDK started",
    );

    // Shutdown hook é registrado pelo caller (src/index.ts) via
    // shutdownTelemetry() exportado abaixo.
    cachedSdk = sdk;
  }
}

let cachedSdk: { shutdown: () => Promise<void> } | null = null;

export async function shutdownTelemetry(): Promise<void> {
  if (cachedSdk) {
    try {
      await cachedSdk.shutdown();
    } catch {
      // best-effort
    }
    cachedSdk = null;
  }
  if (env().SENTRY_DSN) {
    await Sentry.close(2000);
  }
}

/**
 * Captura exceção via Sentry (no-op se SENTRY_DSN não configurado).
 */
export function captureException(err: unknown, context?: Record<string, unknown>): void {
  if (!env().SENTRY_DSN) return;
  Sentry.captureException(err, { extra: context });
}

/**
 * APENAS para testes — reseta o flag `started` para que initTelemetry possa
 * rodar de novo em outro test.
 */
export function __resetTelemetryForTests(): void {
  started = false;
  cachedSdk = null;
}

/**
 * A2 fix (audit 2026-06-02): Sentry `beforeSend` que scrubs shapes de token
 * (JWT `eyJ…`, Meta `EAA…`, Bearer) em `event.exception` / `event.message` /
 * `event.breadcrumbs[*].message`. Sem isso, libs externas que interpolam
 * tokens em mensagens de erro mandam segredo cru ao Sentry. Exported só
 * para teste; passado como callback no `Sentry.init`.
 *
 * Tipado como `(event: any) => typeof event` para encaixar tanto no contract
 * do Sentry (`(ErrorEvent) => ErrorEvent | null`) quanto em testes que
 * passam `Record<string, unknown>`. Mutação in-place; sempre retorna o
 * mesmo objeto.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function scrubSentryEvent<T extends Record<string, any>>(event: T): T {
  const ev = event as unknown as {
    message?: unknown;
    exception?: {
      values?: Array<{
        value?: unknown;
        stacktrace?: { frames?: Array<{ pre_context?: unknown[]; context_line?: unknown }> };
      }>;
    };
    breadcrumbs?: Array<{ message?: unknown }>;
  };

  if (typeof ev.message === "string") {
    ev.message = redactStringSecrets(ev.message);
  }

  if (ev.exception?.values) {
    for (const v of ev.exception.values) {
      if (typeof v.value === "string") {
        v.value = redactStringSecrets(v.value);
      }
      // Frames podem ter `context_line` (linha de código) com token inline.
      const frames = v.stacktrace?.frames;
      if (Array.isArray(frames)) {
        for (const f of frames) {
          if (typeof f.context_line === "string") {
            f.context_line = redactStringSecrets(f.context_line);
          }
        }
      }
    }
  }

  if (Array.isArray(ev.breadcrumbs)) {
    for (const b of ev.breadcrumbs) {
      if (typeof b.message === "string") {
        b.message = redactStringSecrets(b.message);
      }
    }
  }

  return event;
}
