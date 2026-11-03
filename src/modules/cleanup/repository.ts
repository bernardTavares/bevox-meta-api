/**
 * Repository de cleanup — DELETE em batches para evitar locks longos.
 *
 * Cada função roda num laço até esgotar (count=0). Retorna total deletado.
 */

import { sql } from "drizzle-orm";

import { getDb } from "@/db/client.js";

const BATCH_SIZE = 1000;

/**
 * IdempotencyRecord: deleta tudo onde expires_at < now.
 */
export async function cleanExpiredIdempotency(now: Date = new Date()): Promise<number> {
  let total = 0;
  while (true) {
    const result = await getDb().execute(sql`
      WITH victims AS (
        SELECT app_id, key
        FROM idempotency_records
        WHERE expires_at < ${now}
        LIMIT ${BATCH_SIZE}
      )
      DELETE FROM idempotency_records r
      USING victims v
      WHERE r.app_id = v.app_id AND r.key = v.key
    `);
    const n = result.rowCount ?? 0;
    total += n;
    if (n === 0) break;
  }
  return total;
}

/**
 * InboundEvent: deleta eventos com received_at < now - 90 days.
 */
export async function cleanOldInboundEvents(cutoff: Date): Promise<number> {
  let total = 0;
  while (true) {
    const result = await getDb().execute(sql`
      WITH victims AS (
        SELECT id FROM inbound_events
        WHERE received_at < ${cutoff}
        LIMIT ${BATCH_SIZE}
      )
      DELETE FROM inbound_events e
      USING victims v
      WHERE e.id = v.id
    `);
    const n = result.rowCount ?? 0;
    total += n;
    if (n === 0) break;
  }
  return total;
}

/**
 * OutboundJob: deleta sent/failed/expired com completed_at < now - 30 days.
 */
export async function cleanOldOutboundJobs(cutoff: Date): Promise<number> {
  let total = 0;
  while (true) {
    const result = await getDb().execute(sql`
      WITH victims AS (
        SELECT id FROM outbound_jobs
        WHERE completed_at IS NOT NULL
          AND completed_at < ${cutoff}
          AND status IN ('sent', 'failed', 'expired')
        LIMIT ${BATCH_SIZE}
      )
      DELETE FROM outbound_jobs j
      USING victims v
      WHERE j.id = v.id
    `);
    const n = result.rowCount ?? 0;
    total += n;
    if (n === 0) break;
  }
  return total;
}
