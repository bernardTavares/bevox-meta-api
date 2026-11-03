/**
 * Service — orquestra fluxos OAuth WABA.
 *
 * V1 escopo: init connection. Callback handler vem na task #13.
 */

import type { WabaConnection } from "@db/schema/index.js";

import { env } from "@/config/env.js";
import {
  buildWabaRedirectUri,
  buildWebhookCallbackUri,
  getMetaOAuthClient,
  type WabaDiscovery,
} from "@/integration/meta-client.js";
import { buildAuthorizeUrl } from "@/integration/meta-oauth.js";
import { encryptToken } from "@/lib/crypto-envelope.js";
import { errors } from "@/lib/errors.js";
import { logger } from "@/lib/logger.js";
import { uuidv7 } from "@/lib/uuid.js";
import { findTenantById } from "@/modules/tenants/repository.js";

import { saveOAuthState, STATE_TTL_SECONDS, takeOAuthState } from "./oauth-state.js";
import {
  createWabaConnectionWithToken,
  disconnectWaba as disconnectWabaRepo,
  findWabaByTenantAndMetaId,
  findWabaConnectionById,
  listWabasByTenant,
  reconnectWaba,
} from "./repository.js";
import type { InitOAuthResponse, WabaConnectionResponse } from "./schemas.js";

export interface InitWabaOAuthInput {
  appId: string;
  tenantId: string;
  redirectUrl: string;
}

export async function initWabaOAuth(input: InitWabaOAuthInput): Promise<InitOAuthResponse> {
  const tenant = await findTenantById(input.appId, input.tenantId);
  if (!tenant) throw errors.notFound("tenant", input.tenantId);
  if (tenant.deletedAt !== null) {
    throw errors.conflict("tenant is deleted; cannot connect WABA", {
      tenant_id: input.tenantId,
    });
  }
  if (tenant.status !== "active") {
    throw errors.conflict("tenant is not active", {
      tenant_id: input.tenantId,
      status: tenant.status,
    });
  }

  const state = uuidv7();
  await saveOAuthState(state, {
    app_id: input.appId,
    tenant_id: input.tenantId,
    channel: "waba",
    redirect_url: input.redirectUrl,
    created_at: Date.now(),
  });

  const oauthUrl = buildAuthorizeUrl({ channel: "waba", state });

  return {
    oauth_url: oauthUrl,
    state,
    expires_in_seconds: STATE_TTL_SECONDS,
    config_id: env().META_ES_CONFIG_ID,
    meta_app_id: env().META_APP_ID,
    graph_version: env().META_GRAPH_API_VERSION,
  };
}

// ---------------------------------------------------------------------------
// Callback OAuth
// ---------------------------------------------------------------------------

const WABA_KEK_ID = "bevox-meta-api/waba-tokens/v1";
// Fallback quando Meta não retorna expires_in (token long-lived). 60 dias é
// o padrão Meta para tokens de page; refresh worker fará rotação contínua.
const TOKEN_DEFAULT_TTL_SEC = 60 * 24 * 3600;
// Janela antes de expires_at em que o refresh worker deve agir.
const TOKEN_REFRESH_WINDOW_SEC = 7 * 24 * 3600;

/** Valida que o tenant existe e está ativo (usado por callback e complete). */
async function validateActiveTenant(appId: string, tenantId: string): Promise<void> {
  const tenant = await findTenantById(appId, tenantId);
  if (!tenant) throw errors.notFound("tenant", tenantId);
  if (tenant.deletedAt !== null || tenant.status !== "active") {
    throw errors.conflict("tenant inactive", {
      status: tenant.status,
      deleted: tenant.deletedAt !== null,
    });
  }
}

/**
 * Registra o webhook per-WABA, cifra o token (AAD anti-swap) e persiste a
 * conexão (create ou reconnect). Compartilhado por callback (redirect) e
 * completeEmbeddedSignup (ES). Falha no subscribe aborta antes de persistir.
 */
