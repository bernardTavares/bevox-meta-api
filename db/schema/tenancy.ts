/**
 * Schema de tenancy — PRD §8.2.
 *
 * Tenant é a unidade de isolamento dentro de um ConsumerApp. Cada app tem
 * N tenants; queries multi-tenant SEMPRE usam (app_id, tenant_id) — nunca
 * tenant_id sozinho (CLAUDE.md §5.3, ADR MA-003).
 */

import { jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";

import { consumerApps } from "./identity.js";
import {
  createdAt,
  deletedAt,
  tenantStatusEnum,
  updatedAt,
  uuidFk,
  uuidv7PrimaryKey,
} from "./_shared.js";

export const tenants = pgTable(
  "tenants",
  {
    id: uuidv7PrimaryKey(),
    appId: uuidFk("app_id")
      .notNull()
      .references(() => consumerApps.id, { onDelete: "restrict" }),
    // ID externo opaco escolhido pelo consumer app. Permite mapeamento
    // estável quando o app já tem identidade própria do tenant.
    externalId: text("external_id"),
    displayName: text("display_name").notNull(),
    metadataJson: jsonb("metadata_json").notNull().default({}),
    status: tenantStatusEnum("status").notNull().default("active"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (table) => ({
    // Permite NULL múltiplos (Postgres trata NULL como distinto em UNIQUE),
    // mas garante (app_id, external_id) único quando external_id é fornecido.
    appExternalIdUniq: uniqueIndex("tenants_app_external_id_uniq").on(
      table.appId,
      table.externalId,
    ),
  }),
);

export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;
