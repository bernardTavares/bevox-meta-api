import type { FastifyInstance } from "fastify";

import { takeOAuthState } from "@/modules/wabas/oauth-state.js";

import {
  igIdParamSchema,
  initOAuthBodySchema,
  listIgsQuerySchema,
  oauthCallbackQuerySchema,
  tenantIdParamSchema,
} from "./schemas.js";
import { disconnectIgConnection, handleIgCallback, initIgOAuth, listIgs } from "./service.js";

export async function igRoutes(app: FastifyInstance): Promise<void> {
  // ----- POST /v1/tenants/:tenant_id/ig-accounts/connect/init -----
  app.post(
    "/v1/tenants/:tenant_id/ig-accounts/connect/init",
    {
      preHandler: [
        app.requireAuth({ scopes: ["ig:write"] }),
        app.requireRateLimit(),
        app.requireIdempotency(),
      ],
    },
    async (req) => {
      const { tenant_id } = tenantIdParamSchema.parse(req.params);
      const body = initOAuthBodySchema.parse(req.body);
      return initIgOAuth({
        appId: req.auth!.appId,
        tenantId: tenant_id,
        redirectUrl: body.redirect_url,
      });
    },
  );

  // ----- GET /v1/oauth/ig/callback -----
  app.get("/v1/oauth/ig/callback", async (req, reply) => {
    const query = oauthCallbackQuerySchema.parse(req.query);

    // Logging defensivo (achado C1): a query string foi removida do log
    // padrão do Fastify pelo serializer customizado. Aqui logamos apenas
    // o que é seguro/útil para debugging — request_id, fato de ter code,
    // presença de error. NUNCA logar `code` ou `state` em claro.
    req.log.info(
      {
        route: "/v1/oauth/ig/callback",
        has_code: typeof query.code === "string" && query.code.length > 0,
        has_error: typeof query.error === "string",
      },
      "oauth.ig.callback.received",
    );

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

    const result = await handleIgCallback({ code: query.code, state: query.state });
    return reply.redirect(result.redirectUrl, 302);
  });

  // ----- GET /v1/tenants/:tenant_id/ig-accounts -----
  app.get(
    "/v1/tenants/:tenant_id/ig-accounts",
    {
      preHandler: [app.requireAuth({ scopes: ["ig:read"] }), app.requireRateLimit()],
    },
    async (req) => {
      const { tenant_id } = tenantIdParamSchema.parse(req.params);
      const query = listIgsQuerySchema.parse(req.query);
      const items = await listIgs(req.auth!.appId, tenant_id, query.include_disconnected);
      return { data: items };
    },
  );

  // ----- DELETE /v1/tenants/:tenant_id/ig-accounts/:ig_id -----
  app.delete(
    "/v1/tenants/:tenant_id/ig-accounts/:ig_id",
    {
      preHandler: [
        app.requireAuth({ scopes: ["ig:write"] }),
        app.requireRateLimit(),
        app.requireIdempotency(),
      ],
    },
    async (req) => {
      const { tenant_id, ig_id } = igIdParamSchema.parse(req.params);
      return disconnectIgConnection(req.auth!.appId, tenant_id, ig_id);
    },
  );
}
