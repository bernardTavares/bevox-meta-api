/**
 * Idempotency records — PRD §8.5 + ADR MA-006.
 *
 * Garante que o mesmo (app_id, idempotency_key) retornando em < 24h devolve
 * a mesma resposta. Cron de cleanup expira por `expires_at`.
 */

import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

import { consumerApps } from "./identity.js";
import { uuidFk } from "./_shared.js";

export const idempotencyRecords = pgTable(
  "idempotency_records",
  {
    // Composite PK: (app_id, key). Key é fornecida pelo cliente.
    appId: uuidFk("app_id")
      .notNull()
      .references(() => consumerApps.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    // Hash do request body para detectar reuse de key com payload diferente
    // (CONFLICT 409 conforme MA-006).
    requestHash: text("request_hash").notNull(),
    responseStatus: integer("response_status").notNull(),
    responseBodyJson: jsonb("response_body_json").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .default(sql`now()`),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.appId, table.key] }),
    expiresIdx: index("idempotency_records_expires_at_idx").on(table.expiresAt),
  }),
);

export type IdempotencyRecord = typeof idempotencyRecords.$inferSelect;
export type NewIdempotencyRecord = typeof idempotencyRecords.$inferInsert;
