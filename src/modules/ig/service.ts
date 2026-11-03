/**
 * Service IG — análogo ao wabas/service. KEK separada (MA-008 §Chaves disponíveis).
 */

import type { IgConnection } from "@db/schema/index.js";

import { buildIgRedirectUri, getMetaOAuthClient } from "@/integration/meta-client.js";
import { buildAuthorizeUrl } from "@/integration/meta-oauth.js";
import { encryptToken } from "@/lib/crypto-envelope.js";
import { errors } from "@/lib/errors.js";
import { uuidv7 } from "@/lib/uuid.js";
import { saveOAuthState, STATE_TTL_SECONDS, takeOAuthState } from "@/modules/wabas/oauth-state.js";
import { findTenantById } from "@/modules/tenants/repository.js";

import {
  createIgConnectionWithToken,
  disconnectIg as disconnectIgRepo,
  findIgByTenantAndMetaId,
  findIgConnectionById,
  listIgsByTenant,
  reconnectIg,
} from "./repository.js";
import type { IgConnectionResponse, InitOAuthResponse } from "./schemas.js";

const IG_KEK_ID = "bevox-meta-api/ig-tokens/v1";
const TOKEN_DEFAULT_TTL_SEC = 60 * 24 * 3600;
const TOKEN_REFRESH_WINDOW_SEC = 7 * 24 * 3600;

function toResponse(c: IgConnection): IgConnectionResponse {
  return {
    id: c.id,
    tenant_id: c.tenantId,
    meta_ig_id: c.metaIgId,
    username: c.username,
    account_type: c.accountType,
    created_at: c.createdAt.toISOString(),
    updated_at: c.updatedAt.toISOString(),
    disconnected_at: c.disconnectedAt?.toISOString() ?? null,
  };
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

export async function initIgOAuth(input: {
  appId: string;
  tenantId: string;
  redirectUrl: string;
}): Promise<InitOAuthResponse> {
  const tenant = await findTenantById(input.appId, input.tenantId);
  if (!tenant) throw errors.notFound("tenant", input.tenantId);
  if (tenant.deletedAt !== null) {
    throw errors.conflict("tenant is deleted; cannot connect Instagram", {
      tenant_id: input.tenantId,
    });
  }
  if (tenant.status !== "active") {
    throw errors.conflict("tenant is not active", { status: tenant.status });
  }

  const state = uuidv7();
  await saveOAuthState(state, {
    app_id: input.appId,
    tenant_id: input.tenantId,
    channel: "ig",
    redirect_url: input.redirectUrl,
    created_at: Date.now(),
  });

  return {
    oauth_url: buildAuthorizeUrl({ channel: "ig", state }),
    state,
    expires_in_seconds: STATE_TTL_SECONDS,
  };
}

// ---------------------------------------------------------------------------
// Callback
// ---------------------------------------------------------------------------

export interface HandleCallbackInput {
  code: string;
  state: string;
}

export interface HandleCallbackResult {
  redirectUrl: string;
  igConnectionId: string;
  metaIgId: string;
  reconnected: boolean;
}

export async function handleIgCallback(input: HandleCallbackInput): Promise<HandleCallbackResult> {
  const payload = await takeOAuthState(input.state);
  if (!payload) throw errors.unauthenticated("Invalid or expired OAuth state");
  if (payload.channel !== "ig") {
    throw errors.invalidInput("State does not belong to IG flow", { channel: payload.channel });
  }

  const tenant = await findTenantById(payload.app_id, payload.tenant_id);
  if (!tenant) throw errors.notFound("tenant", payload.tenant_id);
  if (tenant.deletedAt !== null || tenant.status !== "active") {
    throw errors.conflict("tenant inactive at callback time", {
      status: tenant.status,
      deleted: tenant.deletedAt !== null,
    });
  }

  const meta = getMetaOAuthClient();
  const exchanged = await meta.exchangeCode(input.code, buildIgRedirectUri());
  const discovery = await meta.discoverIgAccount(exchanged.access_token);

  const ctx = {
    tenant_id: payload.tenant_id,
    ig_id: discovery.meta_ig_id,
    app_id: payload.app_id,
    v: "1",
  };

  const tokenBytes = Buffer.from(exchanged.access_token, "utf8");
  let envelope;
  try {
    envelope = await encryptToken(tokenBytes, IG_KEK_ID, ctx);
  } finally {
    tokenBytes.fill(0);
  }

  const ttlSec = exchanged.expires_in ?? TOKEN_DEFAULT_TTL_SEC;
  const expiresAt = new Date(Date.now() + ttlSec * 1000);
  const refreshAt = new Date(Date.now() + Math.max(60, ttlSec - TOKEN_REFRESH_WINDOW_SEC) * 1000);

  const existing = await findIgByTenantAndMetaId(payload.tenant_id, discovery.meta_ig_id);
  let connectionId: string;
  let reconnected = false;
  if (existing) {
    const r = await reconnectIg(
      existing.id,
      { username: discovery.username, accountType: discovery.account_type },
      envelope,
      expiresAt,
      refreshAt,
    );
    connectionId = r.connection.id;
    reconnected = true;
  } else {
    const r = await createIgConnectionWithToken({
      tenantId: payload.tenant_id,
      appId: payload.app_id,
      metaIgId: discovery.meta_ig_id,
      username: discovery.username,
      accountType: discovery.account_type,
      envelope,
      expiresAt,
      refreshAt,
    });
    connectionId = r.connection.id;
  }

  const url = new URL(payload.redirect_url);
  url.searchParams.set("success", "true");
  url.searchParams.set("ig_id", discovery.meta_ig_id);
  url.searchParams.set("ig_connection_id", connectionId);
  if (reconnected) url.searchParams.set("reconnected", "true");

  return {
    redirectUrl: url.toString(),
    igConnectionId: connectionId,
    metaIgId: discovery.meta_ig_id,
    reconnected,
  };
}

// ---------------------------------------------------------------------------
// List + Disconnect
// ---------------------------------------------------------------------------

export async function listIgs(
  appId: string,
  tenantId: string,
  includeDisconnected: boolean,
): Promise<IgConnectionResponse[]> {
  const tenant = await findTenantById(appId, tenantId);
  if (!tenant) throw errors.notFound("tenant", tenantId);
  const rows = await listIgsByTenant(appId, tenantId, { includeDisconnected });
  return rows.map(toResponse);
}

export async function disconnectIgConnection(
  appId: string,
  tenantId: string,
  igConnectionId: string,
): Promise<IgConnectionResponse> {
  const existing = await findIgConnectionById(appId, tenantId, igConnectionId);
  if (!existing) throw errors.notFound("ig_connection", igConnectionId);
  if (existing.disconnectedAt !== null) {
    throw errors.conflict("ig already disconnected", { ig_connection_id: igConnectionId });
  }
  const row = await disconnectIgRepo(appId, tenantId, igConnectionId);
  if (!row) throw errors.conflict("ig state changed concurrently");
  return toResponse(row);
}
