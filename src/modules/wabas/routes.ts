import type { FastifyInstance } from "fastify";

import { takeOAuthState } from "./oauth-state.js";
import {
  embeddedSignupCompleteBodySchema,
  initOAuthBodySchema,
  listWabasQuerySchema,
  oauthCallbackQuerySchema,
  tenantIdParamSchema,
  wabaIdParamSchema,
} from "./schemas.js";
import {
  completeEmbeddedSignup,
  disconnectWaba,
  handleWabaCallback,
  initWabaOAuth,
  listWabas,
} from "./service.js";

export async function wabasRoutes(app: FastifyInstance): Promise<void> {
  // ----- POST /v1/tenants/:tenant_id/wabas/connect/init -----
  app.post(
    "/v1/tenants/:tenant_id/wabas/connect/init",
    {
      preHandler: [
        app.requireAuth({ scopes: ["wabas:write"] }),
        app.requireRateLimit(),
        app.requireIdempotency(),
      ],
    },
    async (req) => {
      const { tenant_id } = tenantIdParamSchema.parse(req.params);
      const body = initOAuthBodySchema.parse(req.body);
      return initWabaOAuth({
        appId: req.auth!.appId,
        tenantId: tenant_id,
        redirectUrl: body.redirect_url,
      });
    },
  );

  // ----- POST /v1/tenants/:tenant_id/wabas/connect/complete (Embedded Signup) -----
  app.post(
    "/v1/tenants/:tenant_id/wabas/connect/complete",
    {
      preHandler: [
        app.requireAuth({ scopes: ["wabas:write"] }),
        app.requireRateLimit(),
        app.requireIdempotency(),
      ],
    },
    async (req) => {
      const { tenant_id } = tenantIdParamSchema.parse(req.params);
      const body = embeddedSignupCompleteBodySchema.parse(req.body);
      return completeEmbeddedSignup({
        appId: req.auth!.appId,
        tenantId: tenant_id,
        code: body.code,
        wabaIdHint: body.waba_id,
        phoneNumberIdHint: body.phone_number_id,
        businessIdHint: body.business_id,
        coexistence: body.coexistence,
      });
    },
  );

  // ----- GET /v1/oauth/waba/callback (público, validado por state) -----
  app.get("/v1/oauth/waba/callback", async (req, reply) => {
    const query = oauthCallbackQuerySchema.parse(req.query);

    // Logging defensivo (achado C1): a query string foi removida do log
    // padrão do Fastify pelo serializer customizado. Aqui logamos apenas
    // o que é seguro/útil para debugging — request_id, fato de ter code,
    // presença de error. NUNCA logar `code` ou `state` em claro.
    req.log.info(
      {
        route: "/v1/oauth/waba/callback",
        has_code: typeof query.code === "string" && query.code.length > 0,
        has_error: typeof query.error === "string",
      },
      "oauth.waba.callback.received",
    );

    // Usuário cancelou ou Meta rejeitou — consumir state e redirecionar
    // para o redirect_url do consumer com flag de erro.
    if (query.error || !query.code) {
      const payload = await takeOAuthState(query.state);
      if (!payload) {
        return reply.status(400).send({
          error: {
            code: "INVALID_INPUT",
            message: "Invalid or expired OAuth state",
            request_id: req.id,
          },
        });
      }
      const url = new URL(payload.redirect_url);
      url.searchParams.set("success", "false");
      url.searchParams.set("error", query.error ?? "missing_code");
      if (query.error_description) {
        url.searchParams.set("error_description", query.error_description);
      }
      return reply.redirect(url.toString(), 302);
    }

    const result = await handleWabaCallback({ code: query.code, state: query.state });
    return reply.redirect(result.redirectUrl, 302);
  });

  // ----- GET /v1/tenants/:tenant_id/wabas -----
  app.get(
    "/v1/tenants/:tenant_id/wabas",
    {
      preHandler: [app.requireAuth({ scopes: ["wabas:read"] }), app.requireRateLimit()],
    },
    async (req) => {
      const { tenant_id } = tenantIdParamSchema.parse(req.params);
      const query = listWabasQuerySchema.parse(req.query);
      const items = await listWabas(req.auth!.appId, tenant_id, query.include_disconnected);
      return { data: items };
    },
  );

  // ----- DELETE /v1/tenants/:tenant_id/wabas/:waba_id -----
  app.delete(
    "/v1/tenants/:tenant_id/wabas/:waba_id",
    {
      preHandler: [
        app.requireAuth({ scopes: ["wabas:write"] }),
        app.requireRateLimit(),
        app.requireIdempotency(),
      ],
    },
    async (req) => {
      const { tenant_id, waba_id } = wabaIdParamSchema.parse(req.params);
      return disconnectWaba(req.auth!.appId, tenant_id, waba_id);
    },
  );
}
