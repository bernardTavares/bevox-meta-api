/**
 * Service — webhook subscriptions (push V1).
 *
 * Fluxo de criação:
 *   1. Valida URL https.
 *   2. Gera challenge random (16 bytes hex).
 *   3. POST {verification_challenge} para a URL com timeout 5s.
 *   4. Espera 200 OK com {challenge: <mesmo>}. Senão recusa.
 *   5. Gera signing secret (32 bytes random base64).
 *   6. Cifra com envelope (KEK 'bevox-meta-api/webhook-secrets/v1').
 *   7. Persiste WebhookSubscription status=active.
 *   8. Retorna subscription + secret (uma única vez — não persistimos plaintext).
 */

import { randomBytes } from "node:crypto";

import { request } from "undici";

import type { WebhookSubscription } from "@db/schema/index.js";

import { encryptToken } from "@/lib/crypto-envelope.js";
import { errors } from "@/lib/errors.js";
import { getWebhookDeliveryQueue, webhookDeliveryJobOptions } from "@/lib/queues.js";
import { findTenantById } from "@/modules/tenants/repository.js";

import {
  findSubscriptionScoped,
  insertSubscription,
  listDeadLetterDeliveries,
  listSubscriptionsByApp,
  resetDeliveryForReplay,
  setSubscriptionStatus,
} from "./repository.js";
import type {
  CreateSubscriptionBody,
  CreateSubscriptionResponse,
  SubscriptionResponse,
} from "./schemas.js";

const WEBHOOK_KEK_ID = "bevox-meta-api/webhook-secrets/v1";
const VERIFICATION_TIMEOUT_MS = 5_000;

function toResponse(s: WebhookSubscription): SubscriptionResponse {
  return {
    id: s.id,
    app_id: s.appId,
    tenant_id: s.tenantId,
    delivery_mode: "push",
    url: s.url,
    event_types_filter: s.eventTypesFilter,
    status: s.status,
    created_at: s.createdAt.toISOString(),
  };
}

interface VerifierClient {
  verify(url: string, challenge: string): Promise<{ ok: boolean; reason?: string }>;
}

const undiciVerifier: VerifierClient = {
  async verify(url: string, challenge: string) {
    try {
      const res = await request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ verification_challenge: challenge }),
        headersTimeout: VERIFICATION_TIMEOUT_MS,
        bodyTimeout: VERIFICATION_TIMEOUT_MS,
      });
      if (res.statusCode !== 200) {
        return { ok: false, reason: `verification returned HTTP ${res.statusCode}` };
      }
      const body = (await res.body.json().catch(() => ({}))) as { challenge?: unknown };
      if (body.challenge !== challenge) {
        return { ok: false, reason: "challenge echo mismatch" };
      }
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  },
};

let verifierOverride: VerifierClient | null = null;
export function setVerifierClientForTests(v: VerifierClient | null): void {
  verifierOverride = v;
}
function verifier(): VerifierClient {
  return verifierOverride ?? undiciVerifier;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createSubscription(input: {
  appId: string;
  body: CreateSubscriptionBody;
}): Promise<CreateSubscriptionResponse> {
  if (input.body.tenant_id) {
    const tenant = await findTenantById(input.appId, input.body.tenant_id);
    if (!tenant) throw errors.notFound("tenant", input.body.tenant_id);
  }

  // 1. Verificação de URL via challenge.
  const challenge = randomBytes(16).toString("hex");
  const result = await verifier().verify(input.body.url, challenge);
  if (!result.ok) {
    throw errors.invalidInput("Webhook URL verification failed", {
      reason: result.reason,
      url: input.body.url,
    });
  }

  // 2. Gera signing secret e cifra.
  const secret = randomBytes(32).toString("base64");
  const ctx = {
    app_id: input.appId,
    tenant_id: input.body.tenant_id ?? "global",
    purpose: "webhook-subscription-secret",
    v: "1",
  };
  const secretBytes = Buffer.from(secret, "utf8");
  let envelope;
  try {
    envelope = await encryptToken(secretBytes, WEBHOOK_KEK_ID, ctx);
  } finally {
    secretBytes.fill(0);
  }

  // 3. Persist.
  const row = await insertSubscription({
    appId: input.appId,
    tenantId: input.body.tenant_id ?? null,
    url: input.body.url,
    eventTypesFilter: input.body.event_types_filter ?? [],
    secretCiphertext: envelope.ciphertext,
    secretDekCiphertext: envelope.dekCiphertext,
    secretDekKeyId: envelope.dekKeyId,
    secretEncryptionContext: envelope.encryptionContext,
    secretAlgo: envelope.algo,
    secretNonce: envelope.nonce,
    secretAuthTag: envelope.authTag,
  });

  return { ...toResponse(row), signing_secret: secret };
}

// ---------------------------------------------------------------------------
// List / Delete
// ---------------------------------------------------------------------------

export async function listSubscriptions(appId: string): Promise<SubscriptionResponse[]> {
  const rows = await listSubscriptionsByApp(appId);
  return rows.map(toResponse);
}

export async function disableSubscription(
  appId: string,
  id: string,
): Promise<SubscriptionResponse> {
  const existing = await findSubscriptionScoped(appId, id);
  if (!existing) throw errors.notFound("subscription", id);
  if (existing.status === "disabled") {
    throw errors.conflict("subscription already disabled", { id });
  }
  const row = await setSubscriptionStatus(appId, id, "disabled");
  if (!row) throw errors.conflict("subscription state changed concurrently");
  return toResponse(row);
}

// ---------------------------------------------------------------------------
// Replay (admin)
// ---------------------------------------------------------------------------

export async function replayDeadLetters(
  subscriptionId: string,
): Promise<{ subscription_id: string; replayed: number }> {
  // Admin endpoint: não app-scoped (admin pode replay de qualquer app).
  // V1 simplificação — em prod talvez exigir app_id explícito.
  const rows = await listDeadLetterDeliveries(subscriptionId);
  const queue = getWebhookDeliveryQueue();
  for (const r of rows) {
    await resetDeliveryForReplay(r.id);
    // C3: explicita attempts/backoff PRD §10.2 também no replay-path,
    // para que jobs reinjetados respeitem o mesmo contrato do produtor
    // inbound (sem isso, jobs reinjetados herdariam `defaultJobOptions`
    // da queue criada antes do fix).
    await queue.add(
      "deliver",
      {
        subscription_id: subscriptionId,
        inbound_event_id: r.inboundEventId,
        event_type: "replay",
      },
      { jobId: `replay:${r.id}:${Date.now()}`, ...webhookDeliveryJobOptions() },
    );
  }
  return { subscription_id: subscriptionId, replayed: rows.length };
}
