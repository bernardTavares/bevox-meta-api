/**
 * Service — envio síncrono (POST /v1/messages).
 *
 * Fluxo:
 *   1. Resolve tenant (X-Tenant-Id) e valida ownership.
 *   2. Resolve binding ativo do canal (WhatsApp: WabaConnection + phone_number;
 *      Instagram: IgConnection). Default = primeiro ativo; se `from` fornecido,
 *      busca exato.
 *   3. Resolve token plaintext (envelope decryption).
 *   4. Traduz payload normalizado → payload Meta.
 *   5. Chama Meta (10s timeout via undici).
 *   6. Persiste OutboundJob (sent ou failed) com payload redacted.
 *   7. Retorna resultado canônico.
 */

import { getMetaOAuthClient } from "@/integration/meta-client.js";
import { errors } from "@/lib/errors.js";
import { redact } from "@/lib/logger.js";
import { sealOutboundJobSecrets } from "@/lib/job-seal.js";
import { findIgConnectionById, listIgsByTenant } from "@/modules/ig/repository.js";
import { findPhoneByMetaId, listPhoneNumbersByWaba } from "@/modules/phone-numbers/repository.js";
import { findTenantById } from "@/modules/tenants/repository.js";
import { listWabasByTenant } from "@/modules/wabas/repository.js";
import { resolveActiveWabaToken } from "@/modules/wabas/token-resolver.js";

import { getOutboundQueue, type OutboundJobPayload } from "@/lib/queues.js";

import { findOutboundJob, insertOutboundJob, insertQueuedJob } from "./repository.js";
import type {
  EnqueueMessageBody,
  JobStatusResponse,
  MessageDetailResponse,
  SendMessageBody,
  SendMessageResponse,
} from "./schemas.js";

interface ResolvedSender {
  channel: "whatsapp" | "instagram";
  /** WhatsApp: meta_phone_id. Instagram: meta_ig_id. */
  metaSenderId: string;
  /** WhatsApp only: id da WabaConnection (para resolver token). */
  wabaConnectionId?: string;
  /** Instagram only: id do IgConnection (para resolver token futuro). */
  igConnectionId?: string;
}

async function resolveWhatsAppSender(
  appId: string,
  tenantId: string,
  from?: string,
): Promise<ResolvedSender> {
  const wabas = await listWabasByTenant(appId, tenantId, { includeDisconnected: false });
  if (wabas.length === 0) {
    throw errors.conflict("tenant has no active WhatsApp Business Account", { tenantId });
  }
  for (const waba of wabas) {
    if (from) {
      const phone = await findPhoneByMetaId(waba.id, from);
      if (phone) {
        return { channel: "whatsapp", metaSenderId: from, wabaConnectionId: waba.id };
      }
      continue;
    }
    const phones = await listPhoneNumbersByWaba(waba.id);
    if (phones.length > 0) {
      return {
        channel: "whatsapp",
        metaSenderId: phones[0]!.metaPhoneId,
        wabaConnectionId: waba.id,
      };
    }
  }
  throw errors.conflict(
    from
      ? `phone_number "${from}" not found in any active WABA of tenant`
      : "no phone_numbers synced for tenant — call GET /phone-numbers first",
    { tenantId, from },
  );
}

async function resolveInstagramSender(
  appId: string,
  tenantId: string,
  from?: string,
): Promise<ResolvedSender> {
  const igs = await listIgsByTenant(appId, tenantId, { includeDisconnected: false });
  if (igs.length === 0) {
    throw errors.conflict("tenant has no active Instagram account", { tenantId });
  }
  if (from) {
    const match = igs.find((ig) => ig.metaIgId === from);
    if (!match) {
      throw errors.conflict(`Instagram account "${from}" not found for tenant`, { tenantId });
    }
    // Validação adicional via lookup do id local (defensiva).
    const exists = await findIgConnectionById(appId, tenantId, match.id);
    if (!exists) throw errors.conflict("ig binding inconsistent", { tenantId });
    return { channel: "instagram", metaSenderId: from, igConnectionId: match.id };
  }
  const first = igs[0]!;
  return { channel: "instagram", metaSenderId: first.metaIgId, igConnectionId: first.id };
}

