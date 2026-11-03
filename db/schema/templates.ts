/**
 * Schema de templates WhatsApp — PRD §8.4.
 *
 * Espelho local dos message templates aprovados/rejeitados na Meta.
 * Source of truth: Meta. Atualizamos via fetch periódico + webhook.
 */

import { sql } from "drizzle-orm";
import { integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

import { wabaConnections } from "./bindings.js";
import {
  createdAt,
  templateCategoryEnum,
  templateStatusEnum,
  updatedAt,
  uuidFk,
  uuidv7PrimaryKey,
} from "./_shared.js";

export const templates = pgTable(
  "templates",
  {
    id: uuidv7PrimaryKey(),
    wabaConnectionId: uuidFk("waba_connection_id")
      .notNull()
      .references(() => wabaConnections.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    language: text("language").notNull(),
    category: templateCategoryEnum("category").notNull(),
    componentsJson: jsonb("components_json").notNull(),
    metaStatus: templateStatusEnum("meta_status").notNull(),
    // 0..100 quando provido pela Meta. Nullable.
    metaQualityScore: integer("meta_quality_score"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true, mode: "date" })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    nameLangUniq: uniqueIndex("templates_waba_name_lang_uniq").on(
      table.wabaConnectionId,
      table.name,
      table.language,
    ),
  }),
);

export type Template = typeof templates.$inferSelect;
export type NewTemplate = typeof templates.$inferInsert;
