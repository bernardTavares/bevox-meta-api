import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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

const undiciState = vi.hoisted(() => ({
  request: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));

vi.mock("undici", () => ({
  request: (url: unknown, opts: unknown) => undiciState.request(url, opts),
}));

const subRepo = vi.hoisted(() => ({
  findSubscriptionById: vi.fn(),
  findOrCreateDelivery: vi.fn(),
  updateDeliveryAttempt: vi.fn(),
}));
vi.mock("@/modules/webhooks/repository.js", () => subRepo);

const inboundRepo = vi.hoisted(() => ({
  findInboundEventById: vi.fn(),
  insertInboundEvent: vi.fn(),
  listActiveSubscriptions: vi.fn(),
}));
vi.mock("@/modules/inbound/repository.js", () => inboundRepo);

const secret = vi.hoisted(() => ({
  resolveSubscriptionSecret: vi.fn(async () => "shared-secret-123"),
}));
vi.mock("@/modules/webhooks/secret-resolver.js", () => secret);

vi.mock("@/lib/redis.js", () => ({
  getRedis: () => ({
    get: async () => null,
    set: async () => "OK",
    getdel: async () => null,
    eval: async () => [1, 1000, 0],
    ping: async () => "PONG",
    quit: async () => "OK",
  }),
  closeRedis: async () => {},
  createBullMQConnection: () => ({ quit: async () => "OK" }),
}));

vi.mock("@/config/env.js", () => ({
  env: () => ({
    NODE_ENV: "test",
    LOG_LEVEL: "fatal",
    OTEL_SERVICE_NAME: "bevox-meta-api",
    WEBHOOK_DELIVERY_MAX_RETRIES: 8,
  }),
  __resetEnvCacheForTests: () => {},
}));

const { __resetLoggerForTests } = await import("@/lib/logger.js");
const { processWebhookDelivery, MAX_ATTEMPTS } = await import("@/workers/webhook-delivery.js");
const { uuidv7 } = await import("@/lib/uuid.js");
const { __resetMetricsForTests, webhookDeliveryTotal } = await import("@/lib/metrics.js");

/** Lê o valor atual do counter para um outcome (0 se ausente). */
async function counterValue(
  counter: typeof webhookDeliveryTotal,
  outcome: string,
): Promise<number> {
  const snapshot = await counter.get();
  const match = snapshot.values.find((v) => v.labels?.outcome === outcome);
  return match?.value ?? 0;
}

beforeAll(() => {
  for (const [k, v] of Object.entries(REQUIRED_ENV)) process.env[k] = v;
  __resetLoggerForTests();
});

const SUB_ID = "sub-1";
const EVENT_ID = "evt-1";

function fakeSub(overrides: Partial<any> = {}) {
  return {
    id: SUB_ID,
    appId: uuidv7(),
    tenantId: uuidv7(),
    url: "https://app.example.com/in",
    secretCiphertext: Buffer.from(""),
    secretDekCiphertext: Buffer.from(""),
    secretDekKeyId: "",
    secretEncryptionContext: {},
    secretAlgo: "AES-256-GCM-v1",
    secretNonce: Buffer.from(""),
    secretAuthTag: Buffer.from(""),
    eventTypesFilter: [],
    status: "active",
    createdAt: new Date(),
    ...overrides,
  };
}

function fakeEvent(overrides: Partial<any> = {}) {
  return {
    id: EVENT_ID,
    appId: uuidv7(),
    tenantId: uuidv7(),
    eventType: "message.received",
    metaEventId: "wamid.x",
    payloadJson: { messages: [{ id: "wamid.x", text: { body: "redacted" } }] },
    receivedAt: new Date("2024-01-01T00:00:00Z"),
    dispatchedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  __resetMetricsForTests();
  subRepo.findSubscriptionById.mockResolvedValue(fakeSub());
  inboundRepo.findInboundEventById.mockResolvedValue(fakeEvent());
  subRepo.findOrCreateDelivery.mockResolvedValue({
    id: "del-1",
    subscriptionId: SUB_ID,
    inboundEventId: EVENT_ID,
    status: "pending",
    attempts: 0,
    lastAttemptAt: null,
    lastResponseStatus: null,
    lastError: null,
    nextRetryAt: null,
    createdAt: new Date(),
  });
  subRepo.updateDeliveryAttempt.mockResolvedValue(null);
  undiciState.request.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe("processWebhookDelivery — happy path", () => {
  it("POSTa com HMAC e marca delivered em 2xx", async () => {
    undiciState.request.mockResolvedValueOnce({
      statusCode: 200,
      body: { dump: async () => undefined },
    });

    await processWebhookDelivery(
      { subscription_id: SUB_ID, inbound_event_id: EVENT_ID, event_type: "message.received" },
      0,
    );

    expect(undiciState.request).toHaveBeenCalledTimes(1);
    const [url, opts] = undiciState.request.mock.calls[0]! as [string, any];
    expect(url).toBe("https://app.example.com/in");
    expect(opts.headers["x-bevox-signature"]).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    // Body é JSON canônico
    const body = JSON.parse(opts.body);
    expect(body).toMatchObject({
      event_id: EVENT_ID,
      event_type: "message.received",
    });

    expect(subRepo.updateDeliveryAttempt).toHaveBeenCalledWith(
      "del-1",
      expect.objectContaining({ status: "delivered", attempts: 1, lastResponseStatus: 200 }),
    );
  });
});

describe("processWebhookDelivery — falhas e retry", () => {
  it("non-2xx → marca failed + re-throw para BullMQ retry", async () => {
    undiciState.request.mockResolvedValueOnce({
      statusCode: 503,
      body: { dump: async () => undefined },
    });

    await expect(
      processWebhookDelivery(
        { subscription_id: SUB_ID, inbound_event_id: EVENT_ID, event_type: "message.received" },
        0,
      ),
    ).rejects.toThrow(/HTTP 503/);

    expect(subRepo.updateDeliveryAttempt).toHaveBeenCalledWith(
      "del-1",
      expect.objectContaining({ status: "failed", lastResponseStatus: 503 }),
    );
  });

  it("timeout/network → marca failed + re-throw", async () => {
    undiciState.request.mockRejectedValueOnce(new Error("ECONNRESET"));

    await expect(
      processWebhookDelivery(
        { subscription_id: SUB_ID, inbound_event_id: EVENT_ID, event_type: "x" },
        0,
      ),
    ).rejects.toThrow();

    expect(subRepo.updateDeliveryAttempt).toHaveBeenCalledWith(
      "del-1",
      expect.objectContaining({
        status: "failed",
        lastResponseStatus: null,
        lastError: expect.stringContaining("ECONNRESET"),
      }),
    );
  });

  it(`após ${MAX_ATTEMPTS} tentativas → dead_letter (não re-throw)`, async () => {
    subRepo.findOrCreateDelivery.mockResolvedValueOnce({
      id: "del-1",
      subscriptionId: SUB_ID,
      inboundEventId: EVENT_ID,
      status: "failed",
      attempts: MAX_ATTEMPTS - 1,
      lastAttemptAt: null,
      lastResponseStatus: null,
      lastError: null,
      nextRetryAt: null,
      createdAt: new Date(),
    });
    undiciState.request.mockResolvedValueOnce({
      statusCode: 503,
      body: { dump: async () => undefined },
    });

    // Última tentativa: NÃO deve re-throw (terminal).
    await processWebhookDelivery(
      { subscription_id: SUB_ID, inbound_event_id: EVENT_ID, event_type: "x" },
      MAX_ATTEMPTS - 1,
    );

    expect(subRepo.updateDeliveryAttempt).toHaveBeenCalledWith(
      "del-1",
      expect.objectContaining({
        status: "dead_letter",
        attempts: MAX_ATTEMPTS,
      }),
    );
  });

  // C3 fix — MAX_ATTEMPTS deve casar com WEBHOOK_DELIVERY_MAX_RETRIES (8).
  // Antes do fix era hard-coded em 6, mas o produtor enfileirava com
  // attempts:5 (DEFAULT_JOB_OPTIONS), então BullMQ encerrava em 5 e o branch
  // dead_letter (>=6) nunca era alcançado.
  it("C3: MAX_ATTEMPTS é derivado de env.WEBHOOK_DELIVERY_MAX_RETRIES (default 8)", () => {
    expect(MAX_ATTEMPTS).toBe(8);
  });

  it("C3: dead_letter é marcado quando attemptsMade alcança MAX_ATTEMPTS, mesmo com delivery.attempts atrasado", async () => {
    // Cenário realista: BullMQ executou 8 vezes (job.attemptsMade=8),
    // mas a coluna `attempts` da delivery está atrasada por race condition.
    // Math.max(newAttempts, attemptsMade) garante terminal.
    subRepo.findOrCreateDelivery.mockResolvedValueOnce({
      id: "del-c3-aligned",
      subscriptionId: SUB_ID,
      inboundEventId: EVENT_ID,
      status: "failed",
      attempts: 3, // intencionalmente desalinhado
      lastAttemptAt: null,
      lastResponseStatus: null,
      lastError: null,
      nextRetryAt: null,
      createdAt: new Date(),
    });
    undiciState.request.mockResolvedValueOnce({
      statusCode: 504,
      body: { dump: async () => undefined },
    });

    await processWebhookDelivery(
      { subscription_id: SUB_ID, inbound_event_id: EVENT_ID, event_type: "x" },
      MAX_ATTEMPTS, // BullMQ passa attemptsMade=MAX_ATTEMPTS na última execução
    );

    expect(subRepo.updateDeliveryAttempt).toHaveBeenCalledWith(
      "del-c3-aligned",
      expect.objectContaining({
        status: "dead_letter",
        attempts: MAX_ATTEMPTS,
        nextRetryAt: null,
      }),
    );
  });
});

describe("processWebhookDelivery — early returns", () => {
  it("subscription inexistente → drop", async () => {
    subRepo.findSubscriptionById.mockResolvedValueOnce(null);
    await processWebhookDelivery(
      { subscription_id: SUB_ID, inbound_event_id: EVENT_ID, event_type: "x" },
      0,
    );
    expect(undiciState.request).not.toHaveBeenCalled();
  });

  it("subscription pausada → drop", async () => {
    subRepo.findSubscriptionById.mockResolvedValueOnce(fakeSub({ status: "paused" }));
    await processWebhookDelivery(
      { subscription_id: SUB_ID, inbound_event_id: EVENT_ID, event_type: "x" },
      0,
    );
    expect(undiciState.request).not.toHaveBeenCalled();
  });

  it("URL não-https → INVALID_INPUT (rejeitado, não enviado)", async () => {
    subRepo.findSubscriptionById.mockResolvedValueOnce(
      fakeSub({ url: "http://app.example.com/in" }),
    );
    await expect(
      processWebhookDelivery(
        { subscription_id: SUB_ID, inbound_event_id: EVENT_ID, event_type: "x" },
        0,
      ),
    ).rejects.toThrow(/https/);
    expect(undiciState.request).not.toHaveBeenCalled();
  });

  it("delivery já delivered → skip (idempotência)", async () => {
    subRepo.findOrCreateDelivery.mockResolvedValueOnce({
      id: "del-1",
      subscriptionId: SUB_ID,
      inboundEventId: EVENT_ID,
      status: "delivered",
      attempts: 1,
      lastAttemptAt: new Date(),
      lastResponseStatus: 200,
      lastError: null,
      nextRetryAt: null,
      createdAt: new Date(),
    });
    await processWebhookDelivery(
      { subscription_id: SUB_ID, inbound_event_id: EVENT_ID, event_type: "x" },
      0,
    );
    expect(undiciState.request).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// A6 fix (audit 2026-06-02): webhook_delivery_total contador existia mas
// nunca era incrementado — observabilidade cega para deliveries com
// dead_letter saturado.
// ---------------------------------------------------------------------------

describe("processWebhookDelivery — A6 metric emission", () => {
  it("delivery 2xx incrementa webhook_delivery_total{outcome=delivered}", async () => {
    undiciState.request.mockResolvedValueOnce({
      statusCode: 200,
      body: { dump: async () => undefined },
    });

    expect(await counterValue(webhookDeliveryTotal, "delivered")).toBe(0);
    await processWebhookDelivery(
      { subscription_id: SUB_ID, inbound_event_id: EVENT_ID, event_type: "message.received" },
      0,
    );
    expect(await counterValue(webhookDeliveryTotal, "delivered")).toBe(1);
    expect(await counterValue(webhookDeliveryTotal, "failed")).toBe(0);
    expect(await counterValue(webhookDeliveryTotal, "dead_letter")).toBe(0);
  });

  it("non-2xx (não terminal) incrementa outcome=failed (e re-throw)", async () => {
    undiciState.request.mockResolvedValueOnce({
      statusCode: 503,
      body: { dump: async () => undefined },
    });

    await expect(
      processWebhookDelivery(
        { subscription_id: SUB_ID, inbound_event_id: EVENT_ID, event_type: "x" },
        0,
      ),
    ).rejects.toThrow();

    expect(await counterValue(webhookDeliveryTotal, "failed")).toBe(1);
    expect(await counterValue(webhookDeliveryTotal, "dead_letter")).toBe(0);
    expect(await counterValue(webhookDeliveryTotal, "delivered")).toBe(0);
  });

  it("última tentativa esgotada incrementa outcome=dead_letter (terminal)", async () => {
    subRepo.findOrCreateDelivery.mockResolvedValueOnce({
      id: "del-1",
      subscriptionId: SUB_ID,
      inboundEventId: EVENT_ID,
      status: "failed",
      attempts: MAX_ATTEMPTS - 1,
      lastAttemptAt: null,
      lastResponseStatus: null,
      lastError: null,
      nextRetryAt: null,
      createdAt: new Date(),
    });
    undiciState.request.mockResolvedValueOnce({
      statusCode: 503,
      body: { dump: async () => undefined },
    });

    await processWebhookDelivery(
      { subscription_id: SUB_ID, inbound_event_id: EVENT_ID, event_type: "x" },
      MAX_ATTEMPTS - 1,
    );

    expect(await counterValue(webhookDeliveryTotal, "dead_letter")).toBe(1);
    expect(await counterValue(webhookDeliveryTotal, "failed")).toBe(0);
  });
});