function buildWhatsAppPayload(body: SendMessageBody): Record<string, unknown> {
  const base: Record<string, unknown> = {
    messaging_product: "whatsapp",
    to: body.to,
  };
  switch (body.type) {
    case "text":
      return { ...base, type: "text", text: { body: body.content.body } };
    case "template":
      return {
        ...base,
        type: "template",
        template: {
          name: body.content.name,
          language: { code: body.content.language },
          ...(body.content.components ? { components: body.content.components } : {}),
        },
      };
    case "image":
      return {
        ...base,
        type: "image",
        image: {
          link: body.content.link,
          ...(body.content.caption ? { caption: body.content.caption } : {}),
        },
      };
  }
}

function buildInstagramPayload(body: SendMessageBody): Record<string, unknown> {
  // Instagram messaging API espera shape diferente.
  if (body.type !== "text") {
    throw errors.invalidInput(`Instagram channel only supports type=text in V1`, {
      type: body.type,
    });
  }
  return {
    recipient: { id: body.to },
    message: { text: body.content.body },
  };
}

export async function sendMessage(input: {
  appId: string;
  tenantId: string;
  idempotencyKey: string;
  body: SendMessageBody;
}): Promise<SendMessageResponse> {
  const tenant = await findTenantById(input.appId, input.tenantId);
  if (!tenant) throw errors.notFound("tenant", input.tenantId);
  if (tenant.deletedAt !== null || tenant.status !== "active") {
    throw errors.conflict("tenant inactive", { tenantId: input.tenantId });
  }

  const sender =
    input.body.channel === "whatsapp"
      ? await resolveWhatsAppSender(input.appId, input.tenantId, input.body.from)
      : await resolveInstagramSender(input.appId, input.tenantId, input.body.from);

  // Token: WABA tem resolver pronto. IG ainda não tem dedicado — para V1 falha.
  if (sender.channel === "instagram") {
    throw errors.internal("Instagram token resolution not yet implemented (task #20)");
  }
  const token = await resolveActiveWabaToken(sender.wabaConnectionId!);

  const meta = getMetaOAuthClient();
  const metaBody =
    sender.channel === "whatsapp"
      ? buildWhatsAppPayload(input.body)
      : buildInstagramPayload(input.body);

  // Para audit: payload com PII redacted (NUNCA o conteúdo cru).
  const auditPayload = redact(input.body) as Record<string, unknown>;

  let providerMessageId: string;
  try {
    const result =
      sender.channel === "whatsapp"
        ? await meta.sendWhatsAppMessage(sender.metaSenderId, token.accessToken, metaBody)
        : await meta.sendInstagramMessage(sender.metaSenderId, token.accessToken, metaBody);
    providerMessageId = result.provider_message_id;
  } catch (err) {
    // Persiste como failed e propaga o erro.
    await insertOutboundJob({
      tenantId: input.tenantId,
      appId: input.appId,
      idempotencyKey: input.idempotencyKey,
      channel: sender.channel,
      payloadJson: auditPayload,
      status: "failed",
      attempts: 1,
      providerMessageId: null,
      lastError: err instanceof Error ? err.message : String(err),
      completedAt: new Date(),
    });
    throw err;
  }

  const job = await insertOutboundJob({
    tenantId: input.tenantId,
    appId: input.appId,
    idempotencyKey: input.idempotencyKey,
    channel: sender.channel,
    payloadJson: auditPayload,
    status: "sent",
    attempts: 1,
    providerMessageId,
    lastError: null,
    completedAt: new Date(),
  });

  return {
    message_id: job.id,
    provider_message_id: providerMessageId,
    channel: sender.channel,
    status: "sent",
  };
}

// ---------------------------------------------------------------------------
// Async (queue)
// ---------------------------------------------------------------------------