async function subscribeEncryptPersistWaba(args: {
  appId: string;
  tenantId: string;
  accessToken: string;
  expiresIn: number | undefined;
  discovery: WabaDiscovery;
}): Promise<{ connectionId: string; reconnected: boolean }> {
  const cfg = env();
  if (!cfg.META_WEBHOOK_VERIFY_TOKEN) {
    throw errors.internal("META_WEBHOOK_VERIFY_TOKEN not configured");
  }
  await getMetaOAuthClient().subscribeWabaApp(args.discovery.meta_waba_id, args.accessToken, {
    callbackUri: buildWebhookCallbackUri(),
    verifyToken: cfg.META_WEBHOOK_VERIFY_TOKEN,
  });

  const ctx = {
    tenant_id: args.tenantId,
    waba_id: args.discovery.meta_waba_id,
    app_id: args.appId,
    v: "1",
  };
  const tokenBytes = Buffer.from(args.accessToken, "utf8");
  let envelope;
  try {
    envelope = await encryptToken(tokenBytes, WABA_KEK_ID, ctx);
  } finally {
    tokenBytes.fill(0);
  }

  const ttlSec = args.expiresIn ?? TOKEN_DEFAULT_TTL_SEC;
  const expiresAt = new Date(Date.now() + ttlSec * 1000);
  const refreshAt = new Date(Date.now() + Math.max(60, ttlSec - TOKEN_REFRESH_WINDOW_SEC) * 1000);

  const existing = await findWabaByTenantAndMetaId(args.tenantId, args.discovery.meta_waba_id);
  if (existing) {
    const r = await reconnectWaba(
      existing.id,
      { displayName: args.discovery.display_name, verifiedStatus: args.discovery.verified_status },
      envelope,
      expiresAt,
      refreshAt,
    );
    return { connectionId: r.connection.id, reconnected: true };
  }
  const r = await createWabaConnectionWithToken({
    tenantId: args.tenantId,
    appId: args.appId,
    metaBusinessId: args.discovery.meta_business_id,
    metaWabaId: args.discovery.meta_waba_id,
    displayName: args.discovery.display_name,
    verifiedStatus: args.discovery.verified_status,
    envelope,
    expiresAt,
    refreshAt,
  });
  return { connectionId: r.connection.id, reconnected: false };
}

export interface HandleCallbackInput {
  code: string;
  state: string;
}

export interface HandleCallbackResult {
  redirectUrl: string;
  wabaConnectionId: string;
  metaWabaId: string;
  reconnected: boolean;
}

export async function handleWabaCallback(
  input: HandleCallbackInput,
): Promise<HandleCallbackResult> {
  const payload = await takeOAuthState(input.state);
  if (!payload) throw errors.unauthenticated("Invalid or expired OAuth state");
  if (payload.channel !== "waba") {
    throw errors.invalidInput("State does not belong to WABA flow", {
      channel: payload.channel,
    });
  }

  await validateActiveTenant(payload.app_id, payload.tenant_id);

  const meta = getMetaOAuthClient();
  const exchanged = await meta.exchangeCode(input.code, buildWabaRedirectUri());
  const discovery = await meta.discoverWaba(exchanged.access_token);

  const { connectionId, reconnected } = await subscribeEncryptPersistWaba({
    appId: payload.app_id,
    tenantId: payload.tenant_id,
    accessToken: exchanged.access_token,
    expiresIn: exchanged.expires_in,
    discovery,
  });

  const url = new URL(payload.redirect_url);
  url.searchParams.set("success", "true");
  url.searchParams.set("waba_id", discovery.meta_waba_id);
  url.searchParams.set("waba_connection_id", connectionId);
  if (reconnected) url.searchParams.set("reconnected", "true");

  return {
    redirectUrl: url.toString(),
    wabaConnectionId: connectionId,
    metaWabaId: discovery.meta_waba_id,
    reconnected,
  };
}

// ---------------------------------------------------------------------------
// Embedded Signup — POST .../wabas/connect/complete
// ---------------------------------------------------------------------------

export interface CompleteEmbeddedSignupInput {
  appId: string;
  tenantId: string;
  code: string;
  wabaIdHint?: string;
  phoneNumberIdHint?: string;
  businessIdHint?: string;
  coexistence: boolean;
}

