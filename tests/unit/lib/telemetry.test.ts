import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const REQUIRED_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  LOG_LEVEL: "fatal",
  DATABASE_URL: "postgresql://bevox:pwd@localhost:5432/test",
  REDIS_URL: "redis://localhost:6379",
  KMS_PROVIDER: "local",
  KMS_KEY_ID: "test-key",
  KMS_LOCAL_MASTER_KEY: Buffer.alloc(32, 0x42).toString("base64"),
  ADMIN_API_KEY: "test-admin-key-1234",
};

const sentryInit = vi.hoisted(() => vi.fn());
const sentryClose = vi.hoisted(() => vi.fn(async () => true));
const sentryCapture = vi.hoisted(() => vi.fn());
vi.mock("@sentry/node", () => ({
  init: sentryInit,
  close: sentryClose,
  captureException: sentryCapture,
}));

// Mocks do OTel SDK — usamos pra capturar a URL passada ao OTLPTraceExporter
// (fix A18 — antes da resolução, o código gerava `/v1/traces/v1/traces`
// duplicado em produção).
const otlpTraceExporterCtor = vi.hoisted(() => vi.fn());
const nodeSdkStart = vi.hoisted(() => vi.fn());
const nodeSdkShutdown = vi.hoisted(() => vi.fn(async () => {}));
const nodeSdkCtor = vi.hoisted(() => vi.fn());
vi.mock("@opentelemetry/sdk-node", () => {
  class NodeSDK {
    public start = nodeSdkStart;
    public shutdown = nodeSdkShutdown;
    constructor(cfg: unknown) {
      nodeSdkCtor(cfg);
    }
  }
  return { NodeSDK };
});
vi.mock("@opentelemetry/auto-instrumentations-node", () => ({
  getNodeAutoInstrumentations: vi.fn(() => []),
}));
vi.mock("@opentelemetry/exporter-trace-otlp-http", () => {
  class OTLPTraceExporter {
    constructor(cfg: { url?: string }) {
      otlpTraceExporterCtor(cfg);
    }
    export = vi.fn();
    shutdown = vi.fn();
  }
  return { OTLPTraceExporter };
});
vi.mock("@opentelemetry/resources", () => ({
  resourceFromAttributes: vi.fn((attrs: unknown) => ({ attributes: attrs })),
}));
vi.mock("@opentelemetry/semantic-conventions", () => ({
  ATTR_SERVICE_NAME: "service.name",
}));

beforeAll(() => {
  for (const [k, v] of Object.entries(REQUIRED_ENV)) process.env[k] = v;
});

const { __resetEnvCacheForTests } = await import("@/config/env.js");
const { __resetLoggerForTests } = await import("@/lib/logger.js");
const {
  initTelemetry,
  captureException,
  shutdownTelemetry,
  resolveOtlpTracesUrl,
  __resetTelemetryForTests,
} = await import("@/lib/telemetry.js");

beforeEach(() => {
  delete process.env.SENTRY_DSN;
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  __resetEnvCacheForTests();
  __resetLoggerForTests();
  __resetTelemetryForTests();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("initTelemetry", () => {
  it("sem SENTRY_DSN nem OTEL endpoint → no-op silencioso", async () => {
    await initTelemetry();
    expect(sentryInit).not.toHaveBeenCalled();
  });

  it("com SENTRY_DSN → inicializa Sentry", async () => {
    process.env.SENTRY_DSN = "https://abc@sentry.io/1";
    __resetEnvCacheForTests();
    await initTelemetry();
    expect(sentryInit).toHaveBeenCalledTimes(1);
    expect(sentryInit).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: "https://abc@sentry.io/1",
        environment: "test",
      }),
    );
  });

  it("idempotente — segunda chamada é no-op", async () => {
    process.env.SENTRY_DSN = "https://abc@sentry.io/1";
    __resetEnvCacheForTests();
    await initTelemetry();
    await initTelemetry();
    expect(sentryInit).toHaveBeenCalledTimes(1);
  });
});

describe("captureException", () => {
  it("sem SENTRY_DSN → no-op", () => {
    captureException(new Error("x"));
    expect(sentryCapture).not.toHaveBeenCalled();
  });

  it("com SENTRY_DSN → captura via Sentry", () => {
    process.env.SENTRY_DSN = "https://abc@sentry.io/1";
    __resetEnvCacheForTests();
    const err = new Error("boom");
    captureException(err, { request_id: "req-1" });
    expect(sentryCapture).toHaveBeenCalledWith(err, { extra: { request_id: "req-1" } });
  });
});

