/**
 * Integration: verifica que o serializer `buildRequestSerializer()` quando
 * plugado em uma instância Fastify (mesmo shape que `buildServer()` usa
 * em `src/bootstrap/server.ts`) efetivamente redija a query string das
 * rotas OAuth callback nos logs do Pino.
 *
 * Este teste é o backstop para regressão: se alguém remover o
 * `serializers.req` do `buildServer`, o serializer customizado deixa de
 * ser aplicado e a regressão aparece aqui.
 *
 * Não usamos `buildServer()` diretamente porque ele lê env vars
 * obrigatórias (DATABASE_URL, KMS_*) e instala plugins (auth, idempotency,
 * audit) irrelevantes a este escopo. Reproduzimos APENAS o pedaço de
 * `logger` config para isolar a verificação.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fastify, { type FastifyInstance } from "fastify";

import { buildRequestSerializer } from "@/bootstrap/logger.js";

type LogRecord = Record<string, unknown>;

function makeCaptureStream(): { stream: { write: (chunk: string) => void }; records: LogRecord[] } {
  const records: LogRecord[] = [];
  return {
    stream: {
      write(chunk: string) {
        for (const line of chunk.split("\n")) {
          if (line.trim().length === 0) continue;
          try {
            records.push(JSON.parse(line) as LogRecord);
          } catch {
            // ignore non-JSON lines (test transport)
          }
        }
      },
    },
    records,
  };
}

let app: FastifyInstance;
let capture: ReturnType<typeof makeCaptureStream>;

beforeEach(async () => {
  capture = makeCaptureStream();
  app = fastify({
    logger: {
      level: "info",
      redact: {
        paths: ["code", "state", "error_description", "*.code", "*.state", "*.error_description"],
        censor: "[REDACTED]",
      },
      serializers: {
        req: buildRequestSerializer(),
      },
      stream: capture.stream,
    },
  });

  app.get("/v1/oauth/waba/callback", async () => ({ ok: true }));
  app.get("/v1/oauth/ig/callback", async () => ({ ok: true }));
  app.get("/v1/tenants/:tenant_id/wabas", async () => ({ ok: true }));
  app.get("/healthz", async () => ({ ok: true }));

  await app.ready();
});

afterEach(async () => {
  await app.close();
});

function findReqLogFor(records: LogRecord[], routeHint: string): LogRecord | undefined {
  return records.find((r) => {
    const req = r.req as { url?: string } | undefined;
    return req !== undefined && typeof req.url === "string" && req.url.includes(routeHint);
  });
}

describe("Fastify request log — OAuth callback rotas (achado C1)", () => {
  it("GET /v1/oauth/waba/callback NÃO loga code/state em req.url", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/oauth/waba/callback?code=AUTH_CODE_LEAK&state=STATE_LEAK",
    });
    expect(res.statusCode).toBe(200);

    const dump = JSON.stringify(capture.records);
    expect(dump).not.toContain("AUTH_CODE_LEAK");
    expect(dump).not.toContain("STATE_LEAK");

    const reqLog = findReqLogFor(capture.records, "/v1/oauth/waba/callback");
    expect(reqLog).toBeDefined();
    const req = reqLog!.req as { url: string };
    expect(req.url).toBe("/v1/oauth/waba/callback");
    expect(req.url).not.toContain("?");
  });

  it("GET /v1/oauth/ig/callback NÃO loga code/state/error_description em req.url", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/oauth/ig/callback?code=IG_LEAK&state=IG_STATE_LEAK&error_description=IG_ERR_LEAK",
    });
    expect(res.statusCode).toBe(200);

    const dump = JSON.stringify(capture.records);
    expect(dump).not.toContain("IG_LEAK");
    expect(dump).not.toContain("IG_STATE_LEAK");
    expect(dump).not.toContain("IG_ERR_LEAK");

    const reqLog = findReqLogFor(capture.records, "/v1/oauth/ig/callback");
    expect(reqLog).toBeDefined();
    const req = reqLog!.req as { url: string };
    expect(req.url).toBe("/v1/oauth/ig/callback");
  });
});

describe("Fastify request log — regressão: rotas não-sensíveis continuam logadas", () => {
  it("GET /v1/tenants/:id/wabas?include_disconnected=true preserva query string", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/tenants/abc/wabas?include_disconnected=true",
    });
    expect(res.statusCode).toBe(200);

    const reqLog = findReqLogFor(capture.records, "/v1/tenants/abc/wabas");
    expect(reqLog).toBeDefined();
    const req = reqLog!.req as { url: string };
    expect(req.url).toBe("/v1/tenants/abc/wabas?include_disconnected=true");
  });

  it("GET /healthz preserva URL e shape canônico (method, url)", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);

    const reqLog = findReqLogFor(capture.records, "/healthz");
    expect(reqLog).toBeDefined();
    const req = reqLog!.req as { method: string; url: string };
    expect(req.method).toBe("GET");
    expect(req.url).toBe("/healthz");
  });
});
