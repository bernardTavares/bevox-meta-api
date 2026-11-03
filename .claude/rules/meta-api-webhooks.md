---
name: meta-api-webhooks
glob: "src/modules/inbound/**"
description: Regras estritas para webhook handlers (MA-005 + ADR-011 §3).
priority: 1
---

# Regra: src/modules/inbound/

## HMAC obrigatório (MA-005 / ADR-011 §3.3)

Todo POST de webhook Meta DEVE:

1. Ler `X-Hub-Signature-256: sha256=<hex>`. Ausente → 401.
2. Computar `HMAC_SHA256(app_secret, raw_body)` em **tempo constante**
   (`crypto.timingSafeEqual`).
3. Inválido → 401 + métrica `webhook_signature_invalid_total{provider}`
   (auditoria 2026-06-02 A6: métrica declarada mas não emitida hoje;
   bug pendente).

NUNCA aceitar webhook sem HMAC. Mesmo em dev — usar app_secret de dev.

## Path canônico

Path real implementado: `/webhooks/meta` (uma única rota, ambos
provedores roteados pelo discriminator `messaging_product` no payload):

- `GET /webhooks/meta` — verificação Meta (`hub.challenge`)
- `POST /webhooks/meta` — eventos

NÃO usar `{display_phone_number}` nem `{waba_id}` no path — vaza PII +
permite enumeração. A versão histórica desta rule sugeria
`/webhooks/whatsapp/{webhook_opaque_id}` — drift; código nunca
implementou esse path. (Auditoria 2026-06-02 A7: runbook e checklist
canônico ainda registram `/webhooks/meta/{whatsapp,instagram}` —
divergência separada, a corrigir no canon.)

## Idempotência 24h

Chave Redis: `inbound-event-dedup:{meta_event_id}` (SET NX, TTL 24h).
Semântica: se já existe, descartar silenciosamente (event_deduplicated++).

Cobre `messages`, `statuses`, `echoes` para WhatsApp; **NÃO cobre
eventos Instagram nem eventos não-message** (auditoria 2026-06-02 A8 —
dedup IG e eventos não-message é gap aberto).

## Resposta < 500ms

Handler responde em < 500ms (Meta retenta). Processamento real é
desacoplado via BullMQ:

- `outbound-meta` — fila de envio outbound (workers em
  `src/workers/outbound-dispatcher.ts`)
- `webhook-delivery` — fila de entrega aos consumidores (HMAC outbound,
  `src/workers/webhook-delivery.ts`)
- `media-download` — fila de download de mídia inbound
  (`src/workers/media-download.ts`)

(Versão histórica desta rule citava fila `bevox.whatsapp.events` — não
existe; nomes canônicos reais acima.)
