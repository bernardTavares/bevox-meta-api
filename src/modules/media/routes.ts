/**
 * GET /v1/media/:media_key — fetch de mídia inbound já baixada.
 *
 *   - Auth: JWT consumer com scope media:read.
 *   - Tenant-scoped via X-Tenant-Id (validado contra waba ativa do app).
 *   - 302 redirect para URL pré-assinada (TTL curto) se o objeto está no storage.
 *   - 202 { status: "processing" } se o worker media-download ainda não concluiu.
 *   - 400 INVALID_INPUT se media_key inválida; 403 FORBIDDEN se app↔tenant inválido.
 *
 * A URL pré-assinada NUNCA é logada (CLAUDE.md §5.4).
 */

import type { FastifyInstance } from "fastify";

import { mediaParamSchema, tenantHeaderSchema } from "./schemas.js";
import { resolveMedia } from "./service.js";

export async function mediaRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/v1/media/:media_key",
    {
      preHandler: [app.requireAuth({ scopes: ["media:read"] }), app.requireRateLimit()],
    },
    async (req, reply) => {
      const headers = tenantHeaderSchema.parse({
        "x-tenant-id": req.headers["x-tenant-id"],
      });
      const { media_key } = mediaParamSchema.parse(req.params);

      const result = await resolveMedia(req.auth!.appId, headers["x-tenant-id"], media_key);

      if (result.status === "ready") {
        // 302 para a URL pré-assinada. NÃO logar `result.url`.
        return reply.redirect(result.url, 302);
      }

      return reply.code(202).send({ status: "processing" });
    },
  );
}
