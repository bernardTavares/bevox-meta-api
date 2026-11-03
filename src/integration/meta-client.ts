/**
 * Meta Graph API client — wrapper sobre `undici` com:
 *   - timeouts conservadores (10s)
 *   - mapeamento Meta-error → AppError canônico (PRD §9.4)
 *   - separação clara entre OAuth e Graph (mesmo host, contratos diferentes)
 *
 * NÃO loga payload (PII risk). Apenas endpoint, status, latency.
 *
 * Em V1 implementamos o mínimo: exchangeCode, debugToken, discoverWaba.
 * Outros métodos virão conforme as tasks #15+ avançam.
 */

import { request } from "undici";

import { env } from "@/config/env.js";
import { errors } from "@/lib/errors.js";
import { logger } from "@/lib/logger.js";
import { IG_CALLBACK_PATH, META_WEBHOOK_PATH, WABA_CALLBACK_PATH } from "./meta-oauth.js";

const META_GRAPH_HOST = "https://graph.facebook.com";
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * C2 SSRF guard (audit 2026-06-02): `downloadMedia()` recebe uma URL absoluta
 * que vem do JSON de `getMediaMetadata()` da Meta (campo `url`). Antes desta
 * lista, qualquer URL seria seguida com o WABA Bearer no header — vetor de
 * token-leak se a Meta retornar (ou um MITM injetar) um host arbitrário.
 *
 * Allowlist por sufixo de domínio + scheme https obrigatório. Hosts Meta para
 * CDNs de mídia (todos sob domínios que a Meta controla):
 *   - `*.fbsbx.com`        (lookaside.fbsbx.com, cdn.fbsbx.com — WhatsApp media)
 *   - `*.fbcdn.net`        (Facebook CDN)
 *   - `*.cdninstagram.com` (Instagram CDN)
 *   - `*.whatsapp.net`     (mmg.whatsapp.net, etc.)
 *
 * Outros padrões devem ser adicionados deliberadamente — sem asterisco curinga
 * global, sem schemes além de https.
 */
const META_MEDIA_ALLOWED_HOST_SUFFIXES: readonly string[] = [
  "fbsbx.com",
  "fbcdn.net",
  "cdninstagram.com",
  "whatsapp.net",
] as const;

export function isAllowedMetaMediaUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  return META_MEDIA_ALLOWED_HOST_SUFFIXES.some(
    (suffix) => host === suffix || host.endsWith("." + suffix),
  );
}

// ---------------------------------------------------------------------------
// Tipos públicos
// ---------------------------------------------------------------------------

export interface ExchangeCodeResult {
  access_token: string;
  token_type: string;
  /** Em segundos. Pode ser ausente em short-lived tokens. */
  expires_in?: number;
}

export interface WabaDiscovery {
  meta_business_id: string;
  meta_waba_id: string;
  display_name: string | null;
  verified_status: string | null;
}

export interface IgDiscovery {
  meta_ig_id: string;
  username: string;
  account_type: string | null;
}

export type TemplateCategory = "UTILITY" | "MARKETING" | "AUTHENTICATION";
export type TemplateStatus = "PENDING" | "APPROVED" | "REJECTED" | "PAUSED" | "DISABLED";

export interface CreateTemplateInput {
  name: string;
  language: string;
  category: TemplateCategory;
  components: unknown[];
}

export interface CreateTemplateResult {
  meta_template_id: string;
  status: TemplateStatus;
  category: TemplateCategory;
}

export interface MetaTemplateRecord {
  meta_template_id: string;
  name: string;
  language: string;
  category: TemplateCategory;
  status: TemplateStatus;
  quality_score: number | null;
  components: unknown[];
}

export interface MetaPhoneNumber {
  meta_phone_id: string;
  display_phone_number: string;
  verified_name: string | null;
  quality_rating: string | null;
  messaging_limit_tier: string | null;
}

export interface PhoneCoexInfo {
  /** A resposta da Meta usa a key `id` (não `phone_number_id`). */
  phone_number_id: string;
  is_on_biz_app: boolean;
  platform_type: string | null;
}

