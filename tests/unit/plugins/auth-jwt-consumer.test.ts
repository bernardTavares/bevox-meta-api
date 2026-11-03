import { generateKeyPairSync } from "node:crypto";

import { SignJWT, importPKCS8 } from "jose";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { buildServer } from "@/bootstrap/server.js";
import { __resetEnvCacheForTests } from "@/config/env.js";
import { __resetLoggerForTests } from "@/lib/logger.js";
import { uuidv7 } from "@/lib/uuid.js";

// ---------------------------------------------------------------------------
// Setup: env, mocks dos módulos que tocam Redis/DB.
// ---------------------------------------------------------------------------

const DEV_MASTER_KEY = Buffer.alloc(32, 0x42).toString("base64");

const REQUIRED_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  LOG_LEVEL: "fatal",
  DATABASE_URL: "postgresql://bevox:pwd@localhost:5432/test",
  REDIS_URL: "redis://localhost:6379",
  KMS_PROVIDER: "local",
  KMS_KEY_ID: "test-key",
  KMS_LOCAL_MASTER_KEY: DEV_MASTER_KEY,
  ADMIN_API_KEY: "test-admin-key-1234",
  JWT_AUDIENCE: "bevox-meta-api",
  JWT_MAX_AGE_SECONDS: "300",
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

const repoState = {
  app: null as null | { id: string; status: "active" | "deactivated" },
  appKey: null as null | {
    id: string;
    appId: string;
    publicKeyPem: string;
    validFrom: Date;
    validUntil: Date | null;
  },
};

vi.mock("@/modules/apps/repository.js", () => ({
  findConsumerAppById: vi.fn(async (id: string) => {
    if (repoState.app?.id === id) return { ...repoState.app };
    return null;
  }),
  findActiveAppKey: vi.fn(async (appId: string, keyId: string) => {
    const k = repoState.appKey;
    if (!k) return null;
    if (k.appId !== appId || k.id !== keyId) return null;
    const now = new Date();
    if (k.validFrom > now) return null;
    if (k.validUntil !== null && k.validUntil <= now) return null;
    return { ...k, algo: "RS256" as const, rotatedAt: null, createdAt: now };
  }),
}));

// ---------------------------------------------------------------------------
// Fixtures: par RSA + helpers de assinatura
// ---------------------------------------------------------------------------

const APP_ID = uuidv7();
const KEY_ID = uuidv7();

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_PKCS8 = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const PUBLIC_SPKI = publicKey.export({ type: "spki", format: "pem" }).toString();

let signingKey: Awaited<ReturnType<typeof importPKCS8>>;

interface SignOpts {
  iss?: string;
  aud?: string | string[];
  kid?: string;
  scope?: string;
  iat?: number;
  exp?: number;
  alg?: string;
}

async function signJwt(opts: SignOpts = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ scope: opts.scope ?? "messages:write tenants:read" })
    .setProtectedHeader({ alg: opts.alg ?? "RS256", kid: opts.kid ?? KEY_ID })
    .setIssuer(opts.iss ?? APP_ID)
    .setAudience(opts.aud ?? "bevox-meta-api")
    .setIssuedAt(opts.iat ?? now)
    .setExpirationTime(opts.exp ?? now + 60)
    .sign(signingKey);
}

// ---------------------------------------------------------------------------
// Boot server
// ---------------------------------------------------------------------------

let app: Awaited<ReturnType<typeof buildServer>>;

