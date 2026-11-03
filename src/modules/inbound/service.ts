/**
 * Service — recepção de webhooks Meta (PRD §10.1).
 *
 * Pipeline:
 *   1. HMAC X-Hub-Signature-256 validado pela camada de routes (precisa do
 *      raw body — feito antes de chegar aqui).
 *   2. Dedupe por meta_event_id em Redis (SETNX TTL 24h).
 *   3. Resolve tenant via meta_waba_id ou meta_ig_id.
 *   4. Persiste InboundEvent com payload redacted.
 *   5. Lista subscriptions ativas + enfileira WebhookDelivery por subscription.
 *   6. Retorna 200 OK rapidamente (Meta exige < 5s).
 */

import { publishEvent } from "@/lib/event-bus.js";
import { logger, redactSecrets } from "@/lib/logger.js";
import { metaWebhookProcessedTotal } from "@/lib/metrics.js";
import {
  getMediaDownloadQueue,
  getWebhookDeliveryQueue,
  webhookDeliveryJobOptions,
} from "@/lib/queues.js";
import { getRedis } from "@/lib/redis.js";
import { findIgByMetaIgId } from "@/modules/ig/repository.js";
import { disconnectWabaByMetaWabaId, findWabaByMetaWabaId } from "@/modules/wabas/repository.js";

import { insertInboundEvent, listActiveSubscriptions } from "./repository.js";

/** Objeto de mídia embutido numa mensagem WhatsApp inbound (Meta Cloud API). */
type MetaInboundMediaObject = {
  id?: string;
  mime_type?: string;
  filename?: string;
  caption?: string;
};

type MetaInboundMessage = {
  id?: string;
  type?: string;
} & Partial<Record<"image" | "audio" | "document" | "video" | "sticker", MetaInboundMediaObject>>;

export type MetaWebhookPayload = {
  object: string;
  entry?: Array<{
    id: string;
    changes?: Array<{
      field: string;
      value: Record<string, unknown> & {
        messages?: Array<MetaInboundMessage>;
        statuses?: Array<{ id?: string; status?: string }>;
        metadata?: { phone_number_id?: string; display_phone_number?: string };
      };
    }>;
    messaging?: Array<{ message?: { mid?: string } }>; // Instagram
    time?: number;
  }>;
};

/**
 * Tipos de mensagem WhatsApp que carregam mídia baixável da CDN temporária da
 * Meta. V1 cobre apenas WhatsApp (IG inbound media é deferido).
 */
const WA_MEDIA_TYPES = ["image", "audio", "document", "video", "sticker"] as const;

/** Ref de mídia anexada ao payload persistido + encaminhado (não-PII além do necessário). */
export interface InboundMediaRef {
  media_key: string;
  mime_type: string | null;
  filename: string | null;
  caption: string | null;
}

/**
 * Extrai refs de mídia da PRIMEIRA mensagem WhatsApp inbound (V1 = WA-first).
 * Lê do `value` cru (antes do redact) porque redact não remove id/mime_type/
 * filename, mas construir a ref daqui é defesa em profundidade.
 */
function extractWaMediaRefs(value: Record<string, unknown> | undefined): {
  refs: InboundMediaRef[];
  mediaId: string | null;
} {
  if (!value) return { refs: [], mediaId: null };
  const messages = value.messages as Array<MetaInboundMessage> | undefined;
  const msg = messages?.[0];
  if (!msg || typeof msg.type !== "string") return { refs: [], mediaId: null };
  if (!(WA_MEDIA_TYPES as readonly string[]).includes(msg.type)) {
    return { refs: [], mediaId: null };
  }
  const mediaObj = msg[msg.type as (typeof WA_MEDIA_TYPES)[number]];
  const id = mediaObj?.id;
  if (typeof id !== "string" || id.length === 0) return { refs: [], mediaId: null };
  return {
    refs: [
      {
        media_key: id,
        mime_type: mediaObj?.mime_type ?? null,
        filename: mediaObj?.filename ?? null,
        caption: mediaObj?.caption ?? null,
      },
    ],
    mediaId: id,
  };
}

