import { generateKeyPairSync } from "node:crypto";

import { SignJWT, importPKCS8 } from "jose";
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
  META_WEBHOOK_VERIFY_TOKEN: "verify-tok-123",
  OAUTH_CALLBACK_BASE_URL: "https://meta-api.bevox.test",
};

const redisState = vi.hoisted(() => ({
  kv: new Map<string, { value: string; expiresAt: number }>(),
  rl: new Map<string, { tokens: number; ts: number; expiresAt: number }>(),
}));

vi.mock("@/lib/redis.js", () => {
  const get = vi.fn(async (key: string) => {
    const e = redisState.kv.get(key);
    if (!e || e.expiresAt < Date.now()) return null;
    return e.value;
  });
  const set = vi.fn(async (key: string, value: string, _m: string, ttl: number) => {
    redisState.kv.set(key, { value, expiresAt: Date.now() + ttl * 1000 });
    return "OK";
  });
  const getdel = vi.fn(async (key: string) => {
    const e = redisState.kv.get(key);
    redisState.kv.delete(key);
    return e ? e.value : null;
  });
  const evalFn = vi.fn(async () => [1, 1000, 0]);
  const fake = { get, set, getdel, eval: evalFn, ping: async () => "PONG", quit: async () => "OK" };
  return { getRedis: () => fake, closeRedis: async () => {}, createBullMQConnection: () => fake };
});

const APP_ID = uuidv7();
const KEY_ID = uuidv7();
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_PKCS8 = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const PUBLIC_SPKI = publicKey.export({ type: "spki", format: "pem" }).toString();

vi.mock("@/modules/apps/repository.js", () => ({
  findConsumerAppById: vi.fn(async (id: string) => ({
    id,
    name: "test",
    description: null,
    status: "active" as const,
    currentPublicKeyPem: null,
    currentPublicKeyId: null,
    metadataJson: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  })),
  findActiveAppKey: vi.fn(async (appId: string, keyId: string) => ({
    id: keyId,
    appId,
    publicKeyPem: PUBLIC_SPKI,
    algo: "RS256" as const,
    validFrom: new Date(Date.now() - 60_000),
    validUntil: null,
    rotatedAt: null,
    createdAt: new Date(),
  })),
}));

const idem = vi.hoisted(() => {
  const store = new Map<string, unknown>();
  return {
    store,
    find: vi.fn(async (a: string, k: string) => store.get(`${a}:${k}`) ?? null),
    save: vi.fn(async (input: any) => {
      const k = `${input.appId}:${input.key}`;
      if (!store.has(k)) store.set(k, input);
    }),
  };
});
vi.mock("@/modules/idempotency/repository.js", () => ({
  findIdempotencyRecord: idem.find,
  saveIdempotencyRecord: idem.save,
}));

const tenantState = vi.hoisted(() => ({ findById: vi.fn() }));
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
  findWabaConnectionById: vi.fn(),
}));
vi.mock("@/modules/wabas/repository.js", () => ({
  createWabaConnectionWithToken: wabaRepo.createWabaConnectionWithToken,
  findWabaByTenantAndMetaId: wabaRepo.findWabaByTenantAndMetaId,
  reconnectWaba: wabaRepo.reconnectWaba,
  findWabaConnectionById: wabaRepo.findWabaConnectionById,
  disconnectWaba: vi.fn(),
  listWabasByTenant: vi.fn(),
}));

const fakeMeta = {
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

let app: Awaited<ReturnType<typeof buildServer>>;
let signingKey: Awaited<ReturnType<typeof importPKCS8>>;
const TENANT_ID = uuidv7();

async function token(scope: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ scope })
    .setProtectedHeader({ alg: "RS256", kid: KEY_ID })
    .setIssuer(APP_ID)
    .setAudience("bevox-meta-api")
    .setIssuedAt(now)
    .setExpirationTime(now + 60)
    .sign(signingKey);
}

