/**
 * Audit log — PRD §5.13 + §8.5.
 *
 * Trilha imutável (append-only) de toda mutação. Retenção 5 anos. PII
 * removida em `payload_redacted` — corpo de mensagens NUNCA persistido.
 *
 * Ownership: tabela escrita pelo plugin `audit-log` (CLAUDE.md §5.8).
 * Em produção: NEGAR UPDATE/DELETE via grants — TODO operacional.
 */

import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { consumerApps } from "./identity.js";
import { tenants } from "./tenancy.js";
import { actorTypeEnum, uuidFk, uuidv7PrimaryKey } from "./_shared.js";

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuidv7PrimaryKey(),
    actorType: actorTypeEnum("actor_type").notNull(),
    // actor_id pode ser app_id, admin_id, ou null para system.
    actorId: uuidFk("actor_id"),
    action: text("action").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id"),
    tenantId: uuidFk("tenant_id").references(() => tenants.id, { onDelete: "set null" }),
    appId: uuidFk("app_id").references(() => consumerApps.id, { onDelete: "set null" }),
    occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "date" })
      .notNull()
      .default(sql`now()`),
    // PII removida; apenas metadata estruturada (ex.: ids, status, contadores).
    payloadRedacted: jsonb("payload_redacted").notNull().default({}),
    ip: text("ip"),
    userAgent: text("user_agent"),
  },
  (table) => ({
    occurredAtIdx: index("audit_logs_occurred_at_idx").on(table.occurredAt),
    actorIdx: index("audit_logs_actor_idx").on(table.actorType, table.actorId),
    resourceIdx: index("audit_logs_resource_idx").on(table.resourceType, table.resourceId),
    tenantIdx: index("audit_logs_tenant_idx").on(table.tenantId, table.occurredAt),
  }),
);

export type AuditLog = typeof auditLogs.$inferSelect;
export type NewAuditLog = typeof auditLogs.$inferInsert;
