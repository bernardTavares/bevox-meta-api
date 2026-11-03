/**
 * Schemas de operação — PRD §8.5.
 *
 * Tabelas de runtime que registram envios, recebimentos e entregas.
 * Tudo `app_id`/`tenant_id`-scoped (CLAUDE.md §5.3, MA-003).
 */

import { sql } from "drizzle-orm";
import {
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer; default: false }>({
  dataType() {
    return "bytea";
  },
});

import { consumerApps } from "./identity.js";
import { tenants } from "./tenancy.js";
import {
  channelEnum,
  createdAt,
  deliveryStatusEnum,
  jobStatusEnum,
  subscriptionStatusEnum,
  uuidFk,
  uuidv7PrimaryKey,
} from "./_shared.js";

// ---------------------------------------------------------------------------
// OutboundJob — uma intenção de envio (whatsapp/instagram).
// Idempotência: (app_id, idempotency_key) único em janela 24h
// (enforcement adicional via tabela idempotency_records).
// ---------------------------------------------------------------------------

export const outboundJobs = pgTable(
  "outbound_jobs",
  {
    id: uuidv7PrimaryKey(),
    tenantId: uuidFk("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    appId: uuidFk("app_id")
      .notNull()
      .references(() => consumerApps.id, { onDelete: "restrict" }),
    idempotencyKey: text("idempotency_key").notNull(),
    channel: channelEnum("channel").notNull(),
    // payload_json é a intenção bruta (template + variáveis ou texto livre).
    // PII pode estar aqui — NUNCA logar conteúdo (CLAUDE.md §5.4, §5.6).
    payloadJson: jsonb("payload_json").notNull(),
    status: jobStatusEnum("status").notNull().default("queued"),
    attempts: smallint("attempts").notNull().default(0),
    lastError: text("last_error"),
    providerMessageId: text("provider_message_id"),
    createdAt: createdAt(),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
  },
  (table) => ({
    appIdemUniq: uniqueIndex("outbound_jobs_app_idempotency_uniq").on(
      table.appId,
      table.idempotencyKey,
    ),
    statusCreatedIdx: index("outbound_jobs_status_created_idx").on(table.status, table.createdAt),
    tenantCreatedIdx: index("outbound_jobs_tenant_created_idx").on(table.tenantId, table.createdAt),
  }),
);

// ---------------------------------------------------------------------------
// InboundEvent — webhook recebido da Meta. Persistido para replay/audit.
// ---------------------------------------------------------------------------

export const inboundEvents = pgTable(
  "inbound_events",
  {
    id: uuidv7PrimaryKey(),
    // tenant_id é resolvido na chegada (lookup por meta_waba_id/meta_ig_id).
    // Nullable para eventos órfãos (WABA não mapeada — registramos mesmo assim).
    tenantId: uuidFk("tenant_id").references(() => tenants.id, { onDelete: "set null" }),
    appId: uuidFk("app_id").references(() => consumerApps.id, { onDelete: "set null" }),
    eventType: text("event_type").notNull(),
    metaEventId: text("meta_event_id"),
    payloadJson: jsonb("payload_json").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true, mode: "date" })
      .notNull()
      .default(sql`now()`),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true, mode: "date" }),
  },
  (table) => ({
    metaEventIdIdx: index("inbound_events_meta_event_id_idx").on(table.metaEventId),
    receivedAtIdx: index("inbound_events_received_at_idx").on(table.receivedAt),
  }),
);

// ---------------------------------------------------------------------------
// WebhookSubscription — endpoints dos consumer apps para entrega outbound
// (modo push, MA-005). secret_encrypted via envelope encryption.
// ---------------------------------------------------------------------------

export const webhookSubscriptions = pgTable(
  "webhook_subscriptions",
  {
    id: uuidv7PrimaryKey(),
    appId: uuidFk("app_id")
      .notNull()
      .references(() => consumerApps.id, { onDelete: "cascade" }),
    // tenant_id null = subscription global do app (todos os tenants).
    tenantId: uuidFk("tenant_id").references(() => tenants.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    // Envelope encryption do shared secret usado para HMAC outbound.
    secretCiphertext: bytea("secret_ciphertext").notNull(),
    secretDekCiphertext: bytea("secret_dek_ciphertext").notNull(),
    secretDekKeyId: text("secret_dek_key_id").notNull(),
    secretEncryptionContext: jsonb("secret_encryption_context").notNull(),
    secretAlgo: text("secret_algo").notNull(),
    secretNonce: bytea("secret_nonce").notNull(),
    secretAuthTag: bytea("secret_auth_tag").notNull(),
    // Lista de event types aceitos. Vazio = todos.
    eventTypesFilter: text("event_types_filter")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    status: subscriptionStatusEnum("status").notNull().default("active"),
    createdAt: createdAt(),
  },
  (table) => ({
    appStatusIdx: index("webhook_subscriptions_app_status_idx").on(table.appId, table.status),
  }),
);

// ---------------------------------------------------------------------------
// WebhookDelivery — uma tentativa de entrega de InboundEvent para uma
// subscription. Mantém trilha completa de retries.
// ---------------------------------------------------------------------------

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuidv7PrimaryKey(),
    subscriptionId: uuidFk("subscription_id")
      .notNull()
      .references(() => webhookSubscriptions.id, { onDelete: "cascade" }),
    inboundEventId: uuidFk("inbound_event_id")
      .notNull()
      .references(() => inboundEvents.id, { onDelete: "cascade" }),
    status: deliveryStatusEnum("status").notNull().default("pending"),
    attempts: smallint("attempts").notNull().default(0),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true, mode: "date" }),
    lastResponseStatus: integer("last_response_status"),
    lastError: text("last_error"),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true, mode: "date" }),
    createdAt: createdAt(),
  },
  (table) => ({
    statusRetryIdx: index("webhook_deliveries_status_retry_idx").on(
      table.status,
      table.nextRetryAt,
    ),
    subscriptionStatusIdx: index("webhook_deliveries_subscription_status_idx").on(
      table.subscriptionId,
      table.status,
    ),
  }),
);

// ---------------------------------------------------------------------------
// Tipos inferidos.
// ---------------------------------------------------------------------------

export type OutboundJob = typeof outboundJobs.$inferSelect;
export type NewOutboundJob = typeof outboundJobs.$inferInsert;
export type InboundEvent = typeof inboundEvents.$inferSelect;
export type NewInboundEvent = typeof inboundEvents.$inferInsert;
export type WebhookSubscription = typeof webhookSubscriptions.$inferSelect;
export type NewWebhookSubscription = typeof webhookSubscriptions.$inferInsert;
export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;
export type NewWebhookDelivery = typeof webhookDeliveries.$inferInsert;
