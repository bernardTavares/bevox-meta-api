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
  META_ES_CONFIG_ID: "es-config-abc",
};

// ---------------------------------------------------------------------------
// Fake Redis com GETDEL + EVAL para rate-limit
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
  const evalFn = vi.fn(async (_s: string, _n: number, ...args: string[]) => {
    const [key, capStr, refStr, nowStr, costStr] = args;
    const cap = Number(capStr);
    const ref = Number(refStr);
    const now = Number(nowStr);
    const cost = Number(costStr);
    const ex = redisState.rl.get(key!);
    let tokens = ex && ex.expiresAt > now ? ex.tokens : cap;
    const lastTs = ex && ex.expiresAt > now ? ex.ts : now;
    tokens = Math.min(cap, tokens + Math.max(0, (now - lastTs) / 1000) * ref);
    let allowed = 0;
    if (tokens >= cost) {
      tokens -= cost;
      allowed = 1;
    }
    redisState.rl.set(key!, { tokens, ts: now, expiresAt: now + 60_000 });
    return [allowed, tokens, 0];
  });
  const fake = {
    get,
    set,
    getdel,
    eval: evalFn,
    ping: async () => "PONG",
    quit: async () => "OK",
  };
  return {
    getRedis: () => fake,
    closeRedis: async () => {
      // no-op
    },
    createBullMQConnection: () => fake,
  };
});

// ---------------------------------------------------------------------------
// Auth + idempotency mocks
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tenants repository mock
// ---------------------------------------------------------------------------

const tenantState = vi.hoisted(() => ({
  tenants: new Map<string, any>(),
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

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

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
  signingKey = await importPKCS8(PRIVATE_PKCS8, "RS256");
  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  redisState.kv.clear();
  redisState.rl.clear();
  idem.store.clear();
  tenantState.tenants.clear();

  tenantState.findById.mockImplementation(async (appId: string, id: string) => {
    const t = tenantState.tenants.get(id);
    return t && t.appId === appId ? t : null;
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

function makeTenant(
  opts: Partial<{ id: string; appId: string; status: string; deletedAt: Date | null }> = {},
) {
  const id = opts.id ?? uuidv7();
  const t = {
    id,
    appId: opts.appId ?? APP_ID,
    externalId: null,
    displayName: "X",
    metadataJson: {},
    status: opts.status ?? "active",
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: opts.deletedAt ?? null,
  };
  tenantState.tenants.set(id, t);
  return t;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /v1/tenants/:tenant_id/wabas/connect/init", () => {
  it("retorna oauth_url + state e armazena state em Redis", async () => {
    const tenant = makeTenant();
    const t = await token("wabas:write");
    const res = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenant.id}/wabas/connect/init`,
      headers: { authorization: `Bearer ${t}`, "idempotency-key": "init-1" },
      payload: { redirect_url: "https://app.example.com/post-oauth" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.state).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.expires_in_seconds).toBe(600);

    const url = new URL(body.oauth_url);
    expect(url.host).toBe("www.facebook.com");
    expect(url.searchParams.get("client_id")).toBe("1234567890");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://meta-api.bevox.test/v1/oauth/waba/callback",
    );
    expect(url.searchParams.get("state")).toBe(body.state);
    expect(url.searchParams.get("scope")).toContain("whatsapp_business_management");

    // State persistido no Redis
    const stored = redisState.kv.get(`oauth:state:${body.state}`);
    expect(stored).toBeDefined();
    const payload = JSON.parse(stored!.value);
    expect(payload.app_id).toBe(APP_ID);
    expect(payload.tenant_id).toBe(tenant.id);
    expect(payload.channel).toBe("waba");
    expect(payload.redirect_url).toBe("https://app.example.com/post-oauth");
    expect(body.config_id).toBe("es-config-abc");
    expect(body.meta_app_id).toBe("1234567890");
    expect(body.graph_version).toBe("v21.0");
  });

  it("rejeita tenant inexistente → 404", async () => {
    const t = await token("wabas:write");
    const res = await app.inject({
      method: "POST",
      url: `/v1/tenants/${uuidv7()}/wabas/connect/init`,
      headers: { authorization: `Bearer ${t}`, "idempotency-key": "init-2" },
      payload: { redirect_url: "https://x.com" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("rejeita tenant de outro app → 404 (ownership)", async () => {
    const otherApp = uuidv7();
    const tenant = makeTenant({ appId: otherApp });
    const t = await token("wabas:write");
    const res = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenant.id}/wabas/connect/init`,
      headers: { authorization: `Bearer ${t}`, "idempotency-key": "init-3" },
      payload: { redirect_url: "https://x.com" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("rejeita tenant deletado → 409", async () => {
    const tenant = makeTenant({ deletedAt: new Date() });
    const t = await token("wabas:write");
    const res = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenant.id}/wabas/connect/init`,
      headers: { authorization: `Bearer ${t}`, "idempotency-key": "init-4" },
      payload: { redirect_url: "https://x.com" },
    });
    expect(res.statusCode).toBe(409);
  });

  it("rejeita redirect_url inválida → 400", async () => {
    const tenant = makeTenant();
    const t = await token("wabas:write");
    const res = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenant.id}/wabas/connect/init`,
      headers: { authorization: `Bearer ${t}`, "idempotency-key": "init-5" },
      payload: { redirect_url: "not-a-url" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejeita sem scope wabas:write → 403", async () => {
    const tenant = makeTenant();
    const t = await token("tenants:read");
    const res = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenant.id}/wabas/connect/init`,
      headers: { authorization: `Bearer ${t}`, "idempotency-key": "init-6" },
      payload: { redirect_url: "https://x.com" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("exige Idempotency-Key", async () => {
    const tenant = makeTenant();
    const t = await token("wabas:write");
    const res = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenant.id}/wabas/connect/init`,
      headers: { authorization: `Bearer ${t}` },
      payload: { redirect_url: "https://x.com" },
    });
    expect(res.statusCode).toBe(400);
  });
});
