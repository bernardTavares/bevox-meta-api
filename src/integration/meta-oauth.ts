/**
 * Helpers para o fluxo OAuth Meta (Embedded Signup).
 *
 * Não faz chamadas HTTP — apenas constrói URLs e expõe constantes. As
 * chamadas /oauth/access_token (callback) ficam em meta-client.ts.
 */

import { env } from "@/config/env.js";
import { errors } from "@/lib/errors.js";

export const WABA_OAUTH_SCOPES = [
  "whatsapp_business_management",
  "whatsapp_business_messaging",
] as const;

export const IG_OAUTH_SCOPES = [
  "instagram_basic",
  "instagram_manage_messages",
  "pages_show_list",
  "pages_messaging",
] as const;

export type Channel = "waba" | "ig";

export const WABA_CALLBACK_PATH = "/v1/oauth/waba/callback";
export const IG_CALLBACK_PATH = "/v1/oauth/ig/callback";
export const META_WEBHOOK_PATH = "/webhooks/meta";

export interface BuildAuthorizeUrlInput {
  channel: Channel;
  state: string;
}

export function buildAuthorizeUrl(input: BuildAuthorizeUrlInput): string {
  const cfg = env();
  if (!cfg.META_APP_ID) {
    throw errors.internal("META_APP_ID not configured");
  }
  if (!cfg.OAUTH_CALLBACK_BASE_URL) {
    throw errors.internal("OAUTH_CALLBACK_BASE_URL not configured");
  }

  const callbackPath = input.channel === "waba" ? WABA_CALLBACK_PATH : IG_CALLBACK_PATH;
  const redirectUri = `${cfg.OAUTH_CALLBACK_BASE_URL}${callbackPath}`;
  const scope = (input.channel === "waba" ? WABA_OAUTH_SCOPES : IG_OAUTH_SCOPES).join(",");

  const params = new URLSearchParams({
    client_id: cfg.META_APP_ID,
    redirect_uri: redirectUri,
    state: input.state,
    response_type: "code",
    scope,
  });

  return `https://www.facebook.com/${cfg.META_GRAPH_API_VERSION}/dialog/oauth?${params.toString()}`;
}
