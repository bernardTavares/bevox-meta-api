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
};

// ---------------------------------------------------------------------------
// Fake Redis (shared store + Lua eval para rate-limit)
// ---------------------------------------------------------------------------

const redisState = vi.hoisted(() => {
  return {
    kv: new Map<string, { value: string; expiresAt: number }>(),
    rl: new Map<string, { tokens: number; ts: number; expiresAt: number }>(),
  };
});

vi.mock("@/lib/redis.js", () => {
  const get = vi.fn(async (key: string) => {
    const entry = redisState.kv.get(key);
    if (!entry || entry.expiresAt < Date.now()) {
      redisState.kv.delete(key);
      return null;
    }
    return entry.value;
  });
  const set = vi.fn(async (key: string, value: string, _mode: string, ttl: number) => {
    redisState.kv.set(key, { value, expiresAt: Date.now() + ttl * 1000 });
    return "OK";
  });
  const evalFn = vi.fn(async (_script: string, _n: number, ...args: string[]) => {
    const [key, capacityStr, refillStr, nowStr, costStr] = args;
    const capacity = Number(capacityStr);
    const refill = Number(refillStr);
    const now = Number(nowStr);
    const cost = Number(costStr);
    const existing = redisState.rl.get(key!);
    let tokens = existing && existing.expiresAt > now ? existing.tokens : capacity;
    const lastTs = existing && existing.expiresAt > now ? existing.ts : now;
    const elapsed = Math.max(0, (now - lastTs) / 1000);
    tokens = Math.min(capacity, tokens + elapsed * refill);
    let allowed = 0;
    let retryMs = 0;
    if (tokens >= cost) {
      tokens -= cost;
      allowed = 1;
    } else {
      retryMs = Math.ceil(((cost - tokens) / refill) * 1000);
    }
    const expireMs = Math.ceil((capacity / refill) * 1000) + 5000;
    redisState.rl.set(key!, { tokens, ts: now, expiresAt: now + expireMs });
    return [allowed, tokens, retryMs];
  });
  const fake = { get, set, eval: evalFn, ping: async () => "PONG", quit: async () => "OK" };
  return {
    getRedis: () => fake,
    closeRedis: async () => {
      // no-op
    },
    createBullMQConnection: () => fake,
  };
});

// ---------------------------------------------------------------------------
// Auth — sempre app ativo, key válida
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

