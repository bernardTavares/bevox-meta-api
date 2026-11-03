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
  META_APP_ID: "1234567890",
  META_APP_SECRET: "shh",
  OAUTH_CALLBACK_BASE_URL: "https://meta-api.bevox.test",
};

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

const wabasRepo = vi.hoisted(() => ({
  listExpiringWabaTokens: vi.fn(),
  replaceWabaToken: vi.fn(),
  markWabaDisconnected: vi.fn(),
  listWabasByTenant: vi.fn(),
  findWabaConnectionById: vi.fn(),
  disconnectWaba: vi.fn(),
  createWabaConnectionWithToken: vi.fn(),
  findWabaByTenantAndMetaId: vi.fn(),
  findWabaByMetaWabaId: vi.fn(),
  reconnectWaba: vi.fn(),
}));
vi.mock("@/modules/wabas/repository.js", () => wabasRepo);

const tokenResolver = vi.hoisted(() => ({
  resolveActiveWabaToken: vi.fn(async () => ({
    accessToken: "old-token-plaintext",
    expiresAt: new Date(Date.now() + 3600_000),
  })),
}));
vi.mock("@/modules/wabas/token-resolver.js", () => tokenResolver);

const eventBus = vi.hoisted(() => ({
  publishEvent: vi.fn(async () => undefined),
  createEventSubscriber: () => ({ subscribe: async () => 1, on: () => {}, quit: async () => "OK" }),
  closeEventBus: async () => {},
  __resetEventBusForTests: () => {},
}));
vi.mock("@/lib/event-bus.js", () => eventBus);

const fakeMeta = {
  exchangeCode: vi.fn(),
  exchangeLongLivedToken: vi.fn(),
  discoverWaba: vi.fn(),
  discoverIgAccount: vi.fn(),
  listPhoneNumbers: vi.fn(),
  updatePhoneNumberProfile: vi.fn(),
  createMessageTemplate: vi.fn(),
  getMessageTemplate: vi.fn(),
  deleteMessageTemplate: vi.fn(),
  sendWhatsAppMessage: vi.fn(),
  sendInstagramMessage: vi.fn(),
};
vi.mock("@/integration/meta-client.js", () => ({
  getMetaOAuthClient: () => fakeMeta,
  setMetaOAuthClientForTests: () => {},
  buildWabaRedirectUri: () => "https://meta-api.bevox.test/v1/oauth/waba/callback",
  buildIgRedirectUri: () => "https://meta-api.bevox.test/v1/oauth/ig/callback",
}));

beforeAll(() => {
  for (const [k, v] of Object.entries(REQUIRED_ENV)) process.env[k] = v;
});

const { __resetEnvCacheForTests } = await import("@/config/env.js");
const { __resetLoggerForTests } = await import("@/lib/logger.js");
const { __resetKmsClientForTests } = await import("@/integration/kms-client.js");
const { refreshOneToken, refreshDueTokens } = await import("@/workers/token-refresh.js");
const { uuidv7 } = await import("@/lib/uuid.js");
const { errors } = await import("@/lib/errors.js");

