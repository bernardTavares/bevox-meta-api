import { generateKeyPairSync } from "node:crypto";

import { SignJWT, importPKCS8 } from "jose";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { buildServer } from "@/bootstrap/server.js";
import { __resetEnvCacheForTests } from "@/config/env.js";
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
  closeRedis: async () => {
    // no-op
  },
  createBullMQConnection: () => ({}),
}));

const APP_ID = uuidv7();
const TENANT_ID = uuidv7();
const WABA_CONN_ID = uuidv7();
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
    findRecordSpy: vi.fn(async (a: string, k: string) => store.get(`${a}:${k}`) ?? null),
    saveRecordSpy: vi.fn(async (input: any) => {
      const k = `${input.appId}:${input.key}`;
      if (!store.has(k)) store.set(k, input);
    }),
  };
});
vi.mock("@/modules/idempotency/repository.js", () => ({
  findIdempotencyRecord: idem.findRecordSpy,
  saveIdempotencyRecord: idem.saveRecordSpy,
}));

vi.mock("@/modules/wabas/repository.js", () => ({
  findWabaConnectionById: vi.fn(async (appId: string, tenantId: string, id: string) => {
    if (appId !== APP_ID || tenantId !== TENANT_ID || id !== WABA_CONN_ID) return null;
    return {
      id: WABA_CONN_ID,
      tenantId: TENANT_ID,
      appId: APP_ID,
      metaBusinessId: "biz",
      metaWabaId: "waba-meta",
      displayName: "X",
      verifiedStatus: "VERIFIED",
      createdAt: new Date(),
      updatedAt: new Date(),
      disconnectedAt: null,
    };
  }),
  listWabasByTenant: vi.fn(),
  disconnectWaba: vi.fn(),
  createWabaConnectionWithToken: vi.fn(),
  findWabaByTenantAndMetaId: vi.fn(),
  reconnectWaba: vi.fn(),
}));

vi.mock("@/modules/wabas/token-resolver.js", () => ({
  resolveActiveWabaToken: vi.fn(async () => ({
    accessToken: "EAA-fake-token",
    expiresAt: new Date(Date.now() + 3600_000),
  })),
}));

const phoneRepo = vi.hoisted(() => ({
  upsert: vi.fn(),
  list: vi.fn(),
  findByMetaId: vi.fn(),
}));

vi.mock("@/modules/phone-numbers/repository.js", () => ({
  upsertPhoneNumbers: phoneRepo.upsert,
  listPhoneNumbersByWaba: phoneRepo.list,
  findPhoneByMetaId: phoneRepo.findByMetaId,
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
  idem.store.clear();
  phoneRepo.upsert.mockResolvedValue([
    {
      id: uuidv7(),
      wabaConnectionId: WABA_CONN_ID,
      metaPhoneId: "phone-1",
      displayPhoneNumber: "+5511999999999",
      verifiedName: "Acme",
      qualityRating: "GREEN",
      messagingLimitTier: "TIER_1K",
    },
  ]);
  phoneRepo.list.mockResolvedValue([]);
  phoneRepo.findByMetaId.mockResolvedValue({
    id: uuidv7(),
    wabaConnectionId: WABA_CONN_ID,
    metaPhoneId: "phone-1",
    displayPhoneNumber: "+5511999999999",
    verifiedName: "Acme",
    qualityRating: "GREEN",
    messagingLimitTier: "TIER_1K",
  });
  fakeMeta.listPhoneNumbers.mockResolvedValue([
    {
      meta_phone_id: "phone-1",
      display_phone_number: "+5511999999999",
      verified_name: "Acme",
      quality_rating: "GREEN",
      messaging_limit_tier: "TIER_1K",
    },
  ]);
  fakeMeta.updatePhoneNumberProfile.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("GET /v1/tenants/:tenant_id/wabas/:waba_id/phone-numbers", () => {
  it("sincroniza com Meta e retorna lista", async () => {
    const t = await token("phone-numbers:read");
    const res = await app.inject({
      method: "GET",
      url: `/v1/tenants/${TENANT_ID}/wabas/${WABA_CONN_ID}/phone-numbers`,
      headers: { authorization: `Bearer ${t}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].meta_phone_id).toBe("phone-1");

    expect(fakeMeta.listPhoneNumbers).toHaveBeenCalledWith("waba-meta", "EAA-fake-token");
    expect(phoneRepo.upsert).toHaveBeenCalledTimes(1);
  });

  it("waba inexistente → 404", async () => {
    const t = await token("phone-numbers:read");
    const res = await app.inject({
      method: "GET",
      url: `/v1/tenants/${TENANT_ID}/wabas/${uuidv7()}/phone-numbers`,
      headers: { authorization: `Bearer ${t}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it("rejeita scope errado → 403", async () => {
    const t = await token("messages:write");
    const res = await app.inject({
      method: "GET",
      url: `/v1/tenants/${TENANT_ID}/wabas/${WABA_CONN_ID}/phone-numbers`,
      headers: { authorization: `Bearer ${t}` },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("POST /v1/tenants/:tenant_id/wabas/:waba_id/phone-numbers/:phone_id/profile", () => {
  it("propaga update para Meta", async () => {
    const t = await token("phone-numbers:write");
    const res = await app.inject({
      method: "POST",
      url: `/v1/tenants/${TENANT_ID}/wabas/${WABA_CONN_ID}/phone-numbers/phone-1/profile`,
      headers: { authorization: `Bearer ${t}`, "idempotency-key": "p-1" },
      payload: { about: "Sobre nós", description: "Bevox testing" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, meta_phone_id: "phone-1" });
    expect(fakeMeta.updatePhoneNumberProfile).toHaveBeenCalledWith("phone-1", "EAA-fake-token", {
      about: "Sobre nós",
      description: "Bevox testing",
    });
  });

  it("about > 139 chars → 400", async () => {
    const t = await token("phone-numbers:write");
    const res = await app.inject({
      method: "POST",
      url: `/v1/tenants/${TENANT_ID}/wabas/${WABA_CONN_ID}/phone-numbers/phone-1/profile`,
      headers: { authorization: `Bearer ${t}`, "idempotency-key": "p-2" },
      payload: { about: "x".repeat(200) },
    });
    expect(res.statusCode).toBe(400);
  });

  it("body vazio → 400", async () => {
    const t = await token("phone-numbers:write");
    const res = await app.inject({
      method: "POST",
      url: `/v1/tenants/${TENANT_ID}/wabas/${WABA_CONN_ID}/phone-numbers/phone-1/profile`,
      headers: { authorization: `Bearer ${t}`, "idempotency-key": "p-3" },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("phone não encontrado localmente → 404", async () => {
    phoneRepo.findByMetaId.mockResolvedValueOnce(null);
    const t = await token("phone-numbers:write");
    const res = await app.inject({
      method: "POST",
      url: `/v1/tenants/${TENANT_ID}/wabas/${WABA_CONN_ID}/phone-numbers/phone-x/profile`,
      headers: { authorization: `Bearer ${t}`, "idempotency-key": "p-4" },
      payload: { about: "x" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("rejeita scope errado → 403", async () => {
    const t = await token("phone-numbers:read");
    const res = await app.inject({
      method: "POST",
      url: `/v1/tenants/${TENANT_ID}/wabas/${WABA_CONN_ID}/phone-numbers/phone-1/profile`,
      headers: { authorization: `Bearer ${t}`, "idempotency-key": "p-5" },
      payload: { about: "x" },
    });
    expect(res.statusCode).toBe(403);
  });
});