// Idempotency mock — em-memória.
const idem = vi.hoisted(() => {
  const store = new Map<
    string,
    {
      appId: string;
      key: string;
      requestHash: string;
      responseStatus: number;
      responseBodyJson: unknown;
      expiresAt: Date;
    }
  >();
  return {
    store,
    findRecordSpy: vi.fn(
      async (appId: string, key: string) => store.get(`${appId}:${key}`) ?? null,
    ),
    saveRecordSpy: vi.fn(async (input: typeof store extends Map<string, infer V> ? V : never) => {
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
// Tenants repository — em-memória controlado pelos tests
// ---------------------------------------------------------------------------

interface FakeTenantRow {
  id: string;
  appId: string;
  externalId: string | null;
  displayName: string;
  metadataJson: Record<string, unknown>;
  status: "active" | "disabled" | "deleted";
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

const tenantState = vi.hoisted(() => {
  const tenants = new Map<string, unknown>();
  const bindings = new Map<string, { wabas: number; igs: number }>();
  return {
    tenants,
    bindings,
    insert: vi.fn(),
    findById: vi.fn(),
    findByExternal: vi.fn(),
    list: vi.fn(),
    update: vi.fn(),
    softDelete: vi.fn(),
    countBindings: vi.fn(),
  };
});

vi.mock("@/modules/tenants/repository.js", () => ({
  insertTenant: tenantState.insert,
  findTenantById: tenantState.findById,
  findTenantByExternalId: tenantState.findByExternal,
  listTenants: tenantState.list,
  updateTenant: tenantState.update,
  softDeleteTenant: tenantState.softDelete,
  countActiveBindings: tenantState.countBindings,
}));

// Acesso conveniente
const tenants = tenantState.tenants as Map<string, FakeTenantRow>;
const bindings = tenantState.bindings as Map<string, { wabas: number; igs: number }>;

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
  tenants.clear();
  bindings.clear();
  idem.store.clear();
  redisState.kv.clear();
  redisState.rl.clear();

  // Bind comportamentos default ao state em-memória.
  tenantState.insert.mockImplementation(async (input: any) => {
    const row: FakeTenantRow = {
      id: uuidv7(),
      appId: input.appId,
      externalId: input.externalId,
      displayName: input.displayName,
      metadataJson: input.metadata,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    };
    tenants.set(row.id, row);
    return row;
  });

  tenantState.findById.mockImplementation(async (appId: string, id: string) => {
    const t = tenants.get(id);
    return t && t.appId === appId ? t : null;
  });

  tenantState.findByExternal.mockImplementation(async (appId: string, ext: string) => {
    return (
      [...tenants.values()].find(
        (t) => t.appId === appId && t.externalId === ext && t.deletedAt === null,
      ) ?? null
    );
  });

  tenantState.list.mockImplementation(async (params: any) => {
    let rows = [...tenants.values()].filter((t) => t.appId === params.appId);
    if (!params.includeDeleted) rows = rows.filter((t) => t.deletedAt === null);
    if (params.externalId) rows = rows.filter((t) => t.externalId === params.externalId);
    if (params.cursor) rows = rows.filter((t) => t.id > params.cursor);
    rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return rows.slice(0, params.limit);
  });

  tenantState.update.mockImplementation(async (appId: string, id: string, patch: any) => {
    const t = tenants.get(id);
    if (!t || t.appId !== appId || t.deletedAt !== null) return null;
    if (patch.displayName !== undefined) t.displayName = patch.displayName;
    if (patch.metadata !== undefined) t.metadataJson = patch.metadata;
    if (patch.status !== undefined) t.status = patch.status;
    t.updatedAt = new Date();
    return t;
  });

  tenantState.softDelete.mockImplementation(async (appId: string, id: string) => {
    const t = tenants.get(id);
    if (!t || t.appId !== appId || t.deletedAt !== null) return null;
    t.deletedAt = new Date();
    t.status = "deleted";
    t.updatedAt = new Date();
    return t;
  });

  tenantState.countBindings.mockImplementation(async (_appId: string, tenantId: string) => {
    return bindings.get(tenantId) ?? { wabas: 0, igs: 0 };
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /v1/tenants", () => {
  it("cria tenant com display_name + external_id", async () => {
    const t = await token("tenants:write");
    const res = await app.inject({
      method: "POST",
      url: "/v1/tenants",
      headers: {
        authorization: `Bearer ${t}`,
        "idempotency-key": "create-1",
        "content-type": "application/json",
      },
      payload: { display_name: "Acme Clinic", external_id: "acme-1" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.display_name).toBe("Acme Clinic");
    expect(body.external_id).toBe("acme-1");
    expect(body.status).toBe("active");
    expect(body.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
  });

  it("retorna 409 quando external_id já existe", async () => {
    const t = await token("tenants:write");
    await app.inject({
      method: "POST",
      url: "/v1/tenants",
      headers: { authorization: `Bearer ${t}`, "idempotency-key": "k1" },
      payload: { display_name: "A", external_id: "dup" },
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/tenants",
      headers: { authorization: `Bearer ${t}`, "idempotency-key": "k2" },
      payload: { display_name: "B", external_id: "dup" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("CONFLICT");
  });

  it("rejeita sem scope tenants:write", async () => {
    const t = await token("tenants:read");
    const res = await app.inject({
      method: "POST",
      url: "/v1/tenants",
      headers: { authorization: `Bearer ${t}`, "idempotency-key": "k" },
      payload: { display_name: "A" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("exige Idempotency-Key", async () => {
    const t = await token("tenants:write");
    const res = await app.inject({
      method: "POST",
      url: "/v1/tenants",
      headers: { authorization: `Bearer ${t}` },
      payload: { display_name: "A" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /v1/tenants", () => {
  it("lista tenants do app, paginado por cursor", async () => {
    const t = await token("tenants:read tenants:write");
    for (let i = 0; i < 3; i++) {
      await app.inject({
        method: "POST",
        url: "/v1/tenants",
        headers: { authorization: `Bearer ${t}`, "idempotency-key": `c-${i}` },
        payload: { display_name: `t-${i}` },
      });
    }
    const r = await app.inject({
      method: "GET",
      url: "/v1/tenants?limit=2",
      headers: { authorization: `Bearer ${t}` },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.data).toHaveLength(2);
    expect(body.next_cursor).toBeTruthy();

    const r2 = await app.inject({
      method: "GET",
      url: `/v1/tenants?limit=2&cursor=${body.next_cursor}`,
      headers: { authorization: `Bearer ${t}` },
    });
    expect(r2.json().data).toHaveLength(1);
    expect(r2.json().next_cursor).toBeNull();
  });

  it("filtra por external_id", async () => {
    const t = await token("tenants:read tenants:write");
    await app.inject({
      method: "POST",
      url: "/v1/tenants",
      headers: { authorization: `Bearer ${t}`, "idempotency-key": "f-1" },
      payload: { display_name: "A", external_id: "needle" },
    });
    await app.inject({
      method: "POST",
      url: "/v1/tenants",
      headers: { authorization: `Bearer ${t}`, "idempotency-key": "f-2" },
      payload: { display_name: "B", external_id: "haystack" },
    });
    const r = await app.inject({
      method: "GET",
      url: "/v1/tenants?external_id=needle",
      headers: { authorization: `Bearer ${t}` },
    });
    expect(r.json().data).toHaveLength(1);
    expect(r.json().data[0].external_id).toBe("needle");
  });

  it("rejeita sem scope tenants:read", async () => {
    const t = await token("messages:write");
    const r = await app.inject({
      method: "GET",
      url: "/v1/tenants",
      headers: { authorization: `Bearer ${t}` },
    });
    expect(r.statusCode).toBe(403);
  });
});

describe("GET /v1/tenants/:tenant_id", () => {
  it("retorna 404 para id inexistente", async () => {
    const t = await token("tenants:read");
    const r = await app.inject({
      method: "GET",
      url: `/v1/tenants/${uuidv7()}`,
      headers: { authorization: `Bearer ${t}` },
    });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe("NOT_FOUND");
  });

  it("retorna o tenant criado", async () => {
    const t = await token("tenants:read tenants:write");
    const created = await app.inject({
      method: "POST",
      url: "/v1/tenants",
      headers: { authorization: `Bearer ${t}`, "idempotency-key": "g" },
      payload: { display_name: "X" },
    });
    const id = created.json().id;
    const r = await app.inject({
      method: "GET",
      url: `/v1/tenants/${id}`,
      headers: { authorization: `Bearer ${t}` },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().id).toBe(id);
  });
});

describe("PATCH /v1/tenants/:tenant_id", () => {
  it("atualiza display_name", async () => {
    const t = await token("tenants:write");
    const created = await app.inject({
      method: "POST",
      url: "/v1/tenants",
      headers: { authorization: `Bearer ${t}`, "idempotency-key": "p1" },
      payload: { display_name: "Old" },
    });
    const id = created.json().id;
    const r = await app.inject({
      method: "PATCH",
      url: `/v1/tenants/${id}`,
      headers: { authorization: `Bearer ${t}`, "idempotency-key": "p2" },
      payload: { display_name: "New" },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().display_name).toBe("New");
  });

  it("rejeita body vazio", async () => {
    const t = await token("tenants:write");
    const created = await app.inject({
      method: "POST",
      url: "/v1/tenants",
      headers: { authorization: `Bearer ${t}`, "idempotency-key": "p3" },
      payload: { display_name: "X" },
    });
    const id = created.json().id;
    const r = await app.inject({
      method: "PATCH",
      url: `/v1/tenants/${id}`,
      headers: { authorization: `Bearer ${t}`, "idempotency-key": "p4" },
      payload: {},
    });
    expect(r.statusCode).toBe(400);
  });
});

describe("DELETE /v1/tenants/:tenant_id", () => {
  it("soft-deleta tenant sem bindings", async () => {
    const t = await token("tenants:write");
    const created = await app.inject({
      method: "POST",
      url: "/v1/tenants",
      headers: { authorization: `Bearer ${t}`, "idempotency-key": "d1" },
      payload: { display_name: "X" },
    });
    const id = created.json().id;
    const r = await app.inject({
      method: "DELETE",
      url: `/v1/tenants/${id}`,
      headers: { authorization: `Bearer ${t}`, "idempotency-key": "d2" },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().deleted_at).toBeTruthy();
    expect(r.json().status).toBe("deleted");
  });

  it("bloqueia delete quando há bindings ativos", async () => {
    const t = await token("tenants:write");
    const created = await app.inject({
      method: "POST",
      url: "/v1/tenants",
      headers: { authorization: `Bearer ${t}`, "idempotency-key": "d3" },
      payload: { display_name: "X" },
    });
    const id = created.json().id;
    bindings.set(id, { wabas: 1, igs: 0 });
    const r = await app.inject({
      method: "DELETE",
      url: `/v1/tenants/${id}`,
      headers: { authorization: `Bearer ${t}`, "idempotency-key": "d4" },
    });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.details.active_wabas).toBe(1);
  });
});

describe("auth básica", () => {
  it("rejeita sem token", async () => {
    const r = await app.inject({ method: "GET", url: "/v1/tenants" });
    expect(r.statusCode).toBe(401);
  });
});
