/**
 * Building blocks compartilhados entre schemas Drizzle do bevox-meta-api.
 *
 * Convenções (PRD §8.6 + CLAUDE.md §5):
 *  - IDs: UUIDv7 (string) em todas as PKs.
 *  - Timestamps: `timestamptz` UTC com default `now()`.
 *  - Soft-delete: `deleted_at` nullable (nunca DELETE).
 *  - Enums: pgEnum quando o valor é parte do contrato; varchar quando livre.
 */

import { sql } from "drizzle-orm";
import { pgEnum, timestamp, uuid } from "drizzle-orm/pg-core";

import { uuidv7 } from "@/lib/uuid.js";

// ---------------------------------------------------------------------------
// Enums — espelham PRD §8 estritamente. NÃO renomear sem ADR superseding.
// ---------------------------------------------------------------------------

export const consumerAppStatusEnum = pgEnum("consumer_app_status", ["active", "deactivated"]);

export const tenantStatusEnum = pgEnum("tenant_status", ["active", "disabled", "deleted"]);

export const channelEnum = pgEnum("channel", ["whatsapp", "instagram"]);

export const templateStatusEnum = pgEnum("template_meta_status", [
  "PENDING",
  "APPROVED",
  "REJECTED",
  "PAUSED",
  "DISABLED",
]);

export const templateCategoryEnum = pgEnum("template_category", [
  "UTILITY",
  "MARKETING",
  "AUTHENTICATION",
]);

export const jobStatusEnum = pgEnum("outbound_job_status", [
  "queued",
  "sending",
  "sent",
  "failed",
  "expired",
]);

export const deliveryStatusEnum = pgEnum("webhook_delivery_status", [
  "pending",
  "delivered",
  "failed",
  "dead_letter",
]);

export const subscriptionStatusEnum = pgEnum("webhook_subscription_status", [
  "active",
  "paused",
  "disabled",
]);

export const actorTypeEnum = pgEnum("audit_actor_type", ["consumer_app", "admin", "system"]);

export const algoEnum = pgEnum("jwt_algo", ["RS256"]);

// ---------------------------------------------------------------------------
// Column helpers — usados em todas as tabelas.
// ---------------------------------------------------------------------------

/**
 * PK UUIDv7 gerada pela aplicação (não pelo Postgres).
 * Drizzle armazena como `uuid` nativo no Postgres; aplicação envia string v7.
 */
export const uuidv7PrimaryKey = () =>
  uuid("id")
    .primaryKey()
    .$defaultFn(() => uuidv7());

/**
 * FK para outra tabela usando uuid (sem default — quem cria fornece).
 */
export const uuidFk = (name: string) => uuid(name);

/**
 * `created_at` timestamptz UTC com default now(). Imutável após insert.
 */
export const createdAt = () =>
  timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .default(sql`now()`);

/**
 * `updated_at` timestamptz UTC com default now(). Atualizar via service layer.
 */
export const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true, mode: "date" })
    .notNull()
    .default(sql`now()`);

/**
 * `deleted_at` nullable — soft-delete (CLAUDE.md §5.7).
 * NULL = ativo. Não-NULL = soft-deleted; queries normais devem filtrar.
 */
export const deletedAt = () => timestamp("deleted_at", { withTimezone: true, mode: "date" });
