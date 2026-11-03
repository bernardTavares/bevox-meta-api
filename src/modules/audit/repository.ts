/**
 * Repository de audit_logs — insert-only.
 *
 * NUNCA exportar update/delete: a tabela é append-only por contrato (PRD §5.13).
 * Retenção operacional (5 anos) fica no nível DB/runbook.
 */

import { auditLogs, type AuditLog } from "@db/schema/index.js";

import { getDb } from "@/db/client.js";

export interface InsertAuditLogInput {
  actorType: "consumer_app" | "admin" | "system";
  actorId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  tenantId: string | null;
  appId: string | null;
  payloadRedacted: Record<string, unknown>;
  ip: string | null;
  userAgent: string | null;
}

export async function insertAuditLog(input: InsertAuditLogInput): Promise<AuditLog> {
  const [row] = await getDb()
    .insert(auditLogs)
    .values({
      actorType: input.actorType,
      actorId: input.actorId,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      tenantId: input.tenantId,
      appId: input.appId,
      payloadRedacted: input.payloadRedacted,
      ip: input.ip,
      userAgent: input.userAgent,
    })
    .returning();
  if (!row) throw new Error("audit_log insert returned no row");
  return row;
}
