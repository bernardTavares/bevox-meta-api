/**
 * Service — message templates.
 *
 * Meta é a fonte de verdade. Operações:
 *   - create: submete à Meta + persiste local PENDING (Meta retorna PENDING/APPROVED).
 *   - list: lê apenas local (read-through é feito por resync).
 *   - get: lê local; chamadores podem requisitar resync separado.
 *   - resync: refetch da Meta + upsert.
 *   - delete: deleta na Meta + remove local.
 */

import type { Template } from "@db/schema/index.js";

import { getMetaOAuthClient } from "@/integration/meta-client.js";
import { errors } from "@/lib/errors.js";
import { findWabaConnectionById } from "@/modules/wabas/repository.js";
import { resolveActiveWabaToken } from "@/modules/wabas/token-resolver.js";

import {
  deleteTemplate as deleteTemplateRepo,
  findTemplate,
  listTemplatesByWaba,
  upsertTemplate,
} from "./repository.js";
import type { CreateTemplateBody, TemplateResponse } from "./schemas.js";

function toResponse(t: Template): TemplateResponse {
  return {
    id: t.id,
    waba_connection_id: t.wabaConnectionId,
    name: t.name,
    language: t.language,
    category: t.category,
    status: t.metaStatus,
    quality_score: t.metaQualityScore,
    components: (t.componentsJson ?? []) as unknown[],
    created_at: t.createdAt.toISOString(),
    updated_at: t.updatedAt.toISOString(),
    last_synced_at: t.lastSyncedAt.toISOString(),
  };
}

async function getActiveWaba(appId: string, tenantId: string, wabaId: string) {
  const waba = await findWabaConnectionById(appId, tenantId, wabaId);
  if (!waba) throw errors.notFound("waba_connection", wabaId);
  if (waba.disconnectedAt !== null) {
    throw errors.conflict("waba is disconnected", { waba_id: wabaId });
  }
  return waba;
}

export async function createTemplate(input: {
  appId: string;
  tenantId: string;
  wabaId: string;
  body: CreateTemplateBody;
}): Promise<TemplateResponse> {
  const waba = await getActiveWaba(input.appId, input.tenantId, input.wabaId);

  const existing = await findTemplate(waba.id, input.body.name, input.body.language);
  if (existing && existing.metaStatus !== "REJECTED") {
    throw errors.conflict("template with same (name, language) already exists", {
      name: input.body.name,
      language: input.body.language,
      status: existing.metaStatus,
    });
  }

  const token = await resolveActiveWabaToken(waba.id);
  const meta = getMetaOAuthClient();
  const result = await meta.createMessageTemplate(waba.metaWabaId, token.accessToken, {
    name: input.body.name,
    language: input.body.language,
    category: input.body.category,
    components: input.body.components,
  });

  const row = await upsertTemplate({
    wabaConnectionId: waba.id,
    name: input.body.name,
    language: input.body.language,
    category: result.category,
    status: result.status,
    qualityScore: null,
    components: input.body.components,
  });
  return toResponse(row);
}

export async function listTemplates(input: {
  appId: string;
  tenantId: string;
  wabaId: string;
  filter: { status?: string; language?: string };
}): Promise<TemplateResponse[]> {
  const waba = await getActiveWaba(input.appId, input.tenantId, input.wabaId);
  const rows = await listTemplatesByWaba(waba.id, input.filter);
  return rows.map(toResponse);
}

export async function getTemplate(input: {
  appId: string;
  tenantId: string;
  wabaId: string;
  name: string;
  language: string;
}): Promise<TemplateResponse> {
  const waba = await getActiveWaba(input.appId, input.tenantId, input.wabaId);
  const row = await findTemplate(waba.id, input.name, input.language);
  if (!row) throw errors.notFound("template", `${input.name}/${input.language}`);
  return toResponse(row);
}

export async function resyncTemplate(input: {
  appId: string;
  tenantId: string;
  wabaId: string;
  name: string;
  language: string;
}): Promise<TemplateResponse> {
  const waba = await getActiveWaba(input.appId, input.tenantId, input.wabaId);
  const token = await resolveActiveWabaToken(waba.id);
  const meta = getMetaOAuthClient();
  const fromMeta = await meta.getMessageTemplate(
    waba.metaWabaId,
    token.accessToken,
    input.name,
    input.language,
  );
  if (!fromMeta) {
    // Meta não conhece — pode ter sido removido. Apaga local também.
    await deleteTemplateRepo(waba.id, input.name, input.language);
    throw errors.notFound("template", `${input.name}/${input.language}`);
  }
  const row = await upsertTemplate({
    wabaConnectionId: waba.id,
    name: fromMeta.name,
    language: fromMeta.language,
    category: fromMeta.category,
    status: fromMeta.status,
    qualityScore: fromMeta.quality_score,
    components: fromMeta.components,
  });
  return toResponse(row);
}

export async function deleteTemplateAction(input: {
  appId: string;
  tenantId: string;
  wabaId: string;
  name: string;
  language: string;
}): Promise<{ ok: true; name: string; language: string }> {
  const waba = await getActiveWaba(input.appId, input.tenantId, input.wabaId);
  const existing = await findTemplate(waba.id, input.name, input.language);
  if (!existing) throw errors.notFound("template", `${input.name}/${input.language}`);

  const token = await resolveActiveWabaToken(waba.id);
  const meta = getMetaOAuthClient();
  await meta.deleteMessageTemplate(waba.metaWabaId, token.accessToken, input.name);
  await deleteTemplateRepo(waba.id, input.name, input.language);

  return { ok: true, name: input.name, language: input.language };
}