export interface SmbAppDataSyncResult {
  /** request_id do POST sync_type=smb_app_state_sync (contatos). */
  state_sync_request_id: string | null;
  /** request_id do POST sync_type=history (histórico de mensagens). */
  history_request_id: string | null;
}

export interface BusinessProfilePatch {
  about?: string;
  description?: string;
  email?: string;
  websites?: string[];
  profile_picture_url?: string;
}

export interface MetaOAuthClient {
  exchangeCode(code: string, redirectUri?: string): Promise<ExchangeCodeResult>;
  /** Renova long-lived token via grant_type=fb_exchange_token. */
  exchangeLongLivedToken(currentToken: string): Promise<ExchangeCodeResult>;
  /** Resolve a primeira WABA acessível pelo token. V1 simplificação. */
  /**
   * Resolve a WABA conectada. Quando `hint.wabaId` é fornecido (Embedded Signup:
   * o waba_id vem do session info do widget), materializa direto via
   * GET /{waba_id} — o token de ES nem sempre expõe whatsapp_business_management
   * como granular scope no /debug_token. Sem hint, cai no fallback /debug_token
   * (fluxo redirect).
   */
  discoverWaba(
    accessToken: string,
    hint?: { wabaId?: string; businessId?: string },
  ): Promise<WabaDiscovery>;
  /**
   * Registra o app nos webhooks da WABA com override de callback por-WABA,
   * para que os eventos desta WABA cheguem ao meta-api (/webhooks/meta) e não
   * ao callback a nível de app. Idempotente no lado Meta.
   * POST /{waba_id}/subscribed_apps
   */
  subscribeWabaApp(
    wabaId: string,
    accessToken: string,
    override: { callbackUri: string; verifyToken: string },
  ): Promise<void>;
  /**
   * Confirma se um phone_number está em modo coexistence (COEX): apto a usar
   * Cloud API E o app WhatsApp Business simultaneamente. Verbatim F1:
   * is_on_biz_app=true + platform_type=CLOUD_API.
   * GET /{phone_number_id}?fields=is_on_biz_app,platform_type
   */
  getPhoneCoexInfo(phoneNumberId: string, accessToken: string): Promise<PhoneCoexInfo>;
  /**
   * Dispara o sync obrigatório de 24h do COEX: contatos (smb_app_state_sync)
   * + histórico (history). 2 POSTs separados para /{phone}/smb_app_data.
   * Resultado real chega via webhooks smb_app_state_sync/history. Verbatim C.
   */
  triggerSmbAppDataSync(phoneNumberId: string, accessToken: string): Promise<SmbAppDataSyncResult>;
  /** Resolve a primeira Instagram Business account acessível pelo token. */
  discoverIgAccount(accessToken: string): Promise<IgDiscovery>;
  /** Lista phone_numbers de uma WABA. */
  listPhoneNumbers(wabaId: string, accessToken: string): Promise<MetaPhoneNumber[]>;
  /** Atualiza whatsapp_business_profile de um phone_number. */
  updatePhoneNumberProfile(
    phoneId: string,
    accessToken: string,
    patch: BusinessProfilePatch,
  ): Promise<void>;
  // -- Message Templates --
  createMessageTemplate(
    wabaId: string,
    accessToken: string,
    input: CreateTemplateInput,
  ): Promise<CreateTemplateResult>;
  getMessageTemplate(
    wabaId: string,
    accessToken: string,
    name: string,
    language: string,
  ): Promise<MetaTemplateRecord | null>;
  deleteMessageTemplate(
    wabaId: string,
    accessToken: string,
    name: string,
    metaTemplateId?: string,
  ): Promise<void>;
  // -- Messaging --
  sendWhatsAppMessage(
    phoneId: string,
    accessToken: string,
    body: Record<string, unknown>,
  ): Promise<MetaSendResult>;
  sendInstagramMessage(
    igId: string,
    accessToken: string,
    body: Record<string, unknown>,
  ): Promise<MetaSendResult>;
  // -- Media (inbound) --
  /** Resolve metadata (incl. temp CDN url) de um media-id via Graph API. */
  getMediaMetadata(mediaId: string, token: string): Promise<MediaMetadata>;
  /** Baixa os bytes da temp CDN url (absoluta) com o mesmo Bearer token. */
  downloadMedia(url: string, token: string): Promise<Buffer>;
}

