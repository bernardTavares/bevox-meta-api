import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { buildServer } from "@/bootstrap/server.js";
import { __resetEnvCacheForTests } from "@/config/env.js";
import { __resetKmsClientForTests } from "@/integration/kms-client.js";
import { setMetaOAuthClientForTests } from "@/integration/meta-client.js";
import { __resetLoggerForTests } from "@/lib/logger.js";
import { uuidv7 } from "@/lib/uuid.js";

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
  META_APP_SECRET: "shhh",
  OAUTH_CALLBACK_BASE_URL: "https://meta-api.bevox.test",
  META_WEBHOOK_VERIFY_TOKEN: "verify-tok-123",
};

// ---------------------------------------------------------------------------
// Redis (precisa de set/get/getdel/eval)
// ---------------------------------------------------------------------------

const redisState = vi.hoisted(() => ({
  kv: new Map<string, { value: string; expiresAt: number }>(),
  rl: new Map<string, { tokens: number; ts: number; expiresAt: number }>(),
}));

vi.mock("@/lib/redis.js", () => {
  const get = vi.fn(async (key: string) => {
    const e = redisState.kv.get(key);
    if (!e || e.expiresAt < Date.now()) {
      redisState.kv.delete(key);
      return null;
    }
    return e.value;
  });
  const set = vi.fn(async (key: string, value: string, _mode: string, ttl: number) => {
    redisState.kv.set(key, { value, expiresAt: Date.now() + ttl * 1000 });
    return "OK";
  });
  const getdel = vi.fn(async (key: string) => {
    const e = redisState.kv.get(key);
    if (!e || e.expiresAt < Date.now()) {
      redisState.kv.delete(key);
      return null;
    }
    redisState.kv.delete(key);
    return e.value;
  });
  const evalFn = vi.fn(async () => [1, 1000, 0]);
  const fake = { get, set, getdel, eval: evalFn, ping: async () => "PONG", quit: async () => "OK" };
  return {
    getRedis: () => fake,
    closeRedis: async () => {
      // no-op
    },
    createBullMQConnection: () => fake,
  };
});

// ---------------------------------------------------------------------------
// Tenants + WABA repositories
// ---------------------------------------------------------------------------

const APP_ID = uuidv7();
const TENANT_ID = uuidv7();

const tenantState = vi.hoisted(() => ({
  findById: vi.fn(),
}));

vi.mock("@/modules/tenants/repository.js", () => ({
  findTenantById: tenantState.findById,
  insertTenant: vi.fn(),
  findTenantByExternalId: vi.fn(),
  listTenants: vi.fn(),
  updateTenant: vi.fn(),
  softDeleteTenant: vi.fn(),
  countActiveBindings: vi.fn(),
}));

const wabaRepo = vi.hoisted(() => ({
  createWabaConnectionWithToken: vi.fn(),
  findWabaByTenantAndMetaId: vi.fn(),
  reconnectWaba: vi.fn(),
}));

vi.mock("@/modules/wabas/repository.js", () => ({
  createWabaConnectionWithToken: wabaRepo.createWabaConnectionWithToken,
  findWabaByTenantAndMetaId: wabaRepo.findWabaByTenantAndMetaId,
  reconnectWaba: wabaRepo.reconnectWaba,
}));

