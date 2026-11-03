/**
 * Service layer — Tenants.
 *
 * Toma decisões: existência, conflitos de unicidade, bloqueios de delete.
 * Repository faz queries cruas; route layer só valida + chama service.
 */

import type { Tenant } from "@db/schema/index.js";

import { errors } from "@/lib/errors.js";

import {
  countActiveBindings,
  findTenantByExternalId,
  findTenantById,
  insertTenant,
  listTenants as listTenantsRepo,
  softDeleteTenant,
  updateTenant,
  type ListTenantsParams,
} from "./repository.js";
import type { TenantResponse } from "./schemas.js";

function toResponse(t: Tenant): TenantResponse {
  return {
    id: t.id,
    external_id: t.externalId,
    display_name: t.displayName,
    status: t.status,
    metadata: (t.metadataJson ?? {}) as Record<string, unknown>,
    created_at: t.createdAt.toISOString(),
    updated_at: t.updatedAt.toISOString(),
    deleted_at: t.deletedAt?.toISOString() ?? null,
  };
}

export async function createTenant(input: {
  appId: string;
  externalId?: string;
  displayName: string;
  metadata?: Record<string, unknown>;
}): Promise<TenantResponse> {
  if (input.externalId) {
    const existing = await findTenantByExternalId(input.appId, input.externalId);
    if (existing) {
      throw errors.conflict("tenant with same external_id already exists", {
        external_id: input.externalId,
        existing_tenant_id: existing.id,
      });
    }
  }

  const row = await insertTenant({
    appId: input.appId,
    externalId: input.externalId ?? null,
    displayName: input.displayName,
    metadata: input.metadata ?? {},
  });
  return toResponse(row);
}

export async function getTenant(appId: string, tenantId: string): Promise<TenantResponse> {
  const row = await findTenantById(appId, tenantId);
  if (!row) throw errors.notFound("tenant", tenantId);
  return toResponse(row);
}

export async function listTenants(
  params: ListTenantsParams,
): Promise<{ items: TenantResponse[]; nextCursor: string | null }> {
  const rows = await listTenantsRepo(params);
  const nextCursor = rows.length === params.limit ? (rows[rows.length - 1]!.id ?? null) : null;
  return {
    items: rows.map(toResponse),
    nextCursor,
  };
}

export async function patchTenant(
  appId: string,
  tenantId: string,
  patch: {
    displayName?: string;
    metadata?: Record<string, unknown>;
    status?: "active" | "disabled";
  },
): Promise<TenantResponse> {
  const row = await updateTenant(appId, tenantId, patch);
  if (!row) throw errors.notFound("tenant", tenantId);
  return toResponse(row);
}

export async function deleteTenant(appId: string, tenantId: string): Promise<TenantResponse> {
  const existing = await findTenantById(appId, tenantId);
  if (!existing) throw errors.notFound("tenant", tenantId);
  if (existing.deletedAt !== null) {
    throw errors.conflict("tenant already deleted", { tenant_id: tenantId });
  }

  const counts = await countActiveBindings(appId, tenantId);
  if (counts.wabas > 0 || counts.igs > 0) {
    throw errors.conflict("tenant has active Meta bindings; disconnect them first", {
      tenant_id: tenantId,
      active_wabas: counts.wabas,
      active_igs: counts.igs,
    });
  }

  const row = await softDeleteTenant(appId, tenantId);
  if (!row) {
    // Race: alguém deletou no meio do caminho. Retornamos o estado existente.
    throw errors.conflict("tenant state changed concurrently", { tenant_id: tenantId });
  }
  return toResponse(row);
}