beforeEach(() => {
  __resetEnvCacheForTests();
  __resetLoggerForTests();
  __resetKmsClientForTests();
  fakeMeta.exchangeLongLivedToken.mockResolvedValue({
    access_token: "NEW-TOKEN",
    token_type: "bearer",
    expires_in: 60 * 24 * 3600,
  });
  wabasRepo.listExpiringWabaTokens.mockResolvedValue([]);
  wabasRepo.replaceWabaToken.mockImplementation(async (i: any) => ({
    id: uuidv7(),
    wabaConnectionId: i.wabaConnectionId,
  }));
  wabasRepo.markWabaDisconnected.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("refreshOneToken", () => {
  it("happy path: chama Meta + replaceWabaToken + status refreshed", async () => {
    const wabaId = uuidv7();
    const tokenId = uuidv7();
    const out = await refreshOneToken(
      {
        id: tokenId,
        wabaConnectionId: wabaId,
        encryptionContext: { tenant_id: "t1", waba_id: "w1", app_id: "a1", v: "1" },
      },
      { backoffBaseMs: 1 },
    );
    expect(out.status).toBe("refreshed");
    expect(fakeMeta.exchangeLongLivedToken).toHaveBeenCalledWith("old-token-plaintext");
    expect(wabasRepo.replaceWabaToken).toHaveBeenCalledTimes(1);
    const args = wabasRepo.replaceWabaToken.mock.calls[0]![0];
    expect(args.oldTokenId).toBe(tokenId);
    // Ciphertext é Buffer não-vazio + AAD herda contexto.
    expect(Buffer.isBuffer(args.envelope.ciphertext)).toBe(true);
    expect(args.envelope.encryptionContext).toMatchObject({ tenant_id: "t1", waba_id: "w1" });
  });

  it("META_REJECTED é terminal → disconnected após 1 tentativa", async () => {
    fakeMeta.exchangeLongLivedToken.mockRejectedValue(
      errors.metaRejected("token revoked", { meta_code: 190 }),
    );
    const out = await refreshOneToken(
      {
        id: uuidv7(),
        wabaConnectionId: uuidv7(),
        encryptionContext: { tenant_id: "t1", app_id: "a1" },
      },
      { backoffBaseMs: 1 },
    );
    expect(out.status).toBe("disconnected");
    expect(fakeMeta.exchangeLongLivedToken).toHaveBeenCalledTimes(1);
    expect(wabasRepo.markWabaDisconnected).toHaveBeenCalled();
    expect(eventBus.publishEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "waba.connection_changed",
        data: expect.objectContaining({ status: "disconnected" }),
      }),
    );
  });

  it("META_UNAVAILABLE é retryable → 3 tentativas e disconnected", async () => {
    fakeMeta.exchangeLongLivedToken.mockRejectedValue(errors.metaUnavailable(undefined, {}));
    const out = await refreshOneToken(
      {
        id: uuidv7(),
        wabaConnectionId: uuidv7(),
        encryptionContext: {},
      },
      { backoffBaseMs: 1 },
    );
    expect(out.status).toBe("disconnected");
    expect(fakeMeta.exchangeLongLivedToken).toHaveBeenCalledTimes(3);
  });

  it("retryable que recupera na 2ª tentativa → refreshed", async () => {
    fakeMeta.exchangeLongLivedToken
      .mockRejectedValueOnce(errors.metaUnavailable(undefined, {}))
      .mockResolvedValueOnce({
        access_token: "NEW-TOKEN-2",
        token_type: "bearer",
        expires_in: 3600,
      });
    const out = await refreshOneToken(
      {
        id: uuidv7(),
        wabaConnectionId: uuidv7(),
        encryptionContext: {},
      },
      { backoffBaseMs: 1 },
    );
    expect(out.status).toBe("refreshed");
    expect(fakeMeta.exchangeLongLivedToken).toHaveBeenCalledTimes(2);
    expect(wabasRepo.markWabaDisconnected).not.toHaveBeenCalled();
  });
});

describe("refreshDueTokens", () => {
  it("processa todos os tokens expirando", async () => {
    wabasRepo.listExpiringWabaTokens.mockResolvedValueOnce([
      {
        id: uuidv7(),
        wabaConnectionId: uuidv7(),
        encryptionContext: {},
        ciphertext: Buffer.from(""),
        dekCiphertext: Buffer.from(""),
        dekKeyId: "",
        algo: "AES-256-GCM-v1",
        nonce: Buffer.from(""),
        authTag: Buffer.from(""),
        expiresAt: new Date(),
        refreshAt: new Date(),
        createdAt: new Date(),
        supersededAt: null,
      },
      {
        id: uuidv7(),
        wabaConnectionId: uuidv7(),
        encryptionContext: {},
        ciphertext: Buffer.from(""),
        dekCiphertext: Buffer.from(""),
        dekKeyId: "",
        algo: "AES-256-GCM-v1",
        nonce: Buffer.from(""),
        authTag: Buffer.from(""),
        expiresAt: new Date(),
        refreshAt: new Date(),
        createdAt: new Date(),
        supersededAt: null,
      },
    ]);
    const results = await refreshDueTokens();
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.status === "refreshed")).toBe(true);
  });
});