beforeAll(async () => {
  for (const [k, v] of Object.entries(REQUIRED_ENV)) process.env[k] = v;
  __resetEnvCacheForTests();
  __resetLoggerForTests();

  signingKey = await importPKCS8(PRIVATE_PKCS8, "RS256");

  app = await buildServer();

  app.get(
    "/__test/protected",
    { preHandler: app.requireAuth({ scopes: ["messages:write"] }) },
    async (req) => ({ appId: req.auth?.appId, scopes: req.auth?.scopes }),
  );

  app.get("/__test/open", { preHandler: app.requireAuth() }, async (req) => ({
    appId: req.auth?.appId,
  }));

  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  fakeRedisStore.clear();
  repoState.app = { id: APP_ID, status: "active" };
  repoState.appKey = {
    id: KEY_ID,
    appId: APP_ID,
    publicKeyPem: PUBLIC_SPKI,
    validFrom: new Date(Date.now() - 60_000),
    validUntil: null,
  };
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("requireAuth — caminho feliz", () => {
  it("aceita JWT bem formado e popula request.auth", async () => {
    const token = await signJwt();
    const res = await app.inject({
      method: "GET",
      url: "/__test/protected",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      appId: APP_ID,
      scopes: ["messages:write", "tenants:read"],
    });
  });

  it("scopes desconhecidos no claim são silenciosamente descartados", async () => {
    const token = await signJwt({ scope: "messages:write coisa-aleatoria" });
    const res = await app.inject({
      method: "GET",
      url: "/__test/protected",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().scopes).toEqual(["messages:write"]);
  });
});

describe("requireAuth — header malformado", () => {
  it("sem Authorization → 401", async () => {
    const res = await app.inject({ method: "GET", url: "/__test/open" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("UNAUTHENTICATED");
  });

  it("Authorization sem Bearer → 401", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/__test/open",
      headers: { authorization: "Basic xxx" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("token vazio → 401", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/__test/open",
      headers: { authorization: "Bearer " },
    });
    expect(res.statusCode).toBe(401);
  });

  it("JWT malformado → 401", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/__test/open",
      headers: { authorization: "Bearer not.a.jwt" },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("requireAuth — claims/header inválidos", () => {
  it("alg HS256 é rejeitado (proteção contra confusion)", async () => {
    // Constrói manualmente um JWT HS256 com uma chave qualquer.
    const fakeToken = await new SignJWT({ scope: "messages:write" })
      .setProtectedHeader({ alg: "HS256", kid: KEY_ID })
      .setIssuer(APP_ID)
      .setAudience("bevox-meta-api")
      .setIssuedAt()
      .setExpirationTime("1m")
      .sign(new Uint8Array(32));
    const res = await app.inject({
      method: "GET",
      url: "/__test/open",
      headers: { authorization: `Bearer ${fakeToken}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toMatch(/RS256/);
  });

  it("kid ausente → 401", async () => {
    // Sign sem kid no header.
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(APP_ID)
      .setAudience("bevox-meta-api")
      .setIssuedAt()
      .setExpirationTime("1m")
      .sign(signingKey);
    const res = await app.inject({
      method: "GET",
      url: "/__test/open",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toMatch(/kid/i);
  });

  it("iss não-UUID → 401", async () => {
    const token = await signJwt({ iss: "not-a-uuid" });
    const res = await app.inject({
      method: "GET",
      url: "/__test/open",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it("aud incorreta → 401", async () => {
    const token = await signJwt({ aud: "outro-servico" });
    const res = await app.inject({
      method: "GET",
      url: "/__test/open",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it("exp - iat > JWT_MAX_AGE_SECONDS → 401", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signJwt({ iat: now, exp: now + 600 });
    const res = await app.inject({
      method: "GET",
      url: "/__test/open",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toMatch(/lifetime/);
  });

  it("token expirado → 401", async () => {
    const past = Math.floor(Date.now() / 1000) - 600;
    const token = await signJwt({ iat: past, exp: past + 60 });
    const res = await app.inject({
      method: "GET",
      url: "/__test/open",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("requireAuth — chaves e issuer", () => {
  it("kid revogado (não está em app_keys) → 401", async () => {
    const token = await signJwt({ kid: uuidv7() });
    const res = await app.inject({
      method: "GET",
      url: "/__test/open",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toMatch(/Unknown or revoked kid/);
  });

  it("app desativado → 401", async () => {
    repoState.app = { id: APP_ID, status: "deactivated" };
    const token = await signJwt();
    const res = await app.inject({
      method: "GET",
      url: "/__test/open",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it("kid expirado (validUntil < now) → 401", async () => {
    repoState.appKey!.validUntil = new Date(Date.now() - 1000);
    const token = await signJwt();
    const res = await app.inject({
      method: "GET",
      url: "/__test/open",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("requireAuth — scopes", () => {
  it("token sem scope necessário → 403 FORBIDDEN", async () => {
    const token = await signJwt({ scope: "tenants:read" });
    const res = await app.inject({
      method: "GET",
      url: "/__test/protected",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
  });

  it("rota sem scope obrigatório aceita qualquer token válido", async () => {
    const token = await signJwt({ scope: "" });
    const res = await app.inject({
      method: "GET",
      url: "/__test/open",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("requireAuth — cache Redis", () => {
  it("hit em cache evita lookup repetido na DB", async () => {
    const repo = await import("@/modules/apps/repository.js");
    const findKeySpy = vi.mocked(repo.findActiveAppKey);
    const findAppSpy = vi.mocked(repo.findConsumerAppById);

    const token1 = await signJwt();
    await app.inject({
      method: "GET",
      url: "/__test/open",
      headers: { authorization: `Bearer ${token1}` },
    });
    const callsAfterFirst = {
      key: findKeySpy.mock.calls.length,
      app: findAppSpy.mock.calls.length,
    };

    const token2 = await signJwt();
    await app.inject({
      method: "GET",
      url: "/__test/open",
      headers: { authorization: `Bearer ${token2}` },
    });

    expect(findKeySpy.mock.calls.length).toBe(callsAfterFirst.key);
    expect(findAppSpy.mock.calls.length).toBe(callsAfterFirst.app);
  });
});