const DEDUPE_PREFIX = "inbound:event:";
const DEDUPE_TTL_SECONDS = 24 * 3600;

/**
 * Decide o `event_type` canônico a partir do object/field/payload.
 * V1 cobre os principais; novos tipos caem em "raw".
 */
function classifyEvent(
  object: string,
  field: string | undefined,
  value: Record<string, unknown> | undefined,
): string {
  if (object === "whatsapp_business_account") {
    if (field === "messages") {
      if (value && Array.isArray(value.statuses) && value.statuses.length > 0) {
        return "message.status_updated";
      }
      return "message.received";
    }
    if (field === "message_template_status_update") return "template.status_updated";
    if (field === "phone_number_quality_update") return "phone_number.quality_changed";
    if (field === "account_update") return "waba.connection_changed";
    // COEX (coexistence): 3 campos app-level adicionais (verbatim D).
    if (field === "smb_message_echoes") return "whatsapp.message_echo";
    if (field === "smb_app_state_sync") return "whatsapp.contact_synced";
    if (field === "history") return "whatsapp.history_synced";
  }
  if (object === "instagram") {
    return "message.received";
  }
  return `raw.${object}.${field ?? "unknown"}`;
}

/**
 * Exportado para testabilidade (A8 fix). Função pura — não toca em Redis
 * nem DB. Consumers em produção continuam chamando via `processSingle`.
 */
export function extractMetaEventId(
  field: string | undefined,
  value: Record<string, unknown> | undefined,
): string | null {
  if (!value) return null;
  // WhatsApp Cloud API shape — `messages[]` / `statuses[]`.
  const messages = value.messages as Array<{ id?: string }> | undefined;
  if (messages && messages[0]?.id) return messages[0].id;
  const statuses = value.statuses as Array<{ id?: string }> | undefined;
  if (statuses && statuses[0]?.id) return statuses[0].id;
  // COEX smb_message_echoes — cada echo carrega um wamid em `id`.
  const echoes = value.message_echoes as Array<{ id?: string }> | undefined;
  if (echoes && echoes[0]?.id) return echoes[0].id;
  // smb_app_state_sync/history não têm id top-level estável → dedup desligado
  // para eles (retorna null abaixo); risco de replay é baixo nesses syncs.
  // A8 fix (audit 2026-06-02) — Instagram Messaging API shape:
  // `messaging[].message.mid` (inbound text/media), `read.mid` (delivery
  // read receipt), `reaction.mid` (reaction). Antes, `null` era retornado
  // para todo webhook IG → dedup desligado → re-deliveries da Meta
  // entravam duplicadas no banco.
  const messaging = value.messaging as
    | Array<{
        message?: { mid?: string };
        read?: { mid?: string };
        reaction?: { mid?: string };
        timestamp?: number;
        sender?: { id?: string };
      }>
    | undefined;
  if (messaging && messaging[0]) {
    const entry = messaging[0];
    const mid = entry.message?.mid ?? entry.read?.mid ?? entry.reaction?.mid;
    if (mid) return mid;
    // Fallback: alguns IG events (postback, optin) não têm `mid` mas têm
    // `sender.id + timestamp` que juntos formam uma chave estável o
    // suficiente para dedup dentro da janela TTL.
    if (entry.sender?.id && typeof entry.timestamp === "number") {
      return `ig:${entry.sender.id}:${entry.timestamp}`;
    }
  }
  return null;
}

async function isDuplicate(metaEventId: string): Promise<boolean> {
  // SET NX EX — retorna "OK" na 1ª vez, null se já existia.
  const result = await getRedis().set(
    `${DEDUPE_PREFIX}${metaEventId}`,
    "1",
    "EX",
    DEDUPE_TTL_SECONDS,
    "NX",
  );
  return result === null;
}

