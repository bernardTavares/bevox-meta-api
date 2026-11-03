/**
 * Repository de PhoneNumber.
 *
 * Tabela é cache local sincronizado com Meta — fonte de verdade é a Meta.
 * Upsert por (waba_connection_id, meta_phone_id).
 */

import { and, eq, sql } from "drizzle-orm";

import { phoneNumbers, type PhoneNumber } from "@db/schema/index.js";

import { getDb } from "@/db/client.js";

export interface UpsertPhoneInput {
  wabaConnectionId: string;
  metaPhoneId: string;
  displayPhoneNumber: string;
  verifiedName: string | null;
  qualityRating: string | null;
  messagingLimitTier: string | null;
}

export async function upsertPhoneNumbers(items: UpsertPhoneInput[]): Promise<PhoneNumber[]> {
  if (items.length === 0) return [];
  const rows = await getDb()
    .insert(phoneNumbers)
    .values(
      items.map((p) => ({
        wabaConnectionId: p.wabaConnectionId,
        metaPhoneId: p.metaPhoneId,
        displayPhoneNumber: p.displayPhoneNumber,
        verifiedName: p.verifiedName,
        qualityRating: p.qualityRating,
        messagingLimitTier: p.messagingLimitTier,
      })),
    )
    .onConflictDoUpdate({
      target: phoneNumbers.metaPhoneId,
      set: {
        displayPhoneNumber: sql`excluded.display_phone_number`,
        verifiedName: sql`excluded.verified_name`,
        qualityRating: sql`excluded.quality_rating`,
        messagingLimitTier: sql`excluded.messaging_limit_tier`,
        updatedAt: sql`now()`,
      },
    })
    .returning();
  return rows;
}

export async function listPhoneNumbersByWaba(wabaConnectionId: string): Promise<PhoneNumber[]> {
  return getDb()
    .select()
    .from(phoneNumbers)
    .where(eq(phoneNumbers.wabaConnectionId, wabaConnectionId));
}

export async function findPhoneByMetaId(
  wabaConnectionId: string,
  metaPhoneId: string,
): Promise<PhoneNumber | null> {
  const rows = await getDb()
    .select()
    .from(phoneNumbers)
    .where(
      and(
        eq(phoneNumbers.wabaConnectionId, wabaConnectionId),
        eq(phoneNumbers.metaPhoneId, metaPhoneId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}
