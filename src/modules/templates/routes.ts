import type { FastifyInstance } from "fastify";

import {
  createTemplateBodySchema,
  listTemplatesQuerySchema,
  templateParamsSchema,
  wabaParamsSchema,
} from "./schemas.js";
import {
  createTemplate,
  deleteTemplateAction,
  getTemplate,
  listTemplates,
  resyncTemplate,
} from "./service.js";

export async function templatesRoutes(app: FastifyInstance): Promise<void> {
  const baseUrl = "/v1/tenants/:tenant_id/wabas/:waba_id/templates";

  // ----- POST .../templates -----
  app.post(
    baseUrl,
    {
      preHandler: [
        app.requireAuth({ scopes: ["templates:write"] }),
        app.requireRateLimit(),
        app.requireIdempotency(),
      ],
    },
    async (req, reply) => {
      const { tenant_id, waba_id } = wabaParamsSchema.parse(req.params);
      const body = createTemplateBodySchema.parse(req.body);
      const out = await createTemplate({
        appId: req.auth!.appId,
        tenantId: tenant_id,
        wabaId: waba_id,
        body,
      });
      return reply.status(202).send(out);
    },
  );

  // ----- GET .../templates -----
  app.get(
    baseUrl,
    {
      preHandler: [app.requireAuth({ scopes: ["templates:read"] }), app.requireRateLimit()],
    },
    async (req) => {
      const { tenant_id, waba_id } = wabaParamsSchema.parse(req.params);
      const query = listTemplatesQuerySchema.parse(req.query);
      const items = await listTemplates({
        appId: req.auth!.appId,
        tenantId: tenant_id,
        wabaId: waba_id,
        filter: { status: query.status, language: query.language },
      });
      return { data: items };
    },
  );

  // ----- GET .../templates/:name/:language -----
  app.get(
    `${baseUrl}/:name/:language`,
    {
      preHandler: [app.requireAuth({ scopes: ["templates:read"] }), app.requireRateLimit()],
    },
    async (req) => {
      const { tenant_id, waba_id, name, language } = templateParamsSchema.parse(req.params);
      return getTemplate({
        appId: req.auth!.appId,
        tenantId: tenant_id,
        wabaId: waba_id,
        name,
        language,
      });
    },
  );

  // ----- POST .../templates/:name/:language/resync -----
  app.post(
    `${baseUrl}/:name/:language/resync`,
    {
      preHandler: [
        app.requireAuth({ scopes: ["templates:write"] }),
        app.requireRateLimit(),
        app.requireIdempotency(),
      ],
    },
    async (req) => {
      const { tenant_id, waba_id, name, language } = templateParamsSchema.parse(req.params);
      return resyncTemplate({
        appId: req.auth!.appId,
        tenantId: tenant_id,
        wabaId: waba_id,
        name,
        language,
      });
    },
  );

  // ----- DELETE .../templates/:name/:language -----
  app.delete(
    `${baseUrl}/:name/:language`,
    {
      preHandler: [
        app.requireAuth({ scopes: ["templates:write"] }),
        app.requireRateLimit(),
        app.requireIdempotency(),
      ],
    },
    async (req) => {
      const { tenant_id, waba_id, name, language } = templateParamsSchema.parse(req.params);
      return deleteTemplateAction({
        appId: req.auth!.appId,
        tenantId: tenant_id,
        wabaId: waba_id,
        name,
        language,
      });
    },
  );
}
