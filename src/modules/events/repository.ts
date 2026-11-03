/**
 * Repository de eventos para SSE replay.
 *
 * UUIDv7 é monotonicamente crescente → cursor-based pagination natural via
 * `id > cursor ORDER BY id`.
 */

import { and, asc, eq, gt, inArray, isNull, sql } from "drizzle-orm";

import { inboundEvents, type InboundEvent } from "@db/schema/index.js";

import { getDb } from "@/db/client.js";

export async function listEventsForReplay(input: {
  appId: string;
  tenantId?: string;
  cursor?: string;
  limit: number;
}): Promise<InboundEvent[]> {
  const conds = [eq(inboundEvents.appId, input.appId)];
  if (input.tenantId) conds.push(eq(inboundEvents.tenantId, input.tenantId));
  if (input.cursor) conds.push(gt(inboundEvents.id, input.cursor));
  return getDb()
    .select()
    .from(inboundEvents)
    .where(and(...conds))
    .orderBy(asc(inboundEvents.id))
    .limit(input.limit);
}

/**
 * Polling: retorna eventos não-acked (dispatched_at IS NULL) do app, com
 * paginação cursor-based. Spec: ordenar por occurred_at; UUIDv7 é
 * essencialmente monotônico em occurred_at, então usar id resolve.
 */
export async function listEventsForPolling(input: {
  appId: string;
  tenantId?: string;
  since?: string;
  limit: number;
  /** Default true: só retorna eventos não-acked (dispatched_at IS NULL). */
  undispatchedOnly?: boolean;
}): Promise<InboundEvent[]> {
  const conds = [eq(inboundEvents.appId, input.appId)];
  if (input.tenantId) conds.push(eq(inboundEvents.tenantId, input.tenantId));
  if (input.since) conds.push(gt(inboundEvents.id, input.since));
  if (input.undispatchedOnly !== false) {
    conds.push(isNull(inboundEvents.dispatchedAt));
  }
  return getDb()
    .select()
    .from(inboundEvents)
    .where(and(...conds))
    .orderBy(asc(inboundEvents.id))
    .limit(input.limit);
}

/**
 * ACK: marca eventos como dispatched (UPDATE dispatched_at = now()).
 * Scoped por appId — só acka eventos do próprio app. Retorna count.
 */
export async function ackEvents(appId: string, eventIds: string[]): Promise<number> {
  if (eventIds.length === 0) return 0;
  const rows = await getDb()
    .update(inboundEvents)
    .set({ dispatchedAt: sql`now()` })
    .where(
      and(
        eq(inboundEvents.appId, appId),
        inArray(inboundEvents.id, eventIds),
        isNull(inboundEvents.dispatchedAt),
      ),
    )
    .returning({ id: inboundEvents.id });
  return rows.length;
}
