/**
 * Repository de InboundEvent + leitura de WebhookSubscription.
 */

import { and, eq, or, isNull } from "drizzle-orm";

import {
  inboundEvents,
  webhookSubscriptions,
  type InboundEvent,
  type WebhookSubscription,
} from "@db/schema/index.js";

import { getDb } from "@/db/client.js";

export interface InsertInboundEventInput {
  appId: string | null;
  tenantId: string | null;
  eventType: string;
  metaEventId: string | null;
  payloadJson: Record<string, unknown>;
}

export async function insertInboundEvent(input: InsertInboundEventInput): Promise<InboundEvent> {
  const [row] = await getDb()
    .insert(inboundEvents)
    .values({
      appId: input.appId,
      tenantId: input.tenantId,
      eventType: input.eventType,
      metaEventId: input.metaEventId,
      payloadJson: input.payloadJson,
    })
    .returning();
  if (!row) throw new Error("inbound_event insert returned no row");
  return row;
}

export async function findInboundEventById(id: string): Promise<InboundEvent | null> {
  const rows = await getDb().select().from(inboundEvents).where(eq(inboundEvents.id, id)).limit(1);
  return rows[0] ?? null;
}

/**
 * Lista subscriptions ativas para um app. Inclui as globais (tenant_id null)
 * e as do tenant específico (quando tenantId é fornecido).
 */
export async function listActiveSubscriptions(
  appId: string,
  tenantId: string | null,
): Promise<WebhookSubscription[]> {
  const tenantFilter = tenantId
    ? or(isNull(webhookSubscriptions.tenantId), eq(webhookSubscriptions.tenantId, tenantId))
    : isNull(webhookSubscriptions.tenantId);

  return getDb()
    .select()
    .from(webhookSubscriptions)
    .where(
      and(
        eq(webhookSubscriptions.appId, appId),
        eq(webhookSubscriptions.status, "active"),
        tenantFilter,
      ),
    );
}
