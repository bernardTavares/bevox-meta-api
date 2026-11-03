/**
 * Rotas HTTP do módulo Tenants — PRD §9.
 *
 * Todas as rotas exigem JWT consumer (requireAuth + scope tenants:read|write).
 * Mutações exigem Idempotency-Key (requireIdempotency) e estão sujeitas a
 * rate limit app-level.
 */

import type { FastifyInstance } from "fastify";

import {
  createTenantBodySchema,
  listTenantsQuerySchema,
  tenantIdParamSchema,
  updateTenantBodySchema,
} from "./schemas.js";
import { createTenant, deleteTenant, getTenant, listTenants, patchTenant } from "./service.js";

export async function tenantsRoutes(app: FastifyInstance): Promise<void> {
  // ----- POST /v1/tenants -----
  app.post(
    "/v1/tenants",
    {
      preHandler: [
        app.requireAuth({ scopes: ["tenants:write"] }),
        app.requireRateLimit(),
        app.requireIdempotency(),
      ],
    },
    async (req, reply) => {
      const body = createTenantBodySchema.parse(req.body);
      const tenant = await createTenant({
        appId: req.auth!.appId,
        externalId: body.external_id,
        displayName: body.display_name,
        metadata: body.metadata,
      });
      return reply.status(201).send(tenant);
    },
  );

  // ----- GET /v1/tenants -----
  app.get(
    "/v1/tenants",
    {
      preHandler: [app.requireAuth({ scopes: ["tenants:read"] }), app.requireRateLimit()],
    },
    async (req) => {
      const query = listTenantsQuerySchema.parse(req.query);
      const result = await listTenants({
        appId: req.auth!.appId,
        cursor: query.cursor,
        limit: query.limit,
        externalId: query.external_id,
        includeDeleted: query.include_deleted,
      });
      return {
        data: result.items,
        next_cursor: result.nextCursor,
      };
    },
  );

  // ----- GET /v1/tenants/:tenant_id -----
  app.get(
    "/v1/tenants/:tenant_id",
    {
      preHandler: [app.requireAuth({ scopes: ["tenants:read"] }), app.requireRateLimit()],
    },
    async (req) => {
      const { tenant_id } = tenantIdParamSchema.parse(req.params);
      return getTenant(req.auth!.appId, tenant_id);
    },
  );

  // ----- PATCH /v1/tenants/:tenant_id -----
  app.patch(
    "/v1/tenants/:tenant_id",
    {
      preHandler: [
        app.requireAuth({ scopes: ["tenants:write"] }),
        app.requireRateLimit(),
        app.requireIdempotency(),
      ],
    },
    async (req) => {
      const { tenant_id } = tenantIdParamSchema.parse(req.params);
      const body = updateTenantBodySchema.parse(req.body);
      return patchTenant(req.auth!.appId, tenant_id, {
        displayName: body.display_name,
        metadata: body.metadata,
        status: body.status,
      });
    },
  );

  // ----- DELETE /v1/tenants/:tenant_id (soft-delete) -----
  app.delete(
    "/v1/tenants/:tenant_id",
    {
      preHandler: [
        app.requireAuth({ scopes: ["tenants:write"] }),
        app.requireRateLimit(),
        app.requireIdempotency(),
      ],
    },
    async (req) => {
      const { tenant_id } = tenantIdParamSchema.parse(req.params);
      return deleteTenant(req.auth!.appId, tenant_id);
    },
  );
}