export async function completeEmbeddedSignup(
  input: CompleteEmbeddedSignupInput,
): Promise<WabaConnectionResponse> {
  await validateActiveTenant(input.appId, input.tenantId);

  // COEX exige phone_number_id (vem do front via session logging) para
  // confirmar coexistence + disparar o sync de 24h. Verbatim C/F. Falha cedo,
  // antes de qualquer chamada Meta.
  if (input.coexistence && !input.phoneNumberIdHint) {
    throw errors.invalidInput("phone_number_id is required for coexistence onboarding", {
      coexistence: true,
    });
  }

  const meta = getMetaOAuthClient();
  // ES/COEX: code vem do widget → exchange SEM redirect_uri (ver spec §4).
  const exchanged = await meta.exchangeCode(input.code);
  // ES/COEX: materializa a WABA a partir do waba_id que o front capturou no
  // session info do widget. discoverWaba faz GET /{waba_id} quando há hint
  // (o token de ES nem sempre traz whatsapp_business_management no /debug_token);
  // /debug_token é só fallback (fluxo redirect, sem hint). O GET valida que o
  // token acessa a WABA — substitui o cross-check anterior.
  const discovery = await meta.discoverWaba(exchanged.access_token, {
    wabaId: input.wabaIdHint,
    businessId: input.businessIdHint,
  });

  // COEX: confirma que o número está em coexistence ANTES de persistir.
  // Verbatim F1: is_on_biz_app=true E platform_type=CLOUD_API.
  if (input.coexistence) {
    const phoneInfo = await meta.getPhoneCoexInfo(input.phoneNumberIdHint!, exchanged.access_token);
    if (!phoneInfo.is_on_biz_app || phoneInfo.platform_type !== "CLOUD_API") {
      throw errors.conflict("phone number is not in coexistence mode", {
        phone_number_id: input.phoneNumberIdHint,
        is_on_biz_app: phoneInfo.is_on_biz_app,
        platform_type: phoneInfo.platform_type,
      });
    }
  }

  const { connectionId } = await subscribeEncryptPersistWaba({
    appId: input.appId,
    tenantId: input.tenantId,
    accessToken: exchanged.access_token,
    expiresIn: exchanged.expires_in,
    discovery,
  });

  // COEX: dispara o sync obrigatório de 24h (contatos + histórico). Best-effort:
  // resultado real chega via webhooks; falha aqui não invalida a conexão (o
  // consumer pode re-disparar). NUNCA logar token — só request_ids/ids.
  if (input.coexistence) {
    try {
      const sync = await meta.triggerSmbAppDataSync(
        input.phoneNumberIdHint!,
        exchanged.access_token,
      );
      logger().info(
        {
          waba_connection_id: connectionId,
          meta_waba_id: discovery.meta_waba_id,
          state_sync_request_id: sync.state_sync_request_id,
          history_request_id: sync.history_request_id,
        },
        "coex smb_app_data sync triggered",
      );
    } catch (err) {
      logger().warn(
        { err, waba_connection_id: connectionId, meta_waba_id: discovery.meta_waba_id },
        "coex smb_app_data sync failed (non-blocking; consumer may retry)",
      );
    }
  }

  const conn = await findWabaConnectionById(input.appId, input.tenantId, connectionId);
  if (!conn) throw errors.internal("waba connection not found after persist");
  return toResponse(conn);
}

// ---------------------------------------------------------------------------
// List + Disconnect
// ---------------------------------------------------------------------------

function toResponse(w: WabaConnection): WabaConnectionResponse {
  return {
    id: w.id,
    tenant_id: w.tenantId,
    meta_business_id: w.metaBusinessId,
    meta_waba_id: w.metaWabaId,
    display_name: w.displayName,
    verified_status: w.verifiedStatus,
    created_at: w.createdAt.toISOString(),
    updated_at: w.updatedAt.toISOString(),
    disconnected_at: w.disconnectedAt?.toISOString() ?? null,
  };
}

export async function listWabas(
  appId: string,
  tenantId: string,
  includeDisconnected: boolean,
): Promise<WabaConnectionResponse[]> {
  const tenant = await findTenantById(appId, tenantId);
  if (!tenant) throw errors.notFound("tenant", tenantId);
  const rows = await listWabasByTenant(appId, tenantId, { includeDisconnected });
  return rows.map(toResponse);
}

export async function disconnectWaba(
  appId: string,
  tenantId: string,
  wabaConnectionId: string,
): Promise<WabaConnectionResponse> {
  const existing = await findWabaConnectionById(appId, tenantId, wabaConnectionId);
  if (!existing) throw errors.notFound("waba_connection", wabaConnectionId);
  if (existing.disconnectedAt !== null) {
    throw errors.conflict("waba already disconnected", {
      waba_connection_id: wabaConnectionId,
    });
  }
  const row = await disconnectWabaRepo(appId, tenantId, wabaConnectionId);
  if (!row) throw errors.conflict("waba state changed concurrently");
  return toResponse(row);
}
