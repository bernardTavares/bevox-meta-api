/**
 * Repository de IgConnection + IgToken — análogo ao wabas/repository.
 */

import { and, asc, eq, isNull, sql } from "drizzle-orm";

import { igConnections, igTokens, type IgConnection, type IgToken } from "@db/schema/index.js";

import { getDb } from "@/db/client.js";
import type { EnvelopeOutput } from "@/lib/crypto-envelope.js";

export interface CreateIgConnectionInput {
  tenantId: string;
  appId: string;
  metaIgId: string;
  username: string;
  accountType: string | null;
  envelope: EnvelopeOutput;
  expiresAt: Date;
  refreshAt: Date;
}

export async function createIgConnectionWithToken(
  input: CreateIgConnectionInput,
): Promise<{ connection: IgConnection; token: IgToken }> {
  return getDb().transaction(async (tx) => {
    const [connection] = await tx
      .insert(igConnections)
      .values({
        tenantId: input.tenantId,
        appId: input.appId,
        metaIgId: input.metaIgId,
        username: input.username,
        accountType: input.accountType,
      })
      .returning();
    if (!connection) throw new Error("ig_connection insert returned no row");

    const [token] = await tx
      .insert(igTokens)
      .values({
        igConnectionId: connection.id,
        ciphertext: input.envelope.ciphertext,
        dekCiphertext: input.envelope.dekCiphertext,
        dekKeyId: input.envelope.dekKeyId,
        encryptionContext: input.envelope.encryptionContext,
        algo: input.envelope.algo,
        nonce: input.envelope.nonce,
        authTag: input.envelope.authTag,
        expiresAt: input.expiresAt,
        refreshAt: input.refreshAt,
      })
      .returning();
    if (!token) throw new Error("ig_token insert returned no row");

    return { connection, token };
  });
}

export async function findIgByMetaIgId(metaIgId: string) {
  const rows = await getDb()
    .select()
    .from(igConnections)
    .where(and(eq(igConnections.metaIgId, metaIgId), isNull(igConnections.disconnectedAt)))
    .limit(1);
  return rows[0] ?? null;
}

export async function findIgByTenantAndMetaId(
  tenantId: string,
  metaIgId: string,
): Promise<IgConnection | null> {
  const rows = await getDb()
    .select()
    .from(igConnections)
    .where(and(eq(igConnections.tenantId, tenantId), eq(igConnections.metaIgId, metaIgId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function reconnectIg(
  connectionId: string,
  patch: { username: string; accountType: string | null },
  envelope: EnvelopeOutput,
  expiresAt: Date,
  refreshAt: Date,
): Promise<{ connection: IgConnection; token: IgToken }> {
  return getDb().transaction(async (tx) => {
    const [connection] = await tx
      .update(igConnections)
      .set({
        username: patch.username,
        accountType: patch.accountType,
        disconnectedAt: null,
        updatedAt: sql`now()`,
      })
      .where(eq(igConnections.id, connectionId))
      .returning();
    if (!connection) throw new Error("ig_connection update returned no row");

    await tx
      .update(igTokens)
      .set({ supersededAt: sql`now()` })
      .where(eq(igTokens.igConnectionId, connectionId));

    const [token] = await tx
      .insert(igTokens)
      .values({
        igConnectionId: connectionId,
        ciphertext: envelope.ciphertext,
        dekCiphertext: envelope.dekCiphertext,
        dekKeyId: envelope.dekKeyId,
        encryptionContext: envelope.encryptionContext,
        algo: envelope.algo,
        nonce: envelope.nonce,
        authTag: envelope.authTag,
        expiresAt,
        refreshAt,
      })
      .returning();
    if (!token) throw new Error("ig_token insert returned no row");
    return { connection, token };
  });
}

export async function listIgsByTenant(
  appId: string,
  tenantId: string,
  opts: { includeDisconnected: boolean } = { includeDisconnected: false },
): Promise<IgConnection[]> {
  const conds = [eq(igConnections.appId, appId), eq(igConnections.tenantId, tenantId)];
  if (!opts.includeDisconnected) conds.push(isNull(igConnections.disconnectedAt));
  return getDb()
    .select()
    .from(igConnections)
    .where(and(...conds))
    .orderBy(asc(igConnections.id));
}

export async function findIgConnectionById(
  appId: string,
  tenantId: string,
  igId: string,
): Promise<IgConnection | null> {
  const rows = await getDb()
    .select()
    .from(igConnections)
    .where(
      and(
        eq(igConnections.appId, appId),
        eq(igConnections.tenantId, tenantId),
        eq(igConnections.id, igId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function disconnectIg(
  appId: string,
  tenantId: string,
  igId: string,
): Promise<IgConnection | null> {
  return getDb().transaction(async (tx) => {
    const [row] = await tx
      .update(igConnections)
      .set({ disconnectedAt: sql`now()`, updatedAt: sql`now()` })
      .where(
        and(
          eq(igConnections.appId, appId),
          eq(igConnections.tenantId, tenantId),
          eq(igConnections.id, igId),
          isNull(igConnections.disconnectedAt),
        ),
      )
      .returning();
    if (!row) return null;
    await tx
      .update(igTokens)
      .set({ supersededAt: sql`now()` })
      .where(and(eq(igTokens.igConnectionId, igId), isNull(igTokens.supersededAt)));
    return row;
  });
}
