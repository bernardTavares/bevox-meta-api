import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildServer } from "@/bootstrap/server.js";
import { __resetEnvCacheForTests } from "@/config/env.js";
import { errors } from "@/lib/errors.js";
import { __resetLoggerForTests } from "@/lib/logger.js";

const DEV_MASTER_KEY = Buffer.alloc(32, 0x42).toString("base64");

const REQUIRED_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  DATABASE_URL: "postgresql://bevox:pwd@localhost:5432/bevox_meta_api_test",
  REDIS_URL: "redis://localhost:6379",
  KMS_PROVIDER: "local",
  KMS_KEY_ID: "test-key",
  KMS_LOCAL_MASTER_KEY: DEV_MASTER_KEY,
  ADMIN_API_KEY: "test-admin-key-1234",
};

let app: Awaited<ReturnType<typeof buildServer>>;

beforeAll(async () => {
  for (const [k, v] of Object.entries(REQUIRED_ENV)) {
    process.env[k] = v;
  }
  __resetEnvCacheForTests();
  __resetLoggerForTests();

  app = await buildServer();

  // Rota de teste para validar error handler com AppError.
  app.get("/__test/app-error", async () => {
    throw errors.notFound("Resource", "abc");
  });
  app.get("/__test/internal", async () => {
    throw new Error("boom");
  });

  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("buildServer — /healthz", () => {
  it("retorna 200 com status ok", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", build: "unknown" });
  });

  it("propaga x-request-id na resposta", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.headers["x-request-id"]).toBeDefined();
  });

  it("honra x-request-id do cliente quando enviado", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/healthz",
      headers: { "x-request-id": "client-trace-abc" },
    });
    expect(res.headers["x-request-id"]).toBe("client-trace-abc");
  });
});

describe("buildServer — error handler", () => {
  it("AppError NOT_FOUND vira 404 no formato canônico", async () => {
    const res = await app.inject({ method: "GET", url: "/__test/app-error" });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.message).toContain("Resource");
    expect(body.error.request_id).toBeTruthy();
    expect(body.error.details).toEqual({ resource: "Resource", id: "abc" });
  });

  it("Error não-AppError vira 500 INTERNAL sem expor mensagem interna", async () => {
    const res = await app.inject({ method: "GET", url: "/__test/internal" });
    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.error.code).toBe("INTERNAL");
    expect(body.error.message).toBe("Internal server error");
    expect(body.error.message).not.toContain("boom");
    expect(body.error.request_id).toBeTruthy();
  });

  it("rota inexistente retorna 404 no formato canônico", async () => {
    const res = await app.inject({ method: "GET", url: "/nada/aqui" });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.request_id).toBeTruthy();
  });
});

describe("buildServer — /metrics", () => {
  it("retorna métricas Prometheus em text/plain", async () => {
    // Faz uma request antes para popular contadores HTTP.
    await app.inject({ method: "GET", url: "/healthz" });
    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/plain/);
    expect(res.body).toContain("bevox_meta_api_http_requests_total");
    expect(res.body).toContain("bevox_meta_api_http_request_duration_seconds");
  });
});

describe("buildServer — security headers", () => {
  it("inclui headers do Helmet", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    // Headers principais setados pelo @fastify/helmet
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBeDefined();
    expect(res.headers["content-security-policy"]).toBeDefined();
  });
});
