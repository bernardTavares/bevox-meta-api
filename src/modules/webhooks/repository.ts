/**
 * Repository de WebhookSubscription + WebhookDelivery.
 *
 * `findOrCreateDelivery` é a primitiva usada pelo worker — garante que
 * cada (subscription_id, inbound_event_id) tenha exatamente uma row de
 * delivery, mesmo em retries.
 */

import { and, eq } from "drizzle-orm";

import {
  webhookDeliveries,
  webhookSubscriptions,
  type WebhookDelivery,
  type WebhookSubscription,
} from "@db/schema/index.js";

import { getDb } from "@/db/client.js";

export async function findSubscriptionById(id: string): Promise<WebhookSubscription | null> {
  const rows = await getDb()
    .select()
    .from(webhookSubscriptions)
    .where(eq(webhookSubscriptions.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function findOrCreateDelivery(input: {
  subscriptionId: string;
  inboundEventId: string;
}): Promise<WebhookDelivery> {
  const db = getDb();
  const existing = await db
    .select()
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.subscriptionId, input.subscriptionId),
        eq(webhookDeliveries.inboundEventId, input.inboundEventId),
      ),
    )
    .limit(1);
  if (existing[0]) return existing[0];
  const [row] = await db
    .insert(webhookDeliveries)
    .values({
      subscriptionId: input.subscriptionId,
      inboundEventId: input.inboundEventId,
    })
    .returning();
  if (!row) throw new Error("webhook_delivery insert returned no row");
  return row;
}

export async function insertSubscription(input: {
  appId: string;
  tenantId: string | null;
  url: string;
  eventTypesFilter: string[];
  secretCiphertext: Buffer;
  secretDekCiphertext: Buffer;
  secretDekKeyId: string;
  secretEncryptionContext: Record<string, string>;
  secretAlgo: string;
  secretNonce: Buffer;
  secretAuthTag: Buffer;
}): Promise<WebhookSubscription> {
  const [row] = await getDb()
    .insert(webhookSubscriptions)
    .values({
      appId: input.appId,
      tenantId: input.tenantId,
      url: input.url,
      eventTypesFilter: input.eventTypesFilter,
      secretCiphertext: input.secretCiphertext,
      secretDekCiphertext: input.secretDekCiphertext,
      secretDekKeyId: input.secretDekKeyId,
      secretEncryptionContext: input.secretEncryptionContext,
      secretAlgo: input.secretAlgo,
      secretNonce: input.secretNonce,
      secretAuthTag: input.secretAuthTag,
    })
    .returning();
  if (!row) throw new Error("webhook_subscription insert returned no row");
  return row;
}

export async function listSubscriptionsByApp(appId: string): Promise<WebhookSubscription[]> {
  return getDb().select().from(webhookSubscriptions).where(eq(webhookSubscriptions.appId, appId));
}

export async function setSubscriptionStatus(
  appId: string,
  id: string,
  status: "active" | "paused" | "disabled",
): Promise<WebhookSubscription | null> {
  const [row] = await getDb()
    .update(webhookSubscriptions)
    .set({ status })
    .where(and(eq(webhookSubscriptions.appId, appId), eq(webhookSubscriptions.id, id)))
    .returning();
  return row ?? null;
}

export async function findSubscriptionScoped(
  appId: string,
  id: string,
): Promise<WebhookSubscription | null> {
  const rows = await getDb()
    .select()
    .from(webhookSubscriptions)
    .where(and(eq(webhookSubscriptions.appId, appId), eq(webhookSubscriptions.id, id)))
    .limit(1);
  return rows[0] ?? null;
}

export async function listDeadLetterDeliveries(
  subscriptionId: string,
): Promise<{ id: string; inboundEventId: string }[]> {
  return getDb()
    .select({
      id: webhookDeliveries.id,
      inboundEventId: webhookDeliveries.inboundEventId,
    })
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.subscriptionId, subscriptionId),
        eq(webhookDeliveries.status, "dead_letter"),
      ),
    );
}

export async function resetDeliveryForReplay(deliveryId: string): Promise<void> {
  await getDb()
    .update(webhookDeliveries)
    .set({
      status: "pending",
      lastError: null,
      lastResponseStatus: null,
      lastAttemptAt: null,
      nextRetryAt: null,
      attempts: 0,
    })
    .where(eq(webhookDeliveries.id, deliveryId));
}

export async function updateDeliveryAttempt(
  id: string,
  patch: {
    status: "pending" | "delivered" | "failed" | "dead_letter";
    attempts: number;
    lastResponseStatus: number | null;
    lastError: string | null;
    lastAttemptAt: Date;
    nextRetryAt?: Date | null;
  },
): Promise<WebhookDelivery | null> {
  const setObj: Record<string, unknown> = {
    status: patch.status,
    attempts: patch.attempts,
    lastResponseStatus: patch.lastResponseStatus,
    lastError: patch.lastError,
    lastAttemptAt: patch.lastAttemptAt,
  };
  if (patch.nextRetryAt !== undefined) setObj.nextRetryAt = patch.nextRetryAt;
  const [row] = await getDb()
    .update(webhookDeliveries)
    .set(setObj)
    .where(eq(webhookDeliveries.id, id))
    .returning();
  return row ?? null;
}
