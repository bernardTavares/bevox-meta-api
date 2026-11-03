import { generateKeyPairSync } from "node:crypto";

import { SignJWT, importPKCS8 } from "jose";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { buildServer } from "@/bootstrap/server.js";
import { __resetEnvCacheForTests } from "@/config/env.js";
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

// Redis mock
vi.mock("@/lib/redis.js", () => {
  const map = new Map<string, string>();
  return {
    getRedis: () => ({
      get: async (k: string) => map.get(k) ?? null,
      set: async (k: string, v: string) => {
        map.set(k, v);
        return "OK";
      },
      getdel: async (k: string) => {
        const v = map.get(k) ?? null;
        map.delete(k);
        return v;
      },
      eval: async () => [1, 1000, 0],
      ping: async () => "PONG",
      quit: async () => "OK",
    }),
    closeRedis: async () => {
      // no-op
    },
    createBullMQConnection: () => ({}),
  };
});

const APP_ID = uuidv7();
const TENANT_ID = uuidv7();
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

vi.mock("@/modules/tenants/repository.js", () => ({
  findTenantById: vi.fn(async (appId: string, id: string) =>
    appId === APP_ID && id === TENANT_ID
      ? {
          id: TENANT_ID,
          appId: APP_ID,
          externalId: null,
          displayName: "T",
          metadataJson: {},
          status: "active",
          createdAt: new Date(),
          updatedAt: new Date(),
          deletedAt: null,
        }
      : null,
  ),
  insertTenant: vi.fn(),
  findTenantByExternalId: vi.fn(),
  listTenants: vi.fn(),
  updateTenant: vi.fn(),
  softDeleteTenant: vi.fn(),
  countActiveBindings: vi.fn(),
}));

const wabaRepo = vi.hoisted(() => ({
  list: vi.fn(),
  findById: vi.fn(),
  disconnect: vi.fn(),
  createWabaConnectionWithToken: vi.fn(),
  findWabaByTenantAndMetaId: vi.fn(),
  reconnectWaba: vi.fn(),
}));

vi.mock("@/modules/wabas/repository.js", () => ({
  listWabasByTenant: wabaRepo.list,
  findWabaConnectionById: wabaRepo.findById,
  disconnectWaba: wabaRepo.disconnect,
  createWabaConnectionWithToken: wabaRepo.createWabaConnectionWithToken,
  findWabaByTenantAndMetaId: wabaRepo.findWabaByTenantAndMetaId,
  reconnectWaba: wabaRepo.reconnectWaba,
}));

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

function fakeWaba(opts: Partial<any> = {}) {
  return {
    id: uuidv7(),
    tenantId: TENANT_ID,
    appId: APP_ID,
    metaBusinessId: "biz",
    metaWabaId: "waba-x",
    displayName: "X",
    verifiedStatus: "VERIFIED",
    createdAt: new Date(),
    updatedAt: new Date(),
    disconnectedAt: null,
    ...opts,
  };
}

beforeAll(async () => {
  for (const [k, v] of Object.entries(REQUIRED_ENV)) process.env[k] = v;
  __resetEnvCacheForTests();
  __resetLoggerForTests();
  signingKey = await importPKCS8(PRIVATE_PKCS8, "RS256");
  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  idem.store.clear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("GET /v1/tenants/:tenant_id/wabas", () => {
  it("lista wabas conectadas (default exclui disconnected)", async () => {
    const t = await token("wabas:read");
    wabaRepo.list.mockResolvedValueOnce([
      fakeWaba({ metaWabaId: "waba-1" }),
      fakeWaba({ metaWabaId: "waba-2" }),
    ]);
    const res = await app.inject({
      method: "GET",
      url: `/v1/tenants/${TENANT_ID}/wabas`,
      headers: { authorization: `Bearer ${t}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toHaveLength(2);
    expect(body.data[0].meta_waba_id).toBe("waba-1");
    expect(wabaRepo.list).toHaveBeenCalledWith(APP_ID, TENANT_ID, { includeDisconnected: false });
  });

  it("include_disconnected=true passa flag", async () => {
    const t = await token("wabas:read");
    wabaRepo.list.mockResolvedValueOnce([]);
    await app.inject({
      method: "GET",
      url: `/v1/tenants/${TENANT_ID}/wabas?include_disconnected=true`,
      headers: { authorization: `Bearer ${t}` },
    });
    expect(wabaRepo.list).toHaveBeenCalledWith(APP_ID, TENANT_ID, { includeDisconnected: true });
  });

  it("rejeita scope errado → 403", async () => {
    const t = await token("messages:write");
    const res = await app.inject({
      method: "GET",
      url: `/v1/tenants/${TENANT_ID}/wabas`,
      headers: { authorization: `Bearer ${t}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("tenant inexistente → 404", async () => {
    const t = await token("wabas:read");
    const res = await app.inject({
      method: "GET",
      url: `/v1/tenants/${uuidv7()}/wabas`,
      headers: { authorization: `Bearer ${t}` },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("DELETE /v1/tenants/:tenant_id/wabas/:waba_id", () => {
  it("desconecta waba ativa → 200 com disconnected_at populado", async () => {
    const wabaId = uuidv7();
    wabaRepo.findById.mockResolvedValueOnce(fakeWaba({ id: wabaId }));
    wabaRepo.disconnect.mockResolvedValueOnce(fakeWaba({ id: wabaId, disconnectedAt: new Date() }));

    const t = await token("wabas:write");
    const res = await app.inject({
      method: "DELETE",
      url: `/v1/tenants/${TENANT_ID}/wabas/${wabaId}`,
      headers: { authorization: `Bearer ${t}`, "idempotency-key": "d-1" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().disconnected_at).toBeTruthy();
    expect(wabaRepo.disconnect).toHaveBeenCalledWith(APP_ID, TENANT_ID, wabaId);
  });

  it("waba inexistente → 404", async () => {
    wabaRepo.findById.mockResolvedValueOnce(null);
    const t = await token("wabas:write");
    const res = await app.inject({
      method: "DELETE",
      url: `/v1/tenants/${TENANT_ID}/wabas/${uuidv7()}`,
      headers: { authorization: `Bearer ${t}`, "idempotency-key": "d-2" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("waba já desconectada → 409", async () => {
    const wabaId = uuidv7();
    wabaRepo.findById.mockResolvedValueOnce(
      fakeWaba({ id: wabaId, disconnectedAt: new Date(Date.now() - 1000) }),
    );
    const t = await token("wabas:write");
    const res = await app.inject({
      method: "DELETE",
      url: `/v1/tenants/${TENANT_ID}/wabas/${wabaId}`,
      headers: { authorization: `Bearer ${t}`, "idempotency-key": "d-3" },
    });
    expect(res.statusCode).toBe(409);
    expect(wabaRepo.disconnect).not.toHaveBeenCalled();
  });

  it("rejeita sem scope wabas:write → 403", async () => {
    const t = await token("wabas:read");
    const res = await app.inject({
      method: "DELETE",
      url: `/v1/tenants/${TENANT_ID}/wabas/${uuidv7()}`,
      headers: { authorization: `Bearer ${t}`, "idempotency-key": "d-4" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("exige Idempotency-Key", async () => {
    const t = await token("wabas:write");
    const res = await app.inject({
      method: "DELETE",
      url: `/v1/tenants/${TENANT_ID}/wabas/${uuidv7()}`,
      headers: { authorization: `Bearer ${t}` },
    });
    expect(res.statusCode).toBe(400);
  });
});