beforeAll(async () => {
  for (const [k, v] of Object.entries(REQUIRED_ENV)) process.env[k] = v;
  __resetEnvCacheForTests();
  __resetLoggerForTests();
  __resetKmsClientForTests();
  setMetaOAuthClientForTests(fakeMeta);
  signingKey = await importPKCS8(PRIVATE_PKCS8, "RS256");
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
  idem.store.clear();
  tenantState.findById.mockImplementation(async (appId: string, id: string) =>
    appId === APP_ID && id === TENANT_ID
      ? { id: TENANT_ID, appId: APP_ID, status: "active", deletedAt: null }
      : null,
  );
  fakeMeta.exchangeCode.mockResolvedValue({
    access_token: "EAA-es",
    token_type: "bearer",
    expires_in: 3600,
  });
  fakeMeta.discoverWaba.mockResolvedValue({
    meta_business_id: "biz-1",
    meta_waba_id: "waba-1",
    display_name: "Acme WA",
    verified_status: "VERIFIED",
  });
  fakeMeta.subscribeWabaApp.mockResolvedValue(undefined);
  wabaRepo.findWabaByTenantAndMetaId.mockResolvedValue(null);
  wabaRepo.createWabaConnectionWithToken.mockImplementation(async (input: any) => ({
    connection: { id: uuidv7(), ...input },
    token: { id: uuidv7() },
  }));
  wabaRepo.findWabaConnectionById.mockImplementation(
    async (_a: string, _t: string, id: string) => ({
      id,
      tenantId: TENANT_ID,
      metaBusinessId: "biz-1",
      metaWabaId: "waba-1",
      displayName: "Acme WA",
      verifiedStatus: "VERIFIED",
      createdAt: new Date(),
      updatedAt: new Date(),
      disconnectedAt: null,
    }),
  );
});

afterEach(() => vi.clearAllMocks());

const URL_BASE = `/v1/tenants/${TENANT_ID}/wabas/connect/complete`;