async function resolveTenant(
  object: string,
  entryId: string | undefined,
  value: Record<string, unknown> | undefined,
): Promise<{ appId: string; tenantId: string } | null> {
  if (object === "whatsapp_business_account") {
    const wabaId = entryId;
    if (!wabaId) return null;
    const waba = await findWabaByMetaWabaId(wabaId);
    if (!waba) return null;
    return { appId: waba.appId, tenantId: waba.tenantId };
  }
  if (object === "instagram") {
    // entry.id em IG webhooks é o page id ou ig id dependendo da config.
    // Para V1, tenta como meta_ig_id direto; se não casar, registra órfão.
    if (!entryId) return null;
    const ig = await findIgByMetaIgId(entryId);
    if (!ig) return null;
    return { appId: ig.appId, tenantId: ig.tenantId };
  }
  // value pode conter metadata.phone_number_id em alguns tipos — não tentamos
  // por phone aqui em V1.
  void value;
  return null;
}

export interface ProcessWebhookResult {
  /** Quantos eventos foram persistidos nesta requisição. */
  events_persisted: number;
  /** Quantos foram ignorados como duplicata. */
  events_deduplicated: number;
  /** Quantos webhook deliveries foram enfileirados. */
  deliveries_enqueued: number;
}

export async function processMetaWebhook(
  payload: MetaWebhookPayload,
): Promise<ProcessWebhookResult> {
  const result: ProcessWebhookResult = {
    events_persisted: 0,
    events_deduplicated: 0,
    deliveries_enqueued: 0,
  };

  const entries = payload.entry ?? [];
  for (const entry of entries) {
    // WhatsApp/IG diferem: WhatsApp usa entry.changes; IG usa entry.messaging.
    const changes = entry.changes ?? [];

    if (changes.length === 0 && entry.messaging) {
      // IG payload simplificado — V1: classifica como message.received.
      const event = await processSingle(payload.object, entry.id, undefined, undefined, {
        messaging: entry.messaging,
      });
      if (event === "duplicate") result.events_deduplicated++;
      else {
        result.events_persisted++;
        result.deliveries_enqueued += event;
      }
      continue;
    }

    for (const change of changes) {
      const event = await processSingle(
        payload.object,
        entry.id,
        change.field,
        change.value,
        change.value,
      );
      if (event === "duplicate") result.events_deduplicated++;
      else {
        result.events_persisted++;
        result.deliveries_enqueued += event;
      }
    }
  }

  return result;
}

/** account_update com PARTNER_REMOVED → a WABA foi removida no lado Meta. */
function isPartnerRemoved(
  object: string,
  field: string | undefined,
  value: Record<string, unknown> | undefined,
): boolean {
  return (
    object === "whatsapp_business_account" &&
    field === "account_update" &&
    (value?.event as string | undefined) === "PARTNER_REMOVED"
  );
}

