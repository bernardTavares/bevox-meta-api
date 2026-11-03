/**
 * Repository de idempotency_records.
 *
 * Encapsula queries Drizzle para isolar o plugin de idempotência da camada
 * de dados (facilita testes via mock).
 */

import { and, eq } from "drizzle-orm";

import { idempotencyRecords, type IdempotencyRecord } from "@db/schema/index.js";

import { getDb } from "@/db/client.js";

export async function findIdempotencyRecord(
  appId: string,
  key: string,
): Promise<IdempotencyRecord | null> {
  const rows = await getDb()
    .select()
    .from(idempotencyRecords)
    .where(and(eq(idempotencyRecords.appId, appId), eq(idempotencyRecords.key, key)))
    .limit(1);
  return rows[0] ?? null;
}

export interface SaveIdempotencyInput {
  appId: string;
  key: string;
  requestHash: string;
  responseStatus: number;
  responseBodyJson: unknown;
  expiresAt: Date;
}

export async function saveIdempotencyRecord(input: SaveIdempotencyInput): Promise<void> {
  await getDb()
    .insert(idempotencyRecords)
    .values({
      appId: input.appId,
      key: input.key,
      requestHash: input.requestHash,
      responseStatus: input.responseStatus,
      responseBodyJson: input.responseBodyJson as Record<string, unknown>,
      expiresAt: input.expiresAt,
    })
    .onConflictDoNothing();
}
