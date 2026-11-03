/**
 * Service — phone numbers.
 *
 * GET sincroniza com Meta antes de retornar (read-through cache).
 * POST profile propaga para Meta; não persiste localmente (perfil não é nosso domain).
 */

import type { PhoneNumber } from "@db/schema/index.js";

import { getMetaOAuthClient, type BusinessProfilePatch } from "@/integration/meta-client.js";
import { errors } from "@/lib/errors.js";
import { findWabaConnectionById } from "@/modules/wabas/repository.js";
import { resolveActiveWabaToken } from "@/modules/wabas/token-resolver.js";

import { findPhoneByMetaId, listPhoneNumbersByWaba, upsertPhoneNumbers } from "./repository.js";
import type { PhoneNumberResponse } from "./schemas.js";

function toResponse(p: PhoneNumber): PhoneNumberResponse {
  return {
    id: p.id,
    meta_phone_id: p.metaPhoneId,
    display_phone_number: p.displayPhoneNumber,
    verified_name: p.verifiedName,
    quality_rating: p.qualityRating,
    messaging_limit_tier: p.messagingLimitTier,
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

/**
 * Sincroniza phone_numbers da Meta com o cache local e retorna a lista.
 */
export async function listPhoneNumbers(
  appId: string,
  tenantId: string,
  wabaId: string,
): Promise<PhoneNumberResponse[]> {
  const waba = await getActiveWaba(appId, tenantId, wabaId);
  const token = await resolveActiveWabaToken(waba.id);
  const meta = getMetaOAuthClient();
  const fromMeta = await meta.listPhoneNumbers(waba.metaWabaId, token.accessToken);

  const upserted = await upsertPhoneNumbers(
    fromMeta.map((p) => ({
      wabaConnectionId: waba.id,
      metaPhoneId: p.meta_phone_id,
      displayPhoneNumber: p.display_phone_number,
      verifiedName: p.verified_name,
      qualityRating: p.quality_rating,
      messagingLimitTier: p.messaging_limit_tier,
    })),
  );

  // Retorna o estado canônico (após upsert) ou re-fetch para refletir
  // ordens consistentes.
  const local = upserted.length > 0 ? upserted : await listPhoneNumbersByWaba(waba.id);
  return local.map(toResponse);
}

/**
 * Atualiza whatsapp_business_profile via Meta. Não persistimos perfil — Meta
 * é a fonte de verdade.
 */
export async function updatePhoneProfile(input: {
  appId: string;
  tenantId: string;
  wabaId: string;
  metaPhoneId: string;
  patch: BusinessProfilePatch;
}): Promise<{ ok: true; meta_phone_id: string }> {
  const waba = await getActiveWaba(input.appId, input.tenantId, input.wabaId);
  const phone = await findPhoneByMetaId(waba.id, input.metaPhoneId);
  if (!phone) throw errors.notFound("phone_number", input.metaPhoneId);

  const token = await resolveActiveWabaToken(waba.id);
  const meta = getMetaOAuthClient();
  await meta.updatePhoneNumberProfile(input.metaPhoneId, token.accessToken, input.patch);

  return { ok: true, meta_phone_id: input.metaPhoneId };
}
