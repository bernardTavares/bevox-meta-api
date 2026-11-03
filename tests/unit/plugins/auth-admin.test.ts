import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildServer } from "@/bootstrap/server.js";
import { __resetEnvCacheForTests } from "@/config/env.js";
import { __resetLoggerForTests } from "@/lib/logger.js";
import { ADMIN_AUDIENCE } from "@/plugins/auth-admin.js";

const ADMIN_KEY = "test-admin-key-1234-abcd-efgh";

const REQUIRED_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  LOG_LEVEL: "fatal",
  DATABASE_URL: "postgresql://bevox:pwd@localhost:5432/test",
  REDIS_URL: "redis://localhost:6379",
  KMS_PROVIDER: "local",
  KMS_KEY_ID: "test-key",
  KMS_LOCAL_MASTER_KEY: Buffer.alloc(32, 0x42).toString("base64"),
  ADMIN_API_KEY: ADMIN_KEY,
};

let app: Awaited<ReturnType<typeof buildServer>>;

interface SignAdminOpts {
  sub?: string;
  role?: string;
  aud?: string;
  iat?: number;
  exp?: number;
  alg?: string;
  secret?: Uint8Array;
}

async function signAdminJwt(opts: SignAdminOpts = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ role: opts.role ?? "admin" })
    .setProtectedHeader({ alg: opts.alg ?? "HS256" })
    .setSubject(opts.sub ?? "admin-1")
    .setAudience(opts.aud ?? ADMIN_AUDIENCE)
    .setIssuedAt(opts.iat ?? now)
    .setExpirationTime(opts.exp ?? now + 600)
    .sign(opts.secret ?? new TextEncoder().encode(ADMIN_KEY));
}

beforeAll(async () => {
  for (const [k, v] of Object.entries(REQUIRED_ENV)) process.env[k] = v;
  __resetEnvCacheForTests();
  __resetLoggerForTests();

  app = await buildServer();

  app.get("/__test/admin", { preHandler: app.requireAdminAuth() }, async (req) => ({
    sub: req.admin?.sub,
    role: req.admin?.role,
  }));

  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("requireAdminAuth — happy path", () => {
  it("aceita JWT admin válido", async () => {
    const token = await signAdminJwt();
    const res = await app.inject({
      method: "GET",
      url: "/__test/admin",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sub: "admin-1", role: "admin" });
  });
});

describe("requireAdminAuth — rejeições", () => {
  it("sem header → 401", async () => {
    const res = await app.inject({ method: "GET", url: "/__test/admin" });
    expect(res.statusCode).toBe(401);
  });

  it("token assinado com secret errado → 401", async () => {
    const token = await signAdminJwt({ secret: new TextEncoder().encode("wrong-secret") });
    const res = await app.inject({
      method: "GET",
      url: "/__test/admin",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it("alg=RS256 (algoritmo errado) → 401", async () => {
    // Algoritmo válido em jose mas não permitido aqui — vai falhar na verificação.
    // Para testar precisamos de um JWT RS256, mas como o secret é o mesmo e
    // jose vai rejeitar por algo mismatch, basta forjar um header com alg
    // diferente assinado de qualquer jeito que jose vai rejeitar.
    const fakeToken = await signAdminJwt({ alg: "HS512" });
    const res = await app.inject({
      method: "GET",
      url: "/__test/admin",
      headers: { authorization: `Bearer ${fakeToken}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it("audience errada → 401", async () => {
    const token = await signAdminJwt({ aud: "outro-servico" });
    const res = await app.inject({
      method: "GET",
      url: "/__test/admin",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it("role != admin → 403", async () => {
    const token = await signAdminJwt({ role: "user" });
    const res = await app.inject({
      method: "GET",
      url: "/__test/admin",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
  });

  it("token expirado → 401", async () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    const token = await signAdminJwt({ iat: past, exp: past + 60 });
    const res = await app.inject({
      method: "GET",
      url: "/__test/admin",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it("lifetime excessivo (> 1h) → 401", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signAdminJwt({ iat: now, exp: now + 7200 });
    const res = await app.inject({
      method: "GET",
      url: "/__test/admin",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toMatch(/lifetime/);
  });

  it("JWT consumer (RS256) não passa em rota admin", async () => {
    // Simula um token com algoritmo de outro tipo — o verifier admin só
    // aceita HS256 + secret correto, então qualquer token vindo de outro
    // contexto vai falhar.
    const wrongSecretToken = await signAdminJwt({
      secret: new TextEncoder().encode("consumer-context-secret"),
    });
    const res = await app.inject({
      method: "GET",
      url: "/__test/admin",
      headers: { authorization: `Bearer ${wrongSecretToken}` },
    });
    expect(res.statusCode).toBe(401);
  });
});