export async function enqueueMessage(input: {
  appId: string;
  tenantId: string;
  idempotencyKey: string;
  body: EnqueueMessageBody;
}): Promise<{ job_id: string; status: "queued" }> {
  const tenant = await findTenantById(input.appId, input.tenantId);
  if (!tenant) throw errors.notFound("tenant", input.tenantId);
  if (tenant.deletedAt !== null || tenant.status !== "active") {
    throw errors.conflict("tenant inactive", { tenantId: input.tenantId });
  }

  // Audit-friendly payload (PII redacted) na coluna payload_json.
  const auditPayload = redact(input.body) as Record<string, unknown>;

  const job = await insertQueuedJob({
    tenantId: input.tenantId,
    appId: input.appId,
    idempotencyKey: input.idempotencyKey,
    channel: input.body.channel,
    payloadJson: auditPayload,
  });

  // Fix A3 (audit 2026-06-02): cifra request_body + callback_secret em
  // envelope AES-256-GCM antes de enfileirar. Redis (BullMQ) NUNCA vê o
  // número de telefone, o conteúdo da mensagem, ou o segredo HMAC do
  // callback. Worker decifra no consumo via `unsealOutboundJobSecrets`.
  // `request_body` aqui exclui callback_url/callback_secret (campos do
  // wrapper de enqueue) — só passamos o que o worker vai reenviar à Meta.
  const { callback_url: _cbUrl, callback_secret: cbSecret, ...rawRequestBody } = input.body;
  const sealed = await sealOutboundJobSecrets({
    appId: input.appId,
    tenantId: input.tenantId,
    jobId: job.id,
    secrets: {
      request_body: rawRequestBody as Record<string, unknown>,
      ...(cbSecret !== undefined ? { callback_secret: cbSecret } : {}),
    },
  });

  const queuePayload: OutboundJobPayload = {
    job_id: job.id,
    app_id: input.appId,
    tenant_id: input.tenantId,
    idempotency_key: input.idempotencyKey,
    channel: input.body.channel,
    sealed_secrets: sealed,
    callback_url: input.body.callback_url,
  };

  // jobId = OutboundJob.id (UUIDv7) — duplicate add é no-op no BullMQ.
  await getOutboundQueue().add("send", queuePayload, { jobId: job.id });

  return { job_id: job.id, status: "queued" };
}

export async function getJobStatus(appId: string, jobId: string): Promise<JobStatusResponse> {
  const job = await findOutboundJob(appId, jobId);
  if (!job) throw errors.notFound("job", jobId);
  return {
    job_id: job.id,
    status: job.status,
    channel: job.channel,
    attempts: job.attempts,
    provider_message_id: job.providerMessageId,
    error: job.lastError,
    created_at: job.createdAt.toISOString(),
    completed_at: job.completedAt?.toISOString() ?? null,
  };
}

// ---------------------------------------------------------------------------
// GET /v1/messages/:message_id (A11 — detalhe de mensagem)
// ---------------------------------------------------------------------------

/**
 * Mapeia o status interno do OutboundJob para o enum público da spec
 * (`MessageSendResult.status`: queued | sent | delivered | read | failed).
 *
 * - `sending` ainda não chegou ao provedor → exposto como `queued` (mesma
 *   semântica de "ainda não saiu").
 * - `expired` esgotou retries sem sucesso → exposto como `failed`.
 * - `delivered` e `read` virão quando os status updates do webhook forem
 *   reconciliados nesta tabela (follow-up canon).
 */
function mapJobStatusToPublic(
  status: "queued" | "sending" | "sent" | "failed" | "expired",
): "queued" | "sent" | "failed" {
  switch (status) {
    case "queued":
    case "sending":
      return "queued";
    case "sent":
      return "sent";
    case "failed":
    case "expired":
      return "failed";
  }
}

export async function getMessage(appId: string, messageId: string): Promise<MessageDetailResponse> {
  // findOutboundJob já filtra por app_id — outro app NÃO vê mensagens
  // alheias (defesa contra IDOR). Resposta 404 indistinguível para
  // "não existe" vs "existe mas é de outro app".
  const job = await findOutboundJob(appId, messageId);
  if (!job) throw errors.notFound("message", messageId);
  return {
    message_id: job.id,
    provider_message_id: job.providerMessageId,
    status: mapJobStatusToPublic(job.status),
    error: job.lastError ? { code: "META_REJECTED", message: job.lastError } : null,
    sent_at: job.completedAt?.toISOString() ?? null,
  };
}
