/**
 * Schemas de bindings Meta — PRD §8.3.
 *
 * Liga um Tenant a credenciais Meta (WABA/Instagram) e armazena phone numbers.
 *
 * Multi-WABA (ADR MA-004): cada tenant pode ter ≥1 WabaConnection. Tokens
 * encriptados via envelope encryption (MA-008) — nunca em log/response.
 */

import {
  customType,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// Drizzle não tem `bytea` nativo; mapeia via customType. Aplicação envia/recebe
// Buffer; Postgres armazena bytea.
const bytea = customType<{ data: Buffer; default: false }>({
  dataType() {
    return "bytea";
  },
});

import { consumerApps } from "./identity.js";
import { tenants } from "./tenancy.js";
import { createdAt, updatedAt, uuidFk, uuidv7PrimaryKey } from "./_shared.js";

// ---------------------------------------------------------------------------
// WabaConnection — uma WABA Meta vinculada a um tenant.
// ---------------------------------------------------------------------------

export const wabaConnections = pgTable(
  "waba_connections",
  {
    id: uuidv7PrimaryKey(),
    tenantId: uuidFk("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    // Denormalizado para índices/queries scoped sem JOIN (CLAUDE.md §5.3).
    appId: uuidFk("app_id")
      .notNull()
      .references(() => consumerApps.id, { onDelete: "restrict" }),
    metaBusinessId: text("meta_business_id").notNull(),
    metaWabaId: text("meta_waba_id").notNull(),
    displayName: text("display_name"),
    verifiedStatus: text("verified_status"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    // Soft-disconnect: preenchido quando OAuth cai ou usuário desconecta.
    disconnectedAt: timestamp("disconnected_at", { withTimezone: true, mode: "date" }),
  },
  (table) => ({
    tenantWabaUniq: uniqueIndex("waba_connections_tenant_waba_uniq").on(
      table.tenantId,
      table.metaWabaId,
    ),
  }),
);

// ---------------------------------------------------------------------------
// WabaToken — credenciais cifradas com envelope encryption (MA-008).
// Múltiplos rows por waba_connection (histórico + grace de rotação);
// `superseded_at` marca tokens antigos.
// ---------------------------------------------------------------------------

export const wabaTokens = pgTable("waba_tokens", {
  id: uuidv7PrimaryKey(),
  wabaConnectionId: uuidFk("waba_connection_id")
    .notNull()
    .references(() => wabaConnections.id, { onDelete: "cascade" }),
  // Envelope encryption (MA-008). NUNCA logar (CLAUDE.md §5.4).
  ciphertext: bytea("ciphertext").notNull(),
  dekCiphertext: bytea("dek_ciphertext").notNull(),
  dekKeyId: text("dek_key_id").notNull(),
  encryptionContext: jsonb("encryption_context").notNull(),
  algo: text("algo").notNull(),
  nonce: bytea("nonce").notNull(),
  authTag: bytea("auth_tag").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  refreshAt: timestamp("refresh_at", { withTimezone: true, mode: "date" }).notNull(),
  createdAt: createdAt(),
  supersededAt: timestamp("superseded_at", { withTimezone: true, mode: "date" }),
});

// ---------------------------------------------------------------------------
// PhoneNumber — números WhatsApp registrados em uma WABA.
// ---------------------------------------------------------------------------

export const phoneNumbers = pgTable(
  "phone_numbers",
  {
    id: uuidv7PrimaryKey(),
    wabaConnectionId: uuidFk("waba_connection_id")
      .notNull()
      .references(() => wabaConnections.id, { onDelete: "cascade" }),
    metaPhoneId: text("meta_phone_id").notNull(),
    displayPhoneNumber: text("display_phone_number").notNull(),
    qualityRating: text("quality_rating"),
    messagingLimitTier: text("messaging_limit_tier"),
    verifiedName: text("verified_name"),
    // Tier de mensagens / janela de 1k/10k/100k — útil para rate limiting.
    messagingLimitDailyMax: integer("messaging_limit_daily_max"),
    metadataJson: jsonb("metadata_json").notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    metaPhoneIdUniq: uniqueIndex("phone_numbers_meta_phone_id_uniq").on(table.metaPhoneId),
  }),
);

// ---------------------------------------------------------------------------
// IgConnection — Instagram Graph API binding por tenant.
// ---------------------------------------------------------------------------

export const igConnections = pgTable(
  "ig_connections",
  {
    id: uuidv7PrimaryKey(),
    tenantId: uuidFk("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    appId: uuidFk("app_id")
      .notNull()
      .references(() => consumerApps.id, { onDelete: "restrict" }),
    metaIgId: text("meta_ig_id").notNull(),
    username: text("username").notNull(),
    accountType: text("account_type"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    disconnectedAt: timestamp("disconnected_at", { withTimezone: true, mode: "date" }),
  },
  (table) => ({
    tenantIgUniq: uniqueIndex("ig_connections_tenant_ig_uniq").on(table.tenantId, table.metaIgId),
  }),
);

// ---------------------------------------------------------------------------
// IgToken — análogo a WabaToken para Instagram.
// ---------------------------------------------------------------------------

export const igTokens = pgTable("ig_tokens", {
  id: uuidv7PrimaryKey(),
  igConnectionId: uuidFk("ig_connection_id")
    .notNull()
    .references(() => igConnections.id, { onDelete: "cascade" }),
  ciphertext: bytea("ciphertext").notNull(),
  dekCiphertext: bytea("dek_ciphertext").notNull(),
  dekKeyId: text("dek_key_id").notNull(),
  encryptionContext: jsonb("encryption_context").notNull(),
  algo: text("algo").notNull(),
  nonce: bytea("nonce").notNull(),
  authTag: bytea("auth_tag").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  refreshAt: timestamp("refresh_at", { withTimezone: true, mode: "date" }).notNull(),
  createdAt: createdAt(),
  supersededAt: timestamp("superseded_at", { withTimezone: true, mode: "date" }),
});

// ---------------------------------------------------------------------------
// Tipos inferidos.
// ---------------------------------------------------------------------------

export type WabaConnection = typeof wabaConnections.$inferSelect;
export type NewWabaConnection = typeof wabaConnections.$inferInsert;
export type WabaToken = typeof wabaTokens.$inferSelect;
export type NewWabaToken = typeof wabaTokens.$inferInsert;
export type PhoneNumber = typeof phoneNumbers.$inferSelect;
export type NewPhoneNumber = typeof phoneNumbers.$inferInsert;
export type IgConnection = typeof igConnections.$inferSelect;
export type NewIgConnection = typeof igConnections.$inferInsert;
export type IgToken = typeof igTokens.$inferSelect;
export type NewIgToken = typeof igTokens.$inferInsert;