async function processSingle(
  object: string,
  entryId: string,
  field: string | undefined,
  value: Record<string, unknown> | undefined,
  rawForPersist: Record<string, unknown> | undefined,
): Promise<"duplicate" | number> {
  const metaEventId = extractMetaEventId(field, value);
  if (metaEventId && (await isDuplicate(metaEventId))) {
    // A6: contador de processados pós-HMAC. `deduplicated` indica Meta
    // replayed (esperado em retries) ou config drift que causa loops.
    metaWebhookProcessedTotal.inc({ outcome: "deduplicated" });
    return "duplicate";
  }

  const eventType = classifyEvent(object, field, value);
  const tenantInfo = await resolveTenant(object, entryId, value);

  // Mídia inbound (V1 = WhatsApp only). Extraída do `value` cru: redact não
  // remove media_key/mime_type/filename/caption, mas construímos a ref aqui.
  const { refs: mediaRefs, mediaId } =
    object === "whatsapp_business_account"
      ? extractWaMediaRefs(value)
      : { refs: [] as InboundMediaRef[], mediaId: null };

  // O payload persistido é re-lido do DB pelo webhook-delivery worker; por isso
  // as refs de mídia DEVEM ir no payloadJson persistido (não só no publishEvent).
  // Aqui usa-se `redactSecrets()` (NÃO `redact()`): o payload é encaminhado a
  // consumidores que precisam do conteúdo da mensagem (text/body); só secrets
  // são scrubbed at rest. `redact()` (set completo) continua para logs/audit.
  const persistedPayload = redactSecrets(rawForPersist ?? {}) as Record<string, unknown>;
  const payloadJson: Record<string, unknown> =
    mediaRefs.length > 0 ? { ...persistedPayload, media: mediaRefs } : persistedPayload;

  const event = await insertInboundEvent({
    appId: tenantInfo?.appId ?? null,
    tenantId: tenantInfo?.tenantId ?? null,
    eventType,
    metaEventId,
    payloadJson,
  });

  if (!tenantInfo) {
    // Evento órfão: nada a entregar. Já persistido para investigação.
    // A6: contador separado de `persisted` — surge em `orphan` indica
    // WABA/IG desconectado ou configuração desalinhada com o consumer.
    metaWebhookProcessedTotal.inc({ outcome: "orphan" });
    return 0;
  }

  // A6: evento persistido COM tenant resolvido (caminho-feliz).
  metaWebhookProcessedTotal.inc({ outcome: "persisted" });

  // COEX/ES: PARTNER_REMOVED → a WABA saiu no lado Meta. Soft-disconnect local
  // (disconnected_at + supersede tokens) para parar refresh/uso do token. O
  // evento waba.connection_changed segue para o consumer no fluxo abaixo.
  if (isPartnerRemoved(object, field, value)) {
    try {
      const disconnected = await disconnectWabaByMetaWabaId(entryId);
      if (disconnected) {
        logger().info(
          { meta_waba_id: entryId, waba_connection_id: disconnected.id },
          "waba disconnected via PARTNER_REMOVED webhook",
        );
      }
    } catch (err) {
      logger().warn(
        { err, meta_waba_id: entryId },
        "PARTNER_REMOVED disconnect failed (non-blocking)",
      );
    }
  }

  // Download da mídia em background (janela ~5 min da CDN temporária da Meta).
  // Não bloqueia o 200; falha de enfileiramento não derruba o pipeline.
  if (mediaId && mediaRefs.length > 0) {
    try {
      await getMediaDownloadQueue().add(
        "download",
        { app_id: tenantInfo.appId, tenant_id: tenantInfo.tenantId, media_id: mediaId },
        { attempts: 4, backoff: { type: "exponential", delay: 5000 } },
      );
    } catch (err) {
      logger().warn({ err, event_id: event.id }, "media download enqueue failed (non-blocking)");
    }
  }

  // Publica em pub/sub para SSE subscribers (best-effort).
  try {
    await publishEvent({
      event_id: event.id,
      event_type: eventType,
      app_id: tenantInfo.appId,
      tenant_id: tenantInfo.tenantId,
      occurred_at: event.receivedAt.toISOString(),
      data: event.payloadJson,
    });
  } catch (err) {
    logger().warn({ err, event_id: event.id }, "publishEvent failed (non-blocking)");
  }

  const subs = await listActiveSubscriptions(tenantInfo.appId, tenantInfo.tenantId);
  if (subs.length === 0) return 0;

  const queue = getWebhookDeliveryQueue();
  for (const sub of subs) {
    // Filtro de event_types_filter (vazio = aceita todos).
    if (sub.eventTypesFilter.length > 0 && !sub.eventTypesFilter.includes(eventType)) {
      continue;
    }
    // C3: explicita `attempts` (env-driven, default 8) + backoff PRD §10.2
    // a nível-job para que o produtor não fique refém do defaultJobOptions
    // da queue (que pode estar diferente em rotas de replay/admin). O
    // worker é a SoT do schedule via `WEBHOOK_BACKOFF_STRATEGY` (registrada
    // no `settings.backoffStrategy` em `startWebhookDeliveryWorker()`).
    await queue.add(
      "deliver",
      {
        subscription_id: sub.id,
        inbound_event_id: event.id,
        event_type: eventType,
      },
      { jobId: `${sub.id}:${event.id}`, ...webhookDeliveryJobOptions() },
    );
  }
  return subs.length;
}