export interface MediaMetadata {
  url: string;
  mime_type: string;
  file_size: number;
  sha256?: string;
}

export interface MetaSendResult {
  provider_message_id: string;
}

// ---------------------------------------------------------------------------
// Implementação real (undici)
// ---------------------------------------------------------------------------

interface MetaErrorBody {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    fbtrace_id?: string;
  };
}

function mapMetaError(status: number, body: unknown, endpoint: string): never {
  const meta = (body as MetaErrorBody).error;
  const reason = meta?.message ?? `Meta returned ${status} for ${endpoint}`;
  const details = {
    meta_endpoint: endpoint,
    meta_status: status,
    meta_code: meta?.code,
    meta_subcode: meta?.error_subcode,
    fbtrace_id: meta?.fbtrace_id,
  };
  if (status >= 500 || status === 0) {
    throw errors.metaUnavailable(undefined, details);
  }
  // 4xx → reject lógico do Meta
  throw errors.metaRejected(reason, details);
}

async function metaGet(path: string, query: Record<string, string>): Promise<unknown> {
  const url = new URL(`${META_GRAPH_HOST}/${env().META_GRAPH_API_VERSION}${path}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);

  const res = await request(url, {
    method: "GET",
    headersTimeout: REQUEST_TIMEOUT_MS,
    bodyTimeout: REQUEST_TIMEOUT_MS,
  }).catch((err: unknown) => {
    throw errors.metaUnavailable(err, { meta_endpoint: path });
  });
  const body = (await res.body.json().catch(() => ({}))) as unknown;
  if (res.statusCode >= 400) mapMetaError(res.statusCode, body, path);
  return body;
}

async function metaPost(
  path: string,
  body: Record<string, unknown>,
  accessToken: string,
): Promise<unknown> {
  const url = new URL(`${META_GRAPH_HOST}/${env().META_GRAPH_API_VERSION}${path}`);
  const res = await request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
    headersTimeout: REQUEST_TIMEOUT_MS,
    bodyTimeout: REQUEST_TIMEOUT_MS,
  }).catch((err: unknown) => {
    throw errors.metaUnavailable(err, { meta_endpoint: path });
  });
  const respBody = (await res.body.json().catch(() => ({}))) as unknown;
  if (res.statusCode >= 400) mapMetaError(res.statusCode, respBody, path);
  return respBody;
}

class UndiciMetaOAuthClient implements MetaOAuthClient {
  async exchangeCode(code: string, redirectUri?: string): Promise<ExchangeCodeResult> {
    const cfg = env();
    if (!cfg.META_APP_ID || !cfg.META_APP_SECRET) {
      throw errors.internal("META_APP_ID/META_APP_SECRET not configured");
    }
    const query: Record<string, string> = {
      client_id: cfg.META_APP_ID,
      client_secret: cfg.META_APP_SECRET,
      code,
    };
    if (redirectUri) query.redirect_uri = redirectUri;
    const body = (await metaGet("/oauth/access_token", query)) as Partial<ExchangeCodeResult>;
    if (typeof body.access_token !== "string") {
      throw errors.metaRejected("Meta /oauth/access_token returned no access_token", {});
    }
    return {
      access_token: body.access_token,
      token_type: body.token_type ?? "bearer",
      expires_in: body.expires_in,
    };
  }

  async exchangeLongLivedToken(currentToken: string): Promise<ExchangeCodeResult> {
    const cfg = env();
    if (!cfg.META_APP_ID || !cfg.META_APP_SECRET) {
      throw errors.internal("META_APP_ID/META_APP_SECRET not configured");
    }
    const body = (await metaGet("/oauth/access_token", {
      grant_type: "fb_exchange_token",
      client_id: cfg.META_APP_ID,
      client_secret: cfg.META_APP_SECRET,
      fb_exchange_token: currentToken,
    })) as Partial<ExchangeCodeResult>;
    if (typeof body.access_token !== "string") {
      throw errors.metaRejected("Meta refresh returned no access_token", {});
    }
    return {
      access_token: body.access_token,
      token_type: body.token_type ?? "bearer",
      expires_in: body.expires_in,
    };
  }

  async discoverWaba(
    accessToken: string,
    hint?: { wabaId?: string; businessId?: string },
  ): Promise<WabaDiscovery> {
    // ES/COEX: o waba_id vem do session info do widget. O token de ES nem sempre
    // expõe whatsapp_business_management como granular scope, então quando temos
    // o waba_id materializamos a WABA direto (GET /{waba_id}); /debug_token vira
    // fallback (fluxo redirect, sem hint).
    if (hint?.wabaId) {
      return this.discoverWabaById(hint.wabaId, accessToken, hint.businessId);
    }

    const cfg = env();
    const debug = (await metaGet("/debug_token", {
      input_token: accessToken,
      access_token: `${cfg.META_APP_ID ?? ""}|${cfg.META_APP_SECRET ?? ""}`,
    })) as { data?: { granular_scopes?: Array<{ scope: string; target_ids?: string[] }> } };

    // Diagnóstico (sem token/PII): apenas o shape dos granular_scopes que a Meta
    // devolveu — nomes dos scopes + contagem de targets, nunca os ids.
    logger().info(
      {
        meta_endpoint: "/debug_token",
        granular_scopes:
          debug.data?.granular_scopes?.map((s) => ({
            scope: s.scope,
            n_targets: s.target_ids?.length ?? 0,
          })) ?? null,
      },
      "debug_token granular_scopes",
    );

    const businesses = debug.data?.granular_scopes?.find(
      (s) => s.scope === "whatsapp_business_management",
    )?.target_ids;
    if (!businesses || businesses.length === 0) {
      throw errors.metaRejected("No WABA scope granted by user", {});
    }
    const businessId = businesses[0]!;

    const wabas = (await metaGet(`/${businessId}/owned_whatsapp_business_accounts`, {
      access_token: accessToken,
      fields: "id,name,verified_name,status",
      limit: "1",
    })) as {
      data?: Array<{ id: string; name?: string; verified_name?: string; status?: string }>;
    };

    const waba = wabas.data?.[0];
    if (!waba) {
      throw errors.metaRejected("No owned WABA returned by Meta", { business_id: businessId });
    }
    return {
      meta_business_id: businessId,
      meta_waba_id: waba.id,
      display_name: waba.verified_name ?? waba.name ?? null,
      verified_status: waba.status ?? null,
    };
  }

  /**
   * Materializa a WABA a partir do waba_id (Embedded Signup). O business_id vem
   * de owner_business_info/on_behalf_of_business_info; se ausentes, usa o hint do
   * front (session info trazia business_id). meta_business_id é NOT NULL no
   * schema — se nenhuma fonte resolver, falha claro (diagnosticável) em vez de
   * quebrar no insert.
   */
  private async discoverWabaById(
    wabaId: string,
    accessToken: string,
    businessIdHint?: string,
  ): Promise<WabaDiscovery> {
    const body = (await metaGet(`/${wabaId}`, {
      access_token: accessToken,
      fields: "id,name,verified_name,status,owner_business_info,on_behalf_of_business_info",
    })) as {
      id?: string;
      name?: string;
      verified_name?: string;
      status?: string;
      owner_business_info?: { id?: string };
      on_behalf_of_business_info?: { id?: string };
    };

    const businessId =
      body.owner_business_info?.id ?? body.on_behalf_of_business_info?.id ?? businessIdHint ?? null;

    // Diagnóstico (sem token/PII): de onde veio o business_id + status da WABA.
    logger().info(
      {
        meta_endpoint: "GET /{waba_id}",
        waba_present: typeof body.id === "string",
        business_source: body.owner_business_info?.id
          ? "owner"
          : body.on_behalf_of_business_info?.id
            ? "obo"
            : businessIdHint
              ? "hint"
              : "none",
        status: typeof body.status === "string" ? body.status : null,
      },
      "es waba materialized by id",
    );

    if (!businessId) {
      throw errors.metaRejected("WABA fetch returned no business id (owner/obo/hint empty)", {
        waba_id: wabaId,
      });
    }
    return {
      meta_business_id: businessId,
      meta_waba_id: body.id ?? wabaId,
      display_name: body.verified_name ?? body.name ?? null,
      verified_status: body.status ?? null,
    };
  }

  async discoverIgAccount(accessToken: string): Promise<IgDiscovery> {
    // V1: usa /me/accounts para listar Pages → cada Page tem instagram_business_account
    // (se vinculada). Pega a primeira página com IG conectado.
    const pages = (await metaGet("/me/accounts", {
      access_token: accessToken,
      fields: "id,instagram_business_account{id,username,account_type}",
      limit: "5",
    })) as {
      data?: Array<{
        id: string;
        instagram_business_account?: { id: string; username?: string; account_type?: string };
      }>;
    };

    const withIg = pages.data?.find((p) => p.instagram_business_account?.id);
    const ig = withIg?.instagram_business_account;
    if (!ig?.id) {
      throw errors.metaRejected("No Instagram Business account linked to user pages", {});
    }
    return {
      meta_ig_id: ig.id,
      username: ig.username ?? "",
      account_type: ig.account_type ?? null,
    };
  }

  async listPhoneNumbers(wabaId: string, accessToken: string): Promise<MetaPhoneNumber[]> {
    const body = (await metaGet(`/${wabaId}/phone_numbers`, {
      access_token: accessToken,
      fields: "id,display_phone_number,verified_name,quality_rating,messaging_limit_tier",
    })) as {
      data?: Array<{
        id: string;
        display_phone_number: string;
        verified_name?: string;
        quality_rating?: string;
        messaging_limit_tier?: string;
      }>;
    };
    return (body.data ?? []).map((p) => ({
      meta_phone_id: p.id,
      display_phone_number: p.display_phone_number,
      verified_name: p.verified_name ?? null,
      quality_rating: p.quality_rating ?? null,
      messaging_limit_tier: p.messaging_limit_tier ?? null,
    }));
  }

  async updatePhoneNumberProfile(
    phoneId: string,
    accessToken: string,
    patch: BusinessProfilePatch,
  ): Promise<void> {
    // Meta exige messaging_product='whatsapp' explicitly.
    const payload: Record<string, unknown> = { messaging_product: "whatsapp" };
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined) payload[k] = v;
    }
    await metaPost(`/${phoneId}/whatsapp_business_profile`, payload, accessToken);
  }

  async subscribeWabaApp(
    wabaId: string,
    accessToken: string,
    override: { callbackUri: string; verifyToken: string },
  ): Promise<void> {
    await metaPost(
      `/${wabaId}/subscribed_apps`,
      {
        override_callback_uri: override.callbackUri,
        verify_token: override.verifyToken,
      },
      accessToken,
    );
  }

  async getPhoneCoexInfo(phoneNumberId: string, accessToken: string): Promise<PhoneCoexInfo> {
    const body = (await metaGet(`/${phoneNumberId}`, {
      access_token: accessToken,
      fields: "is_on_biz_app,platform_type",
    })) as { id?: string; is_on_biz_app?: boolean; platform_type?: string };
    return {
      phone_number_id: body.id ?? phoneNumberId,
      is_on_biz_app: body.is_on_biz_app === true,
      platform_type: typeof body.platform_type === "string" ? body.platform_type : null,
    };
  }

  async triggerSmbAppDataSync(
    phoneNumberId: string,
    accessToken: string,
  ): Promise<SmbAppDataSyncResult> {
    const stateResp = (await metaPost(
      `/${phoneNumberId}/smb_app_data`,
      { messaging_product: "whatsapp", sync_type: "smb_app_state_sync" },
      accessToken,
    )) as { request_id?: string };
    const histResp = (await metaPost(
      `/${phoneNumberId}/smb_app_data`,
      { messaging_product: "whatsapp", sync_type: "history" },
      accessToken,
    )) as { request_id?: string };
    return {
      state_sync_request_id: typeof stateResp.request_id === "string" ? stateResp.request_id : null,
      history_request_id: typeof histResp.request_id === "string" ? histResp.request_id : null,
    };
  }

  async createMessageTemplate(
    wabaId: string,
    accessToken: string,
    input: CreateTemplateInput,
  ): Promise<CreateTemplateResult> {
    const body = (await metaPost(
      `/${wabaId}/message_templates`,
      {
        name: input.name,
        language: input.language,
        category: input.category,
        components: input.components,
      },
      accessToken,
    )) as { id?: string; status?: TemplateStatus; category?: TemplateCategory };

    if (!body.id || !body.status) {
      throw errors.metaRejected("Meta returned malformed template create response", {});
    }
    return {
      meta_template_id: body.id,
      status: body.status,
      category: body.category ?? input.category,
    };
  }

  async getMessageTemplate(
    wabaId: string,
    accessToken: string,
    name: string,
    language: string,
  ): Promise<MetaTemplateRecord | null> {
    const body = (await metaGet(`/${wabaId}/message_templates`, {
      access_token: accessToken,
      name,
      // Meta filtra por name; language vem nos resultados; pegamos o que casa.
      fields: "id,name,language,category,status,quality_score,components",
      limit: "20",
    })) as {
      data?: Array<{
        id: string;
        name: string;
        language: string;
        category: TemplateCategory;
        status: TemplateStatus;
        quality_score?: { score?: number };
        components?: unknown[];
      }>;
    };
    const match = body.data?.find((t) => t.language === language);
    if (!match) return null;
    return {
      meta_template_id: match.id,
      name: match.name,
      language: match.language,
      category: match.category,
      status: match.status,
      quality_score: match.quality_score?.score ?? null,
      components: match.components ?? [],
    };
  }

  async sendWhatsAppMessage(
    phoneId: string,
    accessToken: string,
    body: Record<string, unknown>,
  ): Promise<MetaSendResult> {
    const resp = (await metaPost(`/${phoneId}/messages`, body, accessToken)) as {
      messages?: Array<{ id?: string }>;
    };
    const id = resp.messages?.[0]?.id;
    if (!id) {
      throw errors.metaRejected("WhatsApp send returned no message id", {});
    }
    return { provider_message_id: id };
  }

  async sendInstagramMessage(
    igId: string,
    accessToken: string,
    body: Record<string, unknown>,
  ): Promise<MetaSendResult> {
    const resp = (await metaPost(`/${igId}/messages`, body, accessToken)) as {
      message_id?: string;
    };
    if (!resp.message_id) {
      throw errors.metaRejected("Instagram send returned no message_id", {});
    }
    return { provider_message_id: resp.message_id };
  }

  async deleteMessageTemplate(
    wabaId: string,
    accessToken: string,
    name: string,
    metaTemplateId?: string,
  ): Promise<void> {
    // DELETE /{waba}/message_templates?name={name} (ou hsm_id={id} se fornecido)
    const url = new URL(
      `${META_GRAPH_HOST}/${env().META_GRAPH_API_VERSION}/${wabaId}/message_templates`,
    );
    url.searchParams.set("name", name);
    if (metaTemplateId) url.searchParams.set("hsm_id", metaTemplateId);
    const res = await request(url, {
      method: "DELETE",
      headers: { authorization: `Bearer ${accessToken}` },
      headersTimeout: REQUEST_TIMEOUT_MS,
      bodyTimeout: REQUEST_TIMEOUT_MS,
    }).catch((err: unknown) => {
      throw errors.metaUnavailable(err, { meta_endpoint: "/message_templates" });
    });
    const body = (await res.body.json().catch(() => ({}))) as unknown;
    if (res.statusCode >= 400) mapMetaError(res.statusCode, body, "/message_templates");
  }

  async getMediaMetadata(mediaId: string, token: string): Promise<MediaMetadata> {
    // GET /{media-id} com o WABA Bearer token → metadata incl. temp CDN url.
    const url = new URL(`${META_GRAPH_HOST}/${env().META_GRAPH_API_VERSION}/${mediaId}`);
    const res = await request(url, {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
      headersTimeout: REQUEST_TIMEOUT_MS,
      bodyTimeout: REQUEST_TIMEOUT_MS,
    }).catch((err: unknown) => {
      throw errors.metaUnavailable(err, { meta_endpoint: "/{media-id}" });
    });
    const body = (await res.body.json().catch(() => ({}))) as Partial<MediaMetadata>;
    if (res.statusCode >= 400) mapMetaError(res.statusCode, body, "/{media-id}");
    if (
      typeof body.url !== "string" ||
      typeof body.mime_type !== "string" ||
      typeof body.file_size !== "number"
    ) {
      throw errors.metaRejected("Meta /{media-id} returned malformed media metadata", {
        meta_endpoint: "/{media-id}",
      });
    }
    return {
      url: body.url,
      mime_type: body.mime_type,
      file_size: body.file_size,
      sha256: typeof body.sha256 === "string" ? body.sha256 : undefined,
    };
  }

  async downloadMedia(url: string, token: string): Promise<Buffer> {
    // C2 SSRF guard (audit 2026-06-02): a URL vem do JSON de getMediaMetadata,
    // controlada pela Meta. Antes desta verificação, o WABA Bearer seria
    // enviado a qualquer host — vetor de token-leak. Validar PRIMEIRO,
    // ANTES de gerar o request para que o Bearer nunca saia para
    // domínios fora da allowlist. Throw silencioso sem detalhes do url
    // pra evitar surface de SSRF probing no log.
    if (!isAllowedMetaMediaUrl(url)) {
      throw errors.metaRejected(
        "Media URL host não está na allowlist Meta CDN — request bloqueado para proteger token",
        { meta_endpoint: "media-cdn" },
      );
    }
    // A temp CDN url é absoluta (fora do graph host) mas exige o mesmo Bearer.
    const res = await request(url, {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
      headersTimeout: REQUEST_TIMEOUT_MS,
      bodyTimeout: REQUEST_TIMEOUT_MS,
    }).catch((err: unknown) => {
      throw errors.metaUnavailable(err, { meta_endpoint: "media-cdn" });
    });
    if (res.statusCode >= 400) {
      const body = (await res.body.json().catch(() => ({}))) as unknown;
      mapMetaError(res.statusCode, body, "media-cdn");
    }
    return Buffer.from(await res.body.arrayBuffer());
  }
}

// ---------------------------------------------------------------------------
// Factory + injeção pra testes
// ---------------------------------------------------------------------------

let cached: MetaOAuthClient | null = null;
let override: MetaOAuthClient | null = null;

export function getMetaOAuthClient(): MetaOAuthClient {
  if (override) return override;
  if (!cached) cached = new UndiciMetaOAuthClient();
  return cached;
}

export function setMetaOAuthClientForTests(client: MetaOAuthClient | null): void {
  override = client;
}

export function buildWabaRedirectUri(): string {
  const cfg = env();
  if (!cfg.OAUTH_CALLBACK_BASE_URL) {
    throw errors.internal("OAUTH_CALLBACK_BASE_URL not configured");
  }
  return `${cfg.OAUTH_CALLBACK_BASE_URL}${WABA_CALLBACK_PATH}`;
}

export function buildWebhookCallbackUri(): string {
  const cfg = env();
  if (!cfg.OAUTH_CALLBACK_BASE_URL) {
    throw errors.internal("OAUTH_CALLBACK_BASE_URL not configured");
  }
  return `${cfg.OAUTH_CALLBACK_BASE_URL}${META_WEBHOOK_PATH}`;
}

export function buildIgRedirectUri(): string {
  const cfg = env();
  if (!cfg.OAUTH_CALLBACK_BASE_URL) {
    throw errors.internal("OAUTH_CALLBACK_BASE_URL not configured");
  }
  return `${cfg.OAUTH_CALLBACK_BASE_URL}${IG_CALLBACK_PATH}`;
}
