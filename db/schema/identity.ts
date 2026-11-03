/**
 * Schemas de identidade — PRD §8.1.
 *
 * - ConsumerApp: cada app cliente do meta-api (Bevox V1, futuros).
 * - AppKey: chaves públicas RSA (RS256) por app, com rotação suportada.
 * - AdminAccount: contas humanas internas Bevox para gestão via CLI.
 */

import { boolean, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

import {
  algoEnum,
  consumerAppStatusEnum,
  createdAt,
  updatedAt,
  uuidFk,
  uuidv7PrimaryKey,
} from "./_shared.js";

// ---------------------------------------------------------------------------
// ConsumerApp
// ---------------------------------------------------------------------------

export const consumerApps = pgTable("consumer_apps", {
  id: uuidv7PrimaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  status: consumerAppStatusEnum("status").notNull().default("active"),
  // Cache da PEM "atual" — leitura quente em hot path de auth JWT.
  // Source of truth: app_keys (com histórico). Rotação atualiza ambos.
  currentPublicKeyPem: text("current_public_key_pem"),
  // FK para app_keys; nullable durante bootstrap (app criado antes da 1ª chave).
  currentPublicKeyId: uuidFk("current_public_key_id"),
  metadataJson: jsonb("metadata_json").notNull().default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ---------------------------------------------------------------------------
// AppKey — histórico de chaves públicas por app, com janela de validade
// para suportar rotação com grace period (MA-002).
// ---------------------------------------------------------------------------

export const appKeys = pgTable(
  "app_keys",
  {
    id: uuidv7PrimaryKey(),
    appId: uuidFk("app_id")
      .notNull()
      .references(() => consumerApps.id, { onDelete: "restrict" }),
    publicKeyPem: text("public_key_pem").notNull(),
    algo: algoEnum("algo").notNull().default("RS256"),
    // Quando a chave passa a ser aceita.
    validFrom: timestamp("valid_from", { withTimezone: true, mode: "date" }).notNull(),
    // Quando a chave deixa de ser aceita (NULL = sem expiração).
    validUntil: timestamp("valid_until", { withTimezone: true, mode: "date" }),
    // Quando a rotação foi efetivada (chave anterior superseded).
    rotatedAt: timestamp("rotated_at", { withTimezone: true, mode: "date" }),
    createdAt: createdAt(),
  },
  (table) => ({
    // kid (key id) é o próprio app_keys.id; lookup por (app_id, id) é o
    // caminho quente. PG já indexa PK; este UNIQUE serve como contrato.
    appIdKeyIdx: uniqueIndex("app_keys_app_id_id_uniq").on(table.appId, table.id),
  }),
);

// ---------------------------------------------------------------------------
// AdminAccount — V1: poucas contas, gerenciadas via CLI.
// ---------------------------------------------------------------------------

export const adminAccounts = pgTable(
  "admin_accounts",
  {
    id: uuidv7PrimaryKey(),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    mfaEnrolled: boolean("mfa_enrolled").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    emailUniq: uniqueIndex("admin_accounts_email_uniq").on(table.email),
  }),
);

// ---------------------------------------------------------------------------
// Tipos inferidos para uso em services/repositories.
// ---------------------------------------------------------------------------

export type ConsumerApp = typeof consumerApps.$inferSelect;
export type NewConsumerApp = typeof consumerApps.$inferInsert;
export type AppKey = typeof appKeys.$inferSelect;
export type NewAppKey = typeof appKeys.$inferInsert;
export type AdminAccount = typeof adminAccounts.$inferSelect;
export type NewAdminAccount = typeof adminAccounts.$inferInsert;
