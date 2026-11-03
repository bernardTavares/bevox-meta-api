/**
 * Store em Redis dos `state` do OAuth Meta.
 *
 * Cada init armazena `oauth:state:<state>` com TTL 10min carregando o
 * contexto necessário para o callback validar:
 *   - app_id (do JWT consumer que iniciou)
 *   - tenant_id (alvo do binding)
 *   - channel (waba|ig)
 *   - redirect_url (URL para onde o consumer quer mandar o usuário ao final)
 *
 * O state é consumido (DEL após GET) no callback para impedir replay.
 */

import { getRedis } from "@/lib/redis.js";
import type { Channel } from "@/integration/meta-oauth.js";

export const STATE_TTL_SECONDS = 10 * 60;

export interface OAuthStatePayload {
  app_id: string;
  tenant_id: string;
  channel: Channel;
  redirect_url: string;
  created_at: number;
}

function key(state: string): string {
  return `oauth:state:${state}`;
}

export async function saveOAuthState(state: string, payload: OAuthStatePayload): Promise<void> {
  await getRedis().set(key(state), JSON.stringify(payload), "EX", STATE_TTL_SECONDS);
}

/**
 * Pega + deleta atomicamente. Retorna null se inexistente/expirado.
 */
export async function takeOAuthState(state: string): Promise<OAuthStatePayload | null> {
  const redis = getRedis();
  const k = key(state);
  // GETDEL é atômico desde Redis 6.2 — e nosso engine é 7+.
  const raw = await redis.getdel(k);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as OAuthStatePayload;
  } catch {
    return null;
  }
}