describe("shutdownTelemetry", () => {
  it("fecha Sentry quando ativo", async () => {
    process.env.SENTRY_DSN = "https://abc@sentry.io/1";
    __resetEnvCacheForTests();
    await shutdownTelemetry();
    expect(sentryClose).toHaveBeenCalledWith(2000);
  });
});

// ---------------------------------------------------------------------------
// Fix A18 (audit 2026-06-02): URL OTLP/HTTP de traces nunca pode duplicar
// `/v1/traces`. Antes do fix, o código sempre acrescentava `/v1/traces` ao
// endpoint configurado — quando operador colocava o sufixo no env (cópia
// de exemplos do plano go-live e dos docs Meta/Tempo), virava
// `/v1/traces/v1/traces` (404 silencioso → 100% traces perdidos em prod).
// ---------------------------------------------------------------------------
describe("resolveOtlpTracesUrl (fix A18)", () => {
  it("endpoint base (sem path) → acrescenta /v1/traces", () => {
    expect(resolveOtlpTracesUrl("http://otel-collector:4318")).toBe(
      "http://otel-collector:4318/v1/traces",
    );
  });

  it("endpoint com trailing slash → strip + acrescenta /v1/traces", () => {
    expect(resolveOtlpTracesUrl("http://otel-collector:4318/")).toBe(
      "http://otel-collector:4318/v1/traces",
    );
  });

  it("endpoint múltiplas trailing slashes → strip + acrescenta /v1/traces", () => {
    expect(resolveOtlpTracesUrl("http://otel-collector:4318///")).toBe(
      "http://otel-collector:4318/v1/traces",
    );
  });

  it("endpoint já termina em /v1/traces → NÃO duplica (fix A18 core)", () => {
    expect(resolveOtlpTracesUrl("http://otel-collector:4318/v1/traces")).toBe(
      "http://otel-collector:4318/v1/traces",
    );
  });

  it("endpoint termina em /v1/traces/ (trailing slash + path) → strip e mantém", () => {
    expect(resolveOtlpTracesUrl("http://otel-collector:4318/v1/traces/")).toBe(
      "http://otel-collector:4318/v1/traces",
    );
  });

  it("FQDN k8s service in-cluster (forma canônica do plano go-live)", () => {
    expect(resolveOtlpTracesUrl("http://otel-collector.monitoring.svc.cluster.local:4318")).toBe(
      "http://otel-collector.monitoring.svc.cluster.local:4318/v1/traces",
    );
  });

  it("endpoint HTTPS com path completo → mantém (cobre exemplo do plano antigo)", () => {
    expect(
      resolveOtlpTracesUrl("https://tempo.observability.svc.cluster.local:4318/v1/traces"),
    ).toBe("https://tempo.observability.svc.cluster.local:4318/v1/traces");
  });
});

describe("initTelemetry — OTLP exporter URL (fix A18)", () => {
  it("OTEL_EXPORTER_OTLP_ENDPOINT sem /v1/traces → exporter recebe URL completa", async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://otel-collector:4318";
    __resetEnvCacheForTests();
    await initTelemetry();
    expect(otlpTraceExporterCtor).toHaveBeenCalledTimes(1);
    expect(otlpTraceExporterCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "http://otel-collector:4318/v1/traces",
      }),
    );
    expect(nodeSdkStart).toHaveBeenCalledTimes(1);
  });

  it("OTEL_EXPORTER_OTLP_ENDPOINT JÁ com /v1/traces → exporter NÃO recebe URL duplicada", async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT =
      "http://otel-collector.monitoring.svc.cluster.local:4318/v1/traces";
    __resetEnvCacheForTests();
    await initTelemetry();
    expect(otlpTraceExporterCtor).toHaveBeenCalledTimes(1);
    const call = otlpTraceExporterCtor.mock.calls[0]![0] as { url: string };
    expect(call.url).toBe("http://otel-collector.monitoring.svc.cluster.local:4318/v1/traces");
    // O bug original geraria isso:
    expect(call.url).not.toContain("/v1/traces/v1/traces");
  });

  it("sem OTEL_EXPORTER_OTLP_ENDPOINT → exporter nunca instanciado (no-op)", async () => {
    await initTelemetry();
    expect(otlpTraceExporterCtor).not.toHaveBeenCalled();
    expect(nodeSdkStart).not.toHaveBeenCalled();
  });
});