// Apps repo (auth pass-through, mas callback é unauthenticated então não usa)
vi.mock("@/modules/apps/repository.js", () => ({
  findConsumerAppById: vi.fn(),
  findActiveAppKey: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let app: Awaited<ReturnType<typeof buildServer>>;

const fakeMetaClient = {
  exchangeCode: vi.fn(),
  exchangeLongLivedToken: vi.fn(),
  discoverWaba: vi.fn(),
  subscribeWabaApp: vi.fn(),
  discoverIgAccount: vi.fn(),
  listPhoneNumbers: vi.fn(),
  updatePhoneNumberProfile: vi.fn(),
  createMessageTemplate: vi.fn(),
  getMessageTemplate: vi.fn(),
  deleteMessageTemplate: vi.fn(),
  sendWhatsAppMessage: vi.fn(),
  sendInstagramMessage: vi.fn(),
  getMediaMetadata: vi.fn(),
  downloadMedia: vi.fn(),
  getPhoneCoexInfo: vi.fn(),
  triggerSmbAppDataSync: vi.fn(),
};

beforeAll(async () => {
  for (const [k, v] of Object.entries(REQUIRED_ENV)) process.env[k] = v;
  __resetEnvCacheForTests();
  __resetLoggerForTests();
  __resetKmsClientForTests();
  setMetaOAuthClientForTests(fakeMetaClient);

  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  setMetaOAuthClientForTests(null);
});

beforeEach(() => {
  redisState.kv.clear();
  redisState.rl.clear();

  tenantState.findById.mockImplementation(async (appId: string, id: string) => {
    if (appId !== APP_ID || id !== TENANT_ID) return null;
    return {
      id: TENANT_ID,
      appId: APP_ID,
      externalId: null,
      displayName: "Acme",
      metadataJson: {},
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    };
  });

  wabaRepo.findWabaByTenantAndMetaId.mockResolvedValue(null);
  wabaRepo.createWabaConnectionWithToken.mockImplementation(async (input: any) => ({
    connection: {
      id: uuidv7(),
      tenantId: input.tenantId,
      appId: input.appId,
      metaBusinessId: input.metaBusinessId,
      metaWabaId: input.metaWabaId,
      displayName: input.displayName,
      verifiedStatus: input.verifiedStatus,
      createdAt: new Date(),
      updatedAt: new Date(),
      disconnectedAt: null,
    },
    token: { id: uuidv7() },
  }));
  wabaRepo.reconnectWaba.mockImplementation(async (id: string) => ({
    connection: { id },
    token: { id: uuidv7() },
  }));

  fakeMetaClient.exchangeCode.mockResolvedValue({
    access_token: "EAA-meta-fake",
    token_type: "bearer",
    expires_in: 60 * 60,
  });
  fakeMetaClient.discoverWaba.mockResolvedValue({
    meta_business_id: "biz-1",
    meta_waba_id: "waba-1",
    display_name: "Acme WhatsApp",
    verified_status: "VERIFIED",
  });
  fakeMetaClient.subscribeWabaApp.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

async function seedState(state: string, override: Partial<Record<string, unknown>> = {}) {
  const payload = {
    app_id: APP_ID,
    tenant_id: TENANT_ID,
    channel: "waba",
    redirect_url: "https://app.example.com/post-oauth",
    created_at: Date.now(),
    ...override,
  };
  redisState.kv.set(`oauth:state:${state}`, {
    value: JSON.stringify(payload),
    expiresAt: Date.now() + 600_000,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /v1/oauth/waba/callback", () => {
  it("happy path: troca code, cifra, persiste, redireciona com waba_id", async () => {
    const state = uuidv7();
    await seedState(state);

    const res = await app.inject({
      method: "GET",
      url: `/v1/oauth/waba/callback?code=fb-code&state=${state}`,
    });

    expect(res.statusCode).toBe(302);
    const loc = res.headers.location as string;
    expect(loc).toContain("https://app.example.com/post-oauth");
    expect(loc).toContain("success=true");
    expect(loc).toContain("waba_id=waba-1");

    expect(fakeMetaClient.exchangeCode).toHaveBeenCalledWith(
      "fb-code",
      "https://meta-api.bevox.test/v1/oauth/waba/callback",
    );
    expect(wabaRepo.createWabaConnectionWithToken).toHaveBeenCalledTimes(1);
    const insertArgs = wabaRepo.createWabaConnectionWithToken.mock.calls[0]![0];
    expect(insertArgs.metaWabaId).toBe("waba-1");
    // Token NUNCA persiste plaintext: ciphertext é Buffer não-vazio.
    expect(Buffer.isBuffer(insertArgs.envelope.ciphertext)).toBe(true);
    expect(insertArgs.envelope.ciphertext.length).toBeGreaterThan(0);
    expect(insertArgs.envelope.algo).toBe("AES-256-GCM-v1");
    // AAD inclui tenant + waba ids (anti-swap)
    expect(insertArgs.envelope.encryptionContext).toMatchObject({
      tenant_id: TENANT_ID,
      waba_id: "waba-1",
      app_id: APP_ID,
    });

    // Registra o webhook por-WABA (override) apontando pro meta-api.
    expect(fakeMetaClient.subscribeWabaApp).toHaveBeenCalledWith("waba-1", "EAA-meta-fake", {
      callbackUri: "https://meta-api.bevox.test/webhooks/meta",
      verifyToken: "verify-tok-123",
    });

    // State foi consumido (anti-replay).
    expect(redisState.kv.has(`oauth:state:${state}`)).toBe(false);
  });

  it("state inválido/expirado → 401", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/oauth/waba/callback?code=x&state=does-not-exist",
    });
    expect(res.statusCode).toBe(401);
  });

  it("state já consumido (replay) → 401 na 2ª tentativa", async () => {
    const state = uuidv7();
    await seedState(state);

    const r1 = await app.inject({
      method: "GET",
      url: `/v1/oauth/waba/callback?code=c1&state=${state}`,
    });
    expect(r1.statusCode).toBe(302);

    const r2 = await app.inject({
      method: "GET",
      url: `/v1/oauth/waba/callback?code=c2&state=${state}`,
    });
    expect(r2.statusCode).toBe(401);
  });

  it("usuário cancelou (error= no query) → redireciona com success=false", async () => {
    const state = uuidv7();
    await seedState(state);

    const res = await app.inject({
      method: "GET",
      url: `/v1/oauth/waba/callback?state=${state}&error=access_denied&error_description=user_cancelled`,
    });
    expect(res.statusCode).toBe(302);
    const loc = res.headers.location as string;
    expect(loc).toContain("success=false");
    expect(loc).toContain("error=access_denied");
    // Não tentou Meta
    expect(fakeMetaClient.exchangeCode).not.toHaveBeenCalled();
  });

  it("reconexão: WABA já existe → reconnectWaba e flag reconnected=true", async () => {
    const state = uuidv7();
    await seedState(state);
    const existingId = uuidv7();
    wabaRepo.findWabaByTenantAndMetaId.mockResolvedValueOnce({
      id: existingId,
      tenantId: TENANT_ID,
      appId: APP_ID,
      metaWabaId: "waba-1",
    });

    const res = await app.inject({
      method: "GET",
      url: `/v1/oauth/waba/callback?code=c&state=${state}`,
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location as string).toContain("reconnected=true");
    expect(wabaRepo.reconnectWaba).toHaveBeenCalledTimes(1);
    expect(wabaRepo.createWabaConnectionWithToken).not.toHaveBeenCalled();
  });

  it("Meta exchangeCode falha → propaga META_REJECTED", async () => {
    const state = uuidv7();
    await seedState(state);
    fakeMetaClient.exchangeCode.mockRejectedValueOnce(new Error("meta down"));

    const res = await app.inject({
      method: "GET",
      url: `/v1/oauth/waba/callback?code=c&state=${state}`,
    });
    // State já foi consumido pelo takeOAuthState antes do erro — não há replay.
    expect(res.statusCode).toBeGreaterThanOrEqual(500);
  });

  it("tenant deletado entre init e callback → 409", async () => {
    const state = uuidv7();
    await seedState(state);
    tenantState.findById.mockResolvedValueOnce({
      id: TENANT_ID,
      appId: APP_ID,
      status: "active",
      deletedAt: new Date(),
    });

    const res = await app.inject({
      method: "GET",
      url: `/v1/oauth/waba/callback?code=c&state=${state}`,
    });
    expect(res.statusCode).toBe(409);
  });

  it("payload com channel != waba é rejeitado", async () => {
    const state = uuidv7();
    await seedState(state, { channel: "ig" });

    const res = await app.inject({
      method: "GET",
      url: `/v1/oauth/waba/callback?code=c&state=${state}`,
    });
    expect(res.statusCode).toBe(400);
  });

  it("registro de webhook (subscribed_apps) falha → propaga e NÃO persiste", async () => {
    const state = uuidv7();
    await seedState(state);
    fakeMetaClient.subscribeWabaApp.mockRejectedValueOnce(new Error("meta down"));

    const res = await app.inject({
      method: "GET",
      url: `/v1/oauth/waba/callback?code=c&state=${state}`,
    });

    expect(res.statusCode).toBeGreaterThanOrEqual(500);
    // Subscribe acontece ANTES de persistir → nenhuma conexão meia-onboarded.
    expect(wabaRepo.createWabaConnectionWithToken).not.toHaveBeenCalled();
  });
});
