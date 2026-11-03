/**
 * Resolve token Meta plaintext para uma WabaConnection ativa.
 *
 * Sempre prefere o token mais recente (não-superseded, não-expirado).
 * Decifra via envelope encryption (MA-008). Caller é responsável por usar
 * o plaintext IMEDIATAMENTE e não logá-lo (CLAUDE.md §5.4).
 */

import { and, desc, eq, isNull, gt } from "drizzle-orm";

import { wabaTokens } from "@db/schema/index.js";

import { getDb } from "@/db/client.js";
import { decryptToken } from "@/lib/crypto-envelope.js";
import { errors } from "@/lib/errors.js";

export interface ResolvedWabaToken {
  /** Token plaintext. NUNCA logar. */
  accessToken: string;
  expiresAt: Date;
}

export async function resolveActiveWabaToken(wabaConnectionId: string): Promise<ResolvedWabaToken> {
  const now = new Date();
  const rows = await getDb()
    .select()
    .from(wabaTokens)
    .where(
      and(
        eq(wabaTokens.wabaConnectionId, wabaConnectionId),
        isNull(wabaTokens.supersededAt),
        gt(wabaTokens.expiresAt, now),
      ),
    )
    .orderBy(desc(wabaTokens.createdAt))
    .limit(1);

  const row = rows[0];
  if (!row) {
    throw errors.metaUnavailable(undefined, {
      reason: "no_active_token",
      waba_connection_id: wabaConnectionId,
    });
  }

  const plaintext = await decryptToken({
    ciphertext: row.ciphertext,
    dekCiphertext: row.dekCiphertext,
    dekKeyId: row.dekKeyId,
    encryptionContext: row.encryptionContext as Record<string, string>,
    algo: row.algo,
    nonce: row.nonce,
    authTag: row.authTag,
  });

  try {
    return {
      accessToken: plaintext.toString("utf8"),
      expiresAt: row.expiresAt,
    };
  } finally {
    plaintext.fill(0);
  }
}
