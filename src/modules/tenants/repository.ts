/**
 * Repository Drizzle para tenants.
 *
 * Toda query é app_id-scoped (CLAUDE.md §5.3). NUNCA emitir SELECT sem
 * `WHERE app_id = ?`.
 */

import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";

import { igConnections, tenants, wabaConnections, type Tenant } from "@db/schema/index.js";

import { getDb } from "@/db/client.js";

export async function insertTenant(input: {
  appId: string;
  externalId: string | null;
  displayName: string;
  metadata: Record<string, unknown>;
}): Promise<Tenant> {
  const [row] = await getDb()
    .insert(tenants)
    .values({
      appId: input.appId,
      externalId: input.externalId,
      displayName: input.displayName,
      metadataJson: input.metadata,
    })
    .returning();
  return row!;
}

export async function findTenantById(appId: string, tenantId: string): Promise<Tenant | null> {
  const rows = await getDb()
    .select()
    .from(tenants)
    .where(and(eq(tenants.appId, appId), eq(tenants.id, tenantId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function findTenantByExternalId(
  appId: string,
  externalId: string,
): Promise<Tenant | null> {
  const rows = await getDb()
    .select()
    .from(tenants)
    .where(
      and(eq(tenants.appId, appId), eq(tenants.externalId, externalId), isNull(tenants.deletedAt)),
    )
    .limit(1);
  return rows[0] ?? null;
}

export interface ListTenantsParams {
  appId: string;
  cursor?: string;
  limit: number;
  externalId?: string;
  includeDeleted: boolean;
}

export async function listTenants(params: ListTenantsParams): Promise<Tenant[]> {
  const conds = [eq(tenants.appId, params.appId)];
  if (params.cursor) conds.push(gt(tenants.id, params.cursor));
  if (params.externalId) conds.push(eq(tenants.externalId, params.externalId));
  if (!params.includeDeleted) conds.push(isNull(tenants.deletedAt));

  return getDb()
    .select()
    .from(tenants)
    .where(and(...conds))
    .orderBy(asc(tenants.id))
    .limit(params.limit);
}

export async function updateTenant(
  appId: string,
  tenantId: string,
  patch: {
    displayName?: string;
    metadata?: Record<string, unknown>;
    status?: "active" | "disabled";
  },
): Promise<Tenant | null> {
  const setObj: Record<string, unknown> = { updatedAt: sql`now()` };
  if (patch.displayName !== undefined) setObj.displayName = patch.displayName;
  if (patch.metadata !== undefined) setObj.metadataJson = patch.metadata;
  if (patch.status !== undefined) setObj.status = patch.status;

  const [row] = await getDb()
    .update(tenants)
    .set(setObj)
    .where(and(eq(tenants.appId, appId), eq(tenants.id, tenantId), isNull(tenants.deletedAt)))
    .returning();
  return row ?? null;
}

export async function softDeleteTenant(appId: string, tenantId: string): Promise<Tenant | null> {
  const [row] = await getDb()
    .update(tenants)
    .set({
      deletedAt: sql`now()`,
      status: "deleted",
      updatedAt: sql`now()`,
    })
    .where(and(eq(tenants.appId, appId), eq(tenants.id, tenantId), isNull(tenants.deletedAt)))
    .returning();
  return row ?? null;
}

/**
 * Conta bindings ativos (não-disconnected) por tenant. Usado para bloquear
 * soft-delete enquanto há conexões Meta vivas.
 */
export async function countActiveBindings(
  appId: string,
  tenantId: string,
): Promise<{ wabas: number; igs: number }> {
  const db = getDb();
  const [wabaRow] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(wabaConnections)
    .where(
      and(
        eq(wabaConnections.appId, appId),
        eq(wabaConnections.tenantId, tenantId),
        isNull(wabaConnections.disconnectedAt),
      ),
    );
  const [igRow] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(igConnections)
    .where(
      and(
        eq(igConnections.appId, appId),
        eq(igConnections.tenantId, tenantId),
        isNull(igConnections.disconnectedAt),
      ),
    );
  return { wabas: wabaRow?.c ?? 0, igs: igRow?.c ?? 0 };
}
