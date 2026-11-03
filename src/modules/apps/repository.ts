/**
 * Repository de ConsumerApp + AppKey.
 *
 * V1 mínimo: lookups usados pelo plugin de auth (`auth-jwt-consumer`).
 * CRUD completo virá em task #14 (admin apps).
 */

import { and, asc, eq, gt, isNull, lte, or, sql } from "drizzle-orm";

import { appKeys, consumerApps, type AppKey, type ConsumerApp } from "@db/schema/index.js";

import { getDb } from "@/db/client.js";

/**
 * Retorna ConsumerApp por id, ou null se não existir.
 */
export async function findConsumerAppById(id: string): Promise<ConsumerApp | null> {
  const rows = await getDb().select().from(consumerApps).where(eq(consumerApps.id, id)).limit(1);
  return rows[0] ?? null;
}

/**
 * Retorna AppKey ativa (valid_from <= now < valid_until) para (appId, keyId),
 * ou null se inexistente / não-iniciada / expirada.
 */
export async function listConsumerApps(): Promise<ConsumerApp[]> {
  return getDb().select().from(consumerApps).orderBy(asc(consumerApps.createdAt));
}

export async function createConsumerAppWithKey(input: {
  name: string;
  description: string | null;
  publicKeyPem: string;
}): Promise<{ app: ConsumerApp; key: AppKey }> {
  return getDb().transaction(async (tx) => {
    const [app] = await tx
      .insert(consumerApps)
      .values({
        name: input.name,
        description: input.description,
      })
      .returning();
    if (!app) throw new Error("consumer_app insert returned no row");
    const [key] = await tx
      .insert(appKeys)
      .values({
        appId: app.id,
        publicKeyPem: input.publicKeyPem,
        validFrom: new Date(),
      })
      .returning();
    if (!key) throw new Error("app_key insert returned no row");
    // Atualiza ConsumerApp com current_public_key.
    const [updated] = await tx
      .update(consumerApps)
      .set({ currentPublicKeyPem: key.publicKeyPem, currentPublicKeyId: key.id })
      .where(eq(consumerApps.id, app.id))
      .returning();
    return { app: updated ?? app, key };
  });
}

export async function setConsumerAppStatus(
  id: string,
  status: "active" | "deactivated",
): Promise<ConsumerApp | null> {
  const [row] = await getDb()
    .update(consumerApps)
    .set({ status, updatedAt: sql`now()` })
    .where(eq(consumerApps.id, id))
    .returning();
  return row ?? null;
}

export async function rotateAppKey(input: {
  appId: string;
  newPublicKeyPem: string;
  graceWindowDays: number;
}): Promise<{ newKey: AppKey; supersededKeys: number }> {
  return getDb().transaction(async (tx) => {
    // 1. Insere nova key valid_from=now, valid_until=null.
    const [newKey] = await tx
      .insert(appKeys)
      .values({
        appId: input.appId,
        publicKeyPem: input.newPublicKeyPem,
        validFrom: new Date(),
      })
      .returning();
    if (!newKey) throw new Error("app_key rotate insert returned no row");

    // 2. Marca keys anteriores (id != newKey.id) com valid_until = now + grace.
    const graceUntil = new Date(Date.now() + input.graceWindowDays * 24 * 3600 * 1000);
    const supersededRows = await tx
      .update(appKeys)
      .set({ validUntil: graceUntil, rotatedAt: sql`now()` })
      .where(
        and(
          eq(appKeys.appId, input.appId),
          isNull(appKeys.validUntil),
          // Não marca a recém-inserida.
          sql`${appKeys.id} <> ${newKey.id}`,
        ),
      )
      .returning({ id: appKeys.id });

    // 3. Atualiza ConsumerApp.current_public_key_*
    await tx
      .update(consumerApps)
      .set({ currentPublicKeyPem: newKey.publicKeyPem, currentPublicKeyId: newKey.id })
      .where(eq(consumerApps.id, input.appId));

    return { newKey, supersededKeys: supersededRows.length };
  });
}

export async function findActiveAppKey(appId: string, keyId: string): Promise<AppKey | null> {
  const now = new Date();
  const rows = await getDb()
    .select()
    .from(appKeys)
    .where(
      and(
        eq(appKeys.appId, appId),
        eq(appKeys.id, keyId),
        lte(appKeys.validFrom, now),
        or(isNull(appKeys.validUntil), gt(appKeys.validUntil, now)),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}
