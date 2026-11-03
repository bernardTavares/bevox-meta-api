import { generateKeyPairSync } from "node:crypto";

import { SignJWT, importPKCS8 } from "jose";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { buildServer } from "@/bootstrap/server.js";
import { __resetEnvCacheForTests } from "@/config/env.js";
import { __resetLoggerForTests } from "@/lib/logger.js";
import { uuidv7 } from "@/lib/uuid.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

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

const fakeRedisStore = new Map<string, { value: string; expiresAt: number }>();

vi.mock("@/lib/redis.js", () => {
  const get = vi.fn(async (key: string) => {
    const entry = fakeRedisStore.get(key);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      fakeRedisStore.delete(key);
      return null;
    }
    return entry.value;
  });
  const set = vi.fn(async (key: string, value: string, _mode: string, ttl: number) => {
    fakeRedisStore.set(key, { value, expiresAt: Date.now() + ttl * 1000 });
    return "OK";
  });
  const fakeClient = { get, set, ping: async () => "PONG", quit: async () => "OK" };
  return {
    getRedis: () => fakeClient,
    closeRedis: async () => {
      // no-op
    },
    createBullMQConnection: () => fakeClient,
  };
});

const APP_ID = uuidv7();
const KEY_ID = uuidv7();

// Auth mock — sempre retorna o mesmo app/key.
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

// Idempotency repository — em-memória, controlável pelos tests.
// vi.mock é içado para o topo, então spy + store precisam viver em vi.hoisted.
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

const idemStore = idem.store;
const saveRecordSpy = idem.saveRecordSpy;

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

let app: Awaited<ReturnType<typeof buildServer>>;
let signingKey: Awaited<ReturnType<typeof importPKCS8>>;

let handlerCallCount = 0;

async function bearerToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ scope: "messages:write" })
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

  app.post(
    "/__test/mutate",
    {
      preHandler: [app.requireAuth({ scopes: ["messages:write"] }), app.requireIdempotency()],
    },
    async (req) => {
      handlerCallCount++;
      return { ok: true, echo: req.body, n: handlerCallCount };
    },
  );

  // GET sem idempotency: idempotency é no-op.
  app.get("/__test/get", { preHandler: app.requireAuth() }, async () => ({ status: "ok" }));

  // Rota que sempre falha — usada no teste de "não persiste em erro".
  app.post(
    "/__test/fail",
    {
      preHandler: [app.requireAuth({ scopes: ["messages:write"] }), app.requireIdempotency()],
    },
    async () => {
      throw new Error("oops");
    },
  );

  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  idemStore.clear();
  handlerCallCount = 0;
  fakeRedisStore.clear();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("idempotency — header obrigatório em mutações", () => {
  it("POST sem Idempotency-Key → 400 INVALID_INPUT", async () => {
    const token = await bearerToken();
    const res = await app.inject({
      method: "POST",
      url: "/__test/mutate",
      headers: { authorization: `Bearer ${token}` },
      payload: { foo: "bar" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_INPUT");
  });

  it("POST com Idempotency-Key inválido (caracteres proibidos) → 400", async () => {
    const token = await bearerToken();
    const res = await app.inject({
      method: "POST",
      url: "/__test/mutate",
      headers: {
        authorization: `Bearer ${token}`,
        "idempotency-key": "key with spaces!",
      },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST com Idempotency-Key muito longo → 400", async () => {
    const token = await bearerToken();
    const res = await app.inject({
      method: "POST",
      url: "/__test/mutate",
      headers: {
        authorization: `Bearer ${token}`,
        "idempotency-key": "a".repeat(129),
      },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("idempotency — happy path", () => {
  it("primeira chamada executa e persiste record", async () => {
    const token = await bearerToken();
    const res = await app.inject({
      method: "POST",
      url: "/__test/mutate",
      headers: { authorization: `Bearer ${token}`, "idempotency-key": "k-1" },
      payload: { x: 1 },
    });
    expect(res.statusCode).toBe(200);
    expect(handlerCallCount).toBe(1);
    expect(saveRecordSpy).toHaveBeenCalledTimes(1);
  });

  it("replay com mesma key + mesmo body → não chama handler, retorna body cacheado + header idempotent-replay", async () => {
    const token1 = await bearerToken();
    await app.inject({
      method: "POST",
      url: "/__test/mutate",
      headers: { authorization: `Bearer ${token1}`, "idempotency-key": "k-replay" },
      payload: { x: 1 },
    });
    expect(handlerCallCount).toBe(1);

    const token2 = await bearerToken();
    const res2 = await app.inject({
      method: "POST",
      url: "/__test/mutate",
      headers: { authorization: `Bearer ${token2}`, "idempotency-key": "k-replay" },
      payload: { x: 1 },
    });
    expect(res2.statusCode).toBe(200);
    expect(res2.headers["idempotent-replay"]).toBe("true");
    expect(res2.json()).toMatchObject({ ok: true, echo: { x: 1 }, n: 1 });
    // Handler NÃO foi chamado de novo.
    expect(handlerCallCount).toBe(1);
  });

  it("replay com mesma key + body diferente → 422 IDEMPOTENCY_CONFLICT", async () => {
    // A12 fix (audit 2026-06-02): OpenAPI declara 422 para IdempotencyConflict
    // — antes o código emitia 409, quebrando clientes gerados a partir da spec.
    const token1 = await bearerToken();
    await app.inject({
      method: "POST",
      url: "/__test/mutate",
      headers: { authorization: `Bearer ${token1}`, "idempotency-key": "k-conflict" },
      payload: { x: 1 },
    });

    const token2 = await bearerToken();
    const res2 = await app.inject({
      method: "POST",
      url: "/__test/mutate",
      headers: { authorization: `Bearer ${token2}`, "idempotency-key": "k-conflict" },
      payload: { x: 2 },
    });
    expect(res2.statusCode).toBe(422);
    expect(res2.json().error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("keys distintas para bodies distintos não conflitam", async () => {
    const t1 = await bearerToken();
    const r1 = await app.inject({
      method: "POST",
      url: "/__test/mutate",
      headers: { authorization: `Bearer ${t1}`, "idempotency-key": "k-a" },
      payload: { x: 1 },
    });
    const t2 = await bearerToken();
    const r2 = await app.inject({
      method: "POST",
      url: "/__test/mutate",
      headers: { authorization: `Bearer ${t2}`, "idempotency-key": "k-b" },
      payload: { x: 2 },
    });
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(handlerCallCount).toBe(2);
  });
});

describe("idempotency — métodos não-mutadores", () => {
  it("GET não exige Idempotency-Key", async () => {
    const token = await bearerToken();
    const res = await app.inject({
      method: "GET",
      url: "/__test/get",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(saveRecordSpy).not.toHaveBeenCalled();
  });
});

describe("idempotency — não persiste em erro", () => {
  it("response 5xx não cria record (replay subsequente reexecuta)", async () => {
    const t1 = await bearerToken();
    const r1 = await app.inject({
      method: "POST",
      url: "/__test/fail",
      headers: { authorization: `Bearer ${t1}`, "idempotency-key": "k-fail" },
      payload: {},
    });
    expect(r1.statusCode).toBe(500);
    expect(saveRecordSpy).not.toHaveBeenCalled();
  });
});
