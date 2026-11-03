/**
 * Unit tests for `buildRequestSerializer()`.
 *
 * Garante que o serializer Pino customizado do bevox-meta-api:
 *  - remove query string completa para rotas /v1/oauth/{waba,ig}/callback
 *    (anti-leak de OAuth `code`/`state`/`error_description`);
 *  - preserva URL com query para rotas não-sensíveis (telemetria normal);
 *  - emite a estrutura canônica Pino { method, url, request_id?, route?,
 *    remoteAddress?, remotePort? } reusada por server.ts.
 */

import { describe, expect, it } from "vitest";

import { buildRequestSerializer } from "@/bootstrap/logger.js";

function fakeReq(
  over: Partial<{
    method: string;
    url: string;
    id: string;
    routeOptions: { url: string };
    ip: string;
    socket: { remotePort: number };
  }> = {},
): unknown {
  return {
    method: over.method ?? "GET",
    url: over.url ?? "/healthz",
    id: over.id ?? "req-abc",
    routeOptions: over.routeOptions,
    ip: over.ip,
    socket: over.socket,
    // Fastify req has many fields; serializer should only touch a few.
  };
}

describe("buildRequestSerializer — OAuth callback rotas", () => {
  const serialize = buildRequestSerializer();

  it("remove query string para /v1/oauth/waba/callback (code/state)", () => {
    const out = serialize(
      fakeReq({
        url: "/v1/oauth/waba/callback?code=SECRET_CODE&state=SECRET_STATE",
        routeOptions: { url: "/v1/oauth/waba/callback" },
      }) as never,
    );
    expect(out.url).toBe("/v1/oauth/waba/callback");
    expect(JSON.stringify(out)).not.toContain("SECRET_CODE");
    expect(JSON.stringify(out)).not.toContain("SECRET_STATE");
  });

  it("remove query string para /v1/oauth/ig/callback (code/state)", () => {
    const out = serialize(
      fakeReq({
        url: "/v1/oauth/ig/callback?code=IG_SECRET&state=IG_STATE&error_description=foo",
        routeOptions: { url: "/v1/oauth/ig/callback" },
      }) as never,
    );
    expect(out.url).toBe("/v1/oauth/ig/callback");
    expect(JSON.stringify(out)).not.toContain("IG_SECRET");
    expect(JSON.stringify(out)).not.toContain("IG_STATE");
    expect(JSON.stringify(out)).not.toContain("error_description");
  });

  it("redija mesmo quando routeOptions não está disponível (url-based match)", () => {
    const out = serialize(
      fakeReq({
        url: "/v1/oauth/waba/callback?code=X&state=Y",
        // sem routeOptions (ex: 404, hook onRequest antes do roteamento)
      }) as never,
    );
    expect(out.url).toBe("/v1/oauth/waba/callback");
    expect(JSON.stringify(out)).not.toContain("code=X");
    expect(JSON.stringify(out)).not.toContain("state=Y");
  });
});

describe("buildRequestSerializer — outras rotas", () => {
  const serialize = buildRequestSerializer();

  it("preserva URL completa para rota não-OAuth com query", () => {
    const out = serialize(
      fakeReq({
        url: "/v1/tenants/abc/wabas?include_disconnected=true",
        routeOptions: { url: "/v1/tenants/:tenant_id/wabas" },
      }) as never,
    );
    expect(out.url).toBe("/v1/tenants/abc/wabas?include_disconnected=true");
  });

  it("preserva URL para rota sem query string", () => {
    const out = serialize(
      fakeReq({
        url: "/healthz",
        routeOptions: { url: "/healthz" },
      }) as never,
    );
    expect(out.url).toBe("/healthz");
  });

  it("emite method + url no shape Pino canônico", () => {
    const out = serialize(
      fakeReq({
        method: "POST",
        url: "/v1/tenants",
        routeOptions: { url: "/v1/tenants" },
      }) as never,
    );
    expect(out.method).toBe("POST");
    expect(out.url).toBe("/v1/tenants");
  });
});
