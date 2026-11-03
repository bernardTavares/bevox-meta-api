/**
 * Repository de WabaConnection + WabaToken.
 *
 * Toda inserção é app_id-scoped. Criar WabaConnection + WabaToken roda em
 * uma transação para evitar conexão sem token (token cifrado obrigatório).
 */

import { and, asc, eq, isNull, lte, sql } from "drizzle-orm";

import {
  wabaConnections,
  wabaTokens,
  type WabaConnection,
  type WabaToken,
} from "@db/schema/index.js";

import { getDb } from "@/db/client.js";
import type { EnvelopeOutput } from "@/lib/crypto-envelope.js";

export interface CreateWabaConnectionInput {
  tenantId: string;
  appId: string;
  metaBusinessId: string;
  metaWabaId: string;
  displayName: string | null;
  verifiedStatus: string | null;
  envelope: EnvelopeOutput;
  expiresAt: Date;
  refreshAt: Date;
}

export interface CreateWabaConnectionResult {
  connection: WabaConnection;
  token: WabaToken;
}

export async function createWabaConnectionWithToken(
  input: CreateWabaConnectionInput,
): Promise<CreateWabaConnectionResult> {
  return getDb().transaction(async (tx) => {
    const [connection] = await tx
      .insert(wabaConnections)
      .values({
        tenantId: input.tenantId,
        appId: input.appId,
        metaBusinessId: input.metaBusinessId,
        metaWabaId: input.metaWabaId,
        displayName: input.displayName,
        verifiedStatus: input.verifiedStatus,
      })
      .returning();
    if (!connection) throw new Error("waba_connection insert returned no row");

    const [token] = await tx
      .insert(wabaTokens)
      .values({
        wabaConnectionId: connection.id,
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
    if (!token) throw new Error("waba_token insert returned no row");

    return { connection, token };
  });
}

/**
 * Busca conexão por meta_waba_id (sem scope de tenant). Usado em webhook
 * receiver para resolver o tenant a partir do payload da Meta.
 *
 * NOTA: schema permite mesma meta_waba_id em tenants distintos (unique é
 * (tenant_id, meta_waba_id)). Em prática isso não acontece em prod (Meta
 * não permite mesma WABA em duas conexões simultâneas), mas se acontecer
 * pegamos o primeiro não-disconnected.
 */
export async function findWabaByMetaWabaId(metaWabaId: string) {
  const rows = await getDb()
    .select()
    .from(wabaConnections)
    .where(and(eq(wabaConnections.metaWabaId, metaWabaId), isNull(wabaConnections.disconnectedAt)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Busca conexão por (tenant_id, meta_waba_id). Usado para detectar reconexão.
 */
export async function findWabaByTenantAndMetaId(
  tenantId: string,
  metaWabaId: string,
): Promise<WabaConnection | null> {
  const rows = await getDb()
    .select()
    .from(wabaConnections)
    .where(and(eq(wabaConnections.tenantId, tenantId), eq(wabaConnections.metaWabaId, metaWabaId)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Lista WabaConnections do tenant, scoped por app_id.
 */
export async function listWabasByTenant(
  appId: string,
  tenantId: string,
  opts: { includeDisconnected: boolean } = { includeDisconnected: false },
): Promise<WabaConnection[]> {
  const conds = [eq(wabaConnections.appId, appId), eq(wabaConnections.tenantId, tenantId)];
  if (!opts.includeDisconnected) conds.push(isNull(wabaConnections.disconnectedAt));
  return getDb()
    .select()
    .from(wabaConnections)
    .where(and(...conds))
    .orderBy(asc(wabaConnections.id));
}

/**
 * Busca WabaConnection por id (scoped).
 */
export async function findWabaConnectionById(
  appId: string,
  tenantId: string,
  wabaConnectionId: string,
): Promise<WabaConnection | null> {
  const rows = await getDb()
    .select()
    .from(wabaConnections)
    .where(
      and(
        eq(wabaConnections.appId, appId),
        eq(wabaConnections.tenantId, tenantId),
        eq(wabaConnections.id, wabaConnectionId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Soft-disconnect: set disconnected_at + supersede tokens. Idempotente.
 */
export async function disconnectWaba(
  appId: string,
  tenantId: string,
  wabaConnectionId: string,
): Promise<WabaConnection | null> {
  return getDb().transaction(async (tx) => {
    const [row] = await tx
      .update(wabaConnections)
      .set({ disconnectedAt: sql`now()`, updatedAt: sql`now()` })
      .where(
        and(
          eq(wabaConnections.appId, appId),
          eq(wabaConnections.tenantId, tenantId),
          eq(wabaConnections.id, wabaConnectionId),
          isNull(wabaConnections.disconnectedAt),
        ),
      )
      .returning();
    if (!row) return null;
    await tx
      .update(wabaTokens)
      .set({ supersededAt: sql`now()` })
      .where(
        and(eq(wabaTokens.wabaConnectionId, wabaConnectionId), isNull(wabaTokens.supersededAt)),
      );
    return row;
  });
}

/**
 * Soft-disconnect por meta_waba_id, sem scope de consumer-JWT. Usado pelo
 * receiver de webhook em account_update/PARTNER_REMOVED — não há contexto de
 * consumer, então app_id/tenant_id vêm da própria conexão (mesmo padrão de
 * `findWabaByMetaWabaId`, que o receiver já usa para resolver tenant). Set
 * disconnected_at + supersede tokens em txn. Retorna a conexão desconectada
 * ou null se não havia conexão ativa com esse meta_waba_id.
 */
export async function disconnectWabaByMetaWabaId(
  metaWabaId: string,
): Promise<WabaConnection | null> {
  return getDb().transaction(async (tx) => {
    const [row] = await tx
      .update(wabaConnections)
      .set({ disconnectedAt: sql`now()`, updatedAt: sql`now()` })
      .where(
        and(eq(wabaConnections.metaWabaId, metaWabaId), isNull(wabaConnections.disconnectedAt)),
      )
      .returning();
    if (!row) return null;
    await tx
      .update(wabaTokens)
      .set({ supersededAt: sql`now()` })
      .where(and(eq(wabaTokens.wabaConnectionId, row.id), isNull(wabaTokens.supersededAt)));
    return row;
  });
}

/**
 * Lista tokens (não-superseded) que expiram antes de `before` — usado pelo
 * worker de refresh.
 */
export async function listExpiringWabaTokens(before: Date): Promise<WabaToken[]> {
  return getDb()
    .select()
    .from(wabaTokens)
    .where(and(isNull(wabaTokens.supersededAt), lte(wabaTokens.expiresAt, before)));
}

/**
 * Refresh: insere NOVO token cifrado + marca o antigo como superseded em txn.
 */
export async function replaceWabaToken(input: {
  oldTokenId: string;
  wabaConnectionId: string;
  envelope: EnvelopeOutput;
  expiresAt: Date;
  refreshAt: Date;
}): Promise<WabaToken> {
  return getDb().transaction(async (tx) => {
    await tx
      .update(wabaTokens)
      .set({ supersededAt: sql`now()` })
      .where(eq(wabaTokens.id, input.oldTokenId));
    const [row] = await tx
      .insert(wabaTokens)
      .values({
        wabaConnectionId: input.wabaConnectionId,
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
    if (!row) throw new Error("waba_token replace insert returned no row");
    return row;
  });
}

/**
 * Marca uma WabaConnection como disconnected — usado quando refresh esgota
 * tentativas e a conexão precisa de re-OAuth manual.
 */
export async function markWabaDisconnected(wabaConnectionId: string): Promise<void> {
  await getDb()
    .update(wabaConnections)
    .set({ disconnectedAt: sql`now()`, updatedAt: sql`now()` })
    .where(eq(wabaConnections.id, wabaConnectionId));
}

/**
 * Em reconexão: limpa disconnected_at, atualiza display_name/verified_status,
 * insere NOVO WabaToken (não sobrescreve — supersede).
 */
export async function reconnectWaba(
  connectionId: string,
  patch: { displayName: string | null; verifiedStatus: string | null },
  envelope: EnvelopeOutput,
  expiresAt: Date,
  refreshAt: Date,
): Promise<{ connection: WabaConnection; token: WabaToken }> {
  return getDb().transaction(async (tx) => {
    const [connection] = await tx
      .update(wabaConnections)
      .set({
        displayName: patch.displayName,
        verifiedStatus: patch.verifiedStatus,
        disconnectedAt: null,
        updatedAt: sql`now()`,
      })
      .where(eq(wabaConnections.id, connectionId))
      .returning();
    if (!connection) throw new Error("waba_connection update returned no row");

    // Marca tokens antigos como superseded.
    await tx
      .update(wabaTokens)
      .set({ supersededAt: sql`now()` })
      .where(eq(wabaTokens.wabaConnectionId, connectionId));

    const [token] = await tx
      .insert(wabaTokens)
      .values({
        wabaConnectionId: connectionId,
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
    if (!token) throw new Error("waba_token insert returned no row");

    return { connection, token };
  });
}
