/**
 * Service — fetch de mídia inbound já baixada (PRD §10 M5-P3c).
 *
 * GET /v1/media/:media_key resolve para uma URL pré-assinada (302) se o objeto
 * já está no storage, ou 202 (processing) se o worker media-download ainda não
 * concluiu. A URL pré-assinada NUNCA é logada (CLAUDE.md §5.4).
 *
 * Tenant-isolation: X-Tenant-Id é fornecido pelo consumer (forjável). Validamos
 * que o app dono do JWT possui uma WabaConnection ativa para aquele tenant
 * antes de servir qualquer objeto — caso contrário 403.
 */

import { env } from "@/config/env.js";
import { errors } from "@/lib/errors.js";
import { getPresignedUrl, headMedia, mediaObjectKey } from "@/lib/media-storage.js";
import { listWabasByTenant } from "@/modules/wabas/repository.js";

export type ResolveMediaResult = { status: "ready"; url: string } | { status: "processing" };

/**
 * Resolve uma media_key para uma URL pré-assinada (se já baixada) ou indica
 * que o download ainda está pendente.
 *
 * @throws AppError FORBIDDEN se o app não possui waba ativa para o tenant.
 * @throws AppError INVALID_INPUT se a media_key for inválida (path-traversal etc).
 */
export async function resolveMedia(
  appId: string,
  tenantId: string,
  mediaKey: string,
): Promise<ResolveMediaResult> {
  // Tenant-isolation: o X-Tenant-Id é forjável; exige relação app↔tenant real.
  const wabas = await listWabasByTenant(appId, tenantId);
  if (wabas.length === 0) {
    throw errors.forbidden("App has no active WhatsApp connection for this tenant");
  }

  let key: string;
  try {
    key = mediaObjectKey(tenantId, mediaKey);
  } catch {
    throw errors.invalidInput("Invalid media_key");
  }

  if (await headMedia(key)) {
    // URL pré-assinada de TTL curto. NUNCA logar este valor.
    const url = await getPresignedUrl(key, env().MEDIA_PRESIGN_TTL_SECONDS);
    return { status: "ready", url };
  }

  return { status: "processing" };
}
