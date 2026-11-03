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
    accessToken: "EAA-fake",
    expiresAt: new Date(Date.now() + 3600_000),
  })),
}));

const tplRepo = vi.hoisted(() => ({
  upsert: vi.fn(),
  list: vi.fn(),
  find: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("@/modules/templates/repository.js", () => ({
  upsertTemplate: tplRepo.upsert,
  listTemplatesByWaba: tplRepo.list,
  findTemplate: tplRepo.find,
  deleteTemplate: tplRepo.remove,
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

const VALID_TEMPLATE_BODY = {
  name: "welcome_message",
  language: "pt_BR",
  category: "UTILITY",
  components: [
    { type: "BODY", text: "Olá, {{1}}!" },
    { type: "FOOTER", text: "Bevox" },
  ],
};

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
  tplRepo.find.mockResolvedValue(null);
  tplRepo.upsert.mockImplementation(async (input: any) => ({
    id: uuidv7(),
    wabaConnectionId: input.wabaConnectionId,
    name: input.name,
    language: input.language,
    category: input.category,
    metaStatus: input.status,
    metaQualityScore: input.qualityScore,
    componentsJson: input.components,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSyncedAt: new Date(),
  }));
  tplRepo.list.mockResolvedValue([]);
  tplRepo.remove.mockResolvedValue(true);
  fakeMeta.createMessageTemplate.mockResolvedValue({
    meta_template_id: "tpl-meta-1",
    status: "PENDING",
    category: "UTILITY",
  });
  fakeMeta.getMessageTemplate.mockResolvedValue({
    meta_template_id: "tpl-meta-1",
    name: "welcome_message",
    language: "pt_BR",
    category: "UTILITY",
    status: "APPROVED",
    quality_score: 90,
    components: [{ type: "BODY", text: "x" }],
  });
  fakeMeta.deleteMessageTemplate.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

const baseUrl = `/v1/tenants/${TENANT_ID}/wabas/${WABA_CONN_ID}/templates`;

describe("POST templates", () => {
  it("submete à Meta + persiste local PENDING + 202", async () => {
    const t = await token("templates:write");
    const res = await app.inject({
      method: "POST",
      url: baseUrl,
      headers: { authorization: `Bearer ${t}`, "idempotency-key": "tpl-1" },
      payload: VALID_TEMPLATE_BODY,
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().status).toBe("PENDING");
    expect(fakeMeta.createMessageTemplate).toHaveBeenCalled();
    expect(tplRepo.upsert).toHaveBeenCalled();
  });

  it("rejeita name com caracteres inválidos", async () => {
    const t = await token("templates:write");
    const res = await app.inject({
      method: "POST",
      url: baseUrl,
      headers: { authorization: `Bearer ${t}`, "idempotency-key": "tpl-2" },
      payload: { ...VALID_TEMPLATE_BODY, name: "Has Spaces!" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("conflito quando já existe (não-REJECTED)", async () => {
    tplRepo.find.mockResolvedValueOnce({ metaStatus: "APPROVED" });
    const t = await token("templates:write");
    const res = await app.inject({
      method: "POST",
      url: baseUrl,
      headers: { authorization: `Bearer ${t}`, "idempotency-key": "tpl-3" },
      payload: VALID_TEMPLATE_BODY,
    });
    expect(res.statusCode).toBe(409);
  });

  it("rejeita scope errado", async () => {
    const t = await token("templates:read");
    const res = await app.inject({
      method: "POST",
      url: baseUrl,
      headers: { authorization: `Bearer ${t}`, "idempotency-key": "tpl-4" },
      payload: VALID_TEMPLATE_BODY,
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("GET templates", () => {
  it("lista", async () => {
    tplRepo.list.mockResolvedValueOnce([
      {
        id: uuidv7(),
        wabaConnectionId: WABA_CONN_ID,
        name: "a",
        language: "pt_BR",
        category: "UTILITY",
        metaStatus: "APPROVED",
        metaQualityScore: 80,
        componentsJson: [],
        createdAt: new Date(),
        updatedAt: new Date(),
        lastSyncedAt: new Date(),
      },
    ]);
    const t = await token("templates:read");
    const res = await app.inject({
      method: "GET",
      url: baseUrl,
      headers: { authorization: `Bearer ${t}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(1);
  });
});

describe("POST resync", () => {
  it("refetch da Meta + upsert", async () => {
    const t = await token("templates:write");
    const res = await app.inject({
      method: "POST",
      url: `${baseUrl}/welcome_message/pt_BR/resync`,
      headers: { authorization: `Bearer ${t}`, "idempotency-key": "tpl-r" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("APPROVED");
    expect(res.json().quality_score).toBe(90);
    expect(fakeMeta.getMessageTemplate).toHaveBeenCalled();
  });

  it("Meta não retorna template → 404 e remove local", async () => {
    fakeMeta.getMessageTemplate.mockResolvedValueOnce(null);
    const t = await token("templates:write");
    const res = await app.inject({
      method: "POST",
      url: `${baseUrl}/missing/pt_BR/resync`,
      headers: { authorization: `Bearer ${t}`, "idempotency-key": "tpl-r2" },
    });
    expect(res.statusCode).toBe(404);
    expect(tplRepo.remove).toHaveBeenCalled();
  });
});

describe("DELETE template", () => {
  it("propaga delete para Meta + remove local", async () => {
    tplRepo.find.mockResolvedValueOnce({
      id: uuidv7(),
      wabaConnectionId: WABA_CONN_ID,
      name: "welcome_message",
      language: "pt_BR",
      category: "UTILITY",
      metaStatus: "APPROVED",
    });
    const t = await token("templates:write");
    const res = await app.inject({
      method: "DELETE",
      url: `${baseUrl}/welcome_message/pt_BR`,
      headers: { authorization: `Bearer ${t}`, "idempotency-key": "tpl-d" },
    });
    expect(res.statusCode).toBe(200);
    expect(fakeMeta.deleteMessageTemplate).toHaveBeenCalledWith(
      "waba-meta",
      "EAA-fake",
      "welcome_message",
    );
    expect(tplRepo.remove).toHaveBeenCalled();
  });

  it("template inexistente → 404", async () => {
    const t = await token("templates:write");
    const res = await app.inject({
      method: "DELETE",
      url: `${baseUrl}/missing/pt_BR`,
      headers: { authorization: `Bearer ${t}`, "idempotency-key": "tpl-d2" },
    });
    expect(res.statusCode).toBe(404);
    expect(fakeMeta.deleteMessageTemplate).not.toHaveBeenCalled();
  });
});