describe("POST .../wabas/connect/complete", () => {
  it("happy path: troca code (sem redirect_uri), descobre, subscribe, persiste, 200", async () => {
    const t = await token("wabas:write");
    const res = await app.inject({
      method: "POST",
      url: URL_BASE,
      headers: { authorization: `Bearer ${t}`, "idempotency-key": "es-1" },
      payload: { code: "es-code", waba_id: "waba-1", phone_number_id: "phone-1" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().meta_waba_id).toBe("waba-1");
    expect(fakeMeta.exchangeCode).toHaveBeenCalledWith("es-code");
    expect(fakeMeta.discoverWaba).toHaveBeenCalledTimes(1);
    expect(fakeMeta.subscribeWabaApp).toHaveBeenCalledWith("waba-1", "EAA-es", {
      callbackUri: "https://meta-api.bevox.test/webhooks/meta",
      verifyToken: "verify-tok-123",
    });
    const insert = wabaRepo.createWabaConnectionWithToken.mock.calls[0]![0];
    expect(insert.metaBusinessId).toBe("biz-1");
    expect(insert.displayName).toBe("Acme WA");
    expect(Buffer.isBuffer(insert.envelope.ciphertext)).toBe(true);
  });

  it("passa waba_id + business_id do front como hint pro discoverWaba", async () => {
    const t = await token("wabas:write");
    const res = await app.inject({
      method: "POST",
      url: URL_BASE,
      headers: { authorization: `Bearer ${t}`, "idempotency-key": "es-hint-1" },
      payload: { code: "es-code", waba_id: "waba-1", business_id: "biz-77" },
    });
    expect(res.statusCode).toBe(200);
    expect(fakeMeta.discoverWaba).toHaveBeenCalledWith("EAA-es", {
      wabaId: "waba-1",
      businessId: "biz-77",
    });
  });

  it("discoverWaba falha (token não acessa a WABA) → propaga e NÃO persiste", async () => {
    fakeMeta.discoverWaba.mockRejectedValueOnce(new Error("meta rejected"));
    const t = await token("wabas:write");
    const res = await app.inject({
      method: "POST",
      url: URL_BASE,
      headers: { authorization: `Bearer ${t}`, "idempotency-key": "es-2" },
      payload: { code: "es-code", waba_id: "waba-OUTRO" },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(wabaRepo.createWabaConnectionWithToken).not.toHaveBeenCalled();
  });

  it("subscribe falha → 5xx e NÃO persiste", async () => {
    fakeMeta.subscribeWabaApp.mockRejectedValueOnce(new Error("meta down"));
    const t = await token("wabas:write");
    const res = await app.inject({
      method: "POST",
      url: URL_BASE,
      headers: { authorization: `Bearer ${t}`, "idempotency-key": "es-3" },
      payload: { code: "es-code" },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(500);
    expect(wabaRepo.createWabaConnectionWithToken).not.toHaveBeenCalled();
  });

  it("sem scope wabas:write → 403", async () => {
    const t = await token("tenants:read");
    const res = await app.inject({
      method: "POST",
      url: URL_BASE,
      headers: { authorization: `Bearer ${t}`, "idempotency-key": "es-4" },
      payload: { code: "es-code" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("exige Idempotency-Key", async () => {
    const t = await token("wabas:write");
    const res = await app.inject({
      method: "POST",
      url: URL_BASE,
      headers: { authorization: `Bearer ${t}` },
      payload: { code: "es-code" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST .../wabas/connect/complete — coexistence (COEX)", () => {
  it("coexistence sem phone_number_id → 400 e não troca code", async () => {
    const t = await token("wabas:write");
    const res = await app.inject({
      method: "POST",
      url: URL_BASE,
      headers: { authorization: `Bearer ${t}`, "idempotency-key": "coex-1" },
      payload: { code: "es-code", coexistence: true },
    });
    expect(res.statusCode).toBe(400);
    expect(fakeMeta.exchangeCode).not.toHaveBeenCalled();
  });

  it("happy COEX: confirma is_on_biz_app, persiste e dispara smb_app_data sync", async () => {
    fakeMeta.getPhoneCoexInfo.mockResolvedValueOnce({
      phone_number_id: "phone-1",
      is_on_biz_app: true,
      platform_type: "CLOUD_API",
    });
    fakeMeta.triggerSmbAppDataSync.mockResolvedValueOnce({
      state_sync_request_id: "req-s",
      history_request_id: "req-h",
    });
    const t = await token("wabas:write");
    const res = await app.inject({
      method: "POST",
      url: URL_BASE,
      headers: { authorization: `Bearer ${t}`, "idempotency-key": "coex-2" },
      payload: {
        code: "es-code",
        waba_id: "waba-1",
        phone_number_id: "phone-1",
        coexistence: true,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(fakeMeta.getPhoneCoexInfo).toHaveBeenCalledWith("phone-1", "EAA-es");
    expect(fakeMeta.triggerSmbAppDataSync).toHaveBeenCalledWith("phone-1", "EAA-es");
    expect(wabaRepo.createWabaConnectionWithToken).toHaveBeenCalledTimes(1);
  });

  it("número não-COEX (is_on_biz_app=false) → 409 e NÃO persiste/dispara sync", async () => {
    fakeMeta.getPhoneCoexInfo.mockResolvedValueOnce({
      phone_number_id: "phone-1",
      is_on_biz_app: false,
      platform_type: "CLOUD_API",
    });
    const t = await token("wabas:write");
    const res = await app.inject({
      method: "POST",
      url: URL_BASE,
      headers: { authorization: `Bearer ${t}`, "idempotency-key": "coex-3" },
      payload: { code: "es-code", phone_number_id: "phone-1", coexistence: true },
    });
    expect(res.statusCode).toBe(409);
    expect(wabaRepo.createWabaConnectionWithToken).not.toHaveBeenCalled();
    expect(fakeMeta.triggerSmbAppDataSync).not.toHaveBeenCalled();
  });

  it("sync best-effort: triggerSmbAppDataSync falha → ainda 200 (conexão persistida)", async () => {
    fakeMeta.getPhoneCoexInfo.mockResolvedValueOnce({
      phone_number_id: "phone-1",
      is_on_biz_app: true,
      platform_type: "CLOUD_API",
    });
    fakeMeta.triggerSmbAppDataSync.mockRejectedValueOnce(new Error("meta down"));
    const t = await token("wabas:write");
    const res = await app.inject({
      method: "POST",
      url: URL_BASE,
      headers: { authorization: `Bearer ${t}`, "idempotency-key": "coex-4" },
      payload: { code: "es-code", phone_number_id: "phone-1", coexistence: true },
    });
    expect(res.statusCode).toBe(200);
    expect(wabaRepo.createWabaConnectionWithToken).toHaveBeenCalledTimes(1);
  });

  it("não-COEX (coexistence ausente): não chama getPhoneCoexInfo nem sync", async () => {
    const t = await token("wabas:write");
    const res = await app.inject({
      method: "POST",
      url: URL_BASE,
      headers: { authorization: `Bearer ${t}`, "idempotency-key": "coex-5" },
      payload: { code: "es-code", waba_id: "waba-1", phone_number_id: "phone-1" },
    });
    expect(res.statusCode).toBe(200);
    expect(fakeMeta.getPhoneCoexInfo).not.toHaveBeenCalled();
    expect(fakeMeta.triggerSmbAppDataSync).not.toHaveBeenCalled();
  });
});
