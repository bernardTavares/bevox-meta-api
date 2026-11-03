# 05 — Webhooks push + validação HMAC

Fonte canônica: ADR MA-005 + PRD §10.

Modo recomendado quando seu projeto tem URL HTTPS interna alcançável pela meta-api. Para alternativas (sem URL): ver `references/06-events-sse-polling.md`.

## Registrar subscription (uma vez por ambiente)

```http
POST /v1/webhooks/subscriptions
Authorization: Bearer <jwt scope=webhooks:write>
Idempotency-Key: sub-{ambiente}-bootstrap
Content-Type: application/json

{
  "delivery_mode": "push",
  "url": "https://seu-backend.internal/webhooks/meta-api",
  "tenant_id": null,
  "event_types_filter": [
    "waba.connection_changed",
    "message.received",
    "message.status_updated",
    "template.status_updated"
  ]
}
```

Resposta:
```json
{
  "id": "01HX...",
  "delivery_mode": "push",
  "url": "https://seu-backend.internal/webhooks/meta-api",
  "event_types_filter": [...],
  "status": "active",
  "signing_secret": "<32 bytes base64 — só aparece AQUI, guarde no secret manager>"
}
```

Observações:
- `tenant_id: null` = recebe eventos de todos os tenants do app.
- `signing_secret` aparece **uma única vez**. Se perder, precisa deletar e recriar a subscription.
- Pode ter mais de uma subscription por app (ex.: uma por ambiente, uma por tipo de evento).

## Eventos V1 disponíveis

| Event type | Quando dispara |
|---|---|
| `waba.connection_changed` | Status da WABA muda (active, pending, disconnected, error). |
| `ig.connection_changed` | Idem para Instagram. |
| `message.received` | Mensagem inbound chegou da Meta. |
| `message.status_updated` | Sent/delivered/read/failed de mensagem outbound. |
| `template.status_updated` | Aprovação/rejeição de template pela Meta. |
| `phone_number.quality_changed` | Qualidade do número degradou ou voltou. |

## Mídia em `message.received` (WhatsApp)

Quando a mensagem inbound carrega mídia (`image`, `audio`, `document`, `video`, `sticker`), o `data` do evento `message.received` inclui um array `media`:

```json
{
  "event_id": "01HX...",
  "event_type": "message.received",
  "tenant_id": "01HY...",
  "occurred_at": "2026-04-27T12:00:00.123Z",
  "data": {
    "messages": [{ "id": "wamid...", "type": "image", "image": { "id": "MEDIA-ID" } }],
    "media": [
      { "media_key": "MEDIA-ID", "mime_type": "image/jpeg", "filename": null, "caption": "..." }
    ]
  }
}
```

- `media_key` é o handle estável para buscar o binário via `GET /v1/media/{media_key}` (scope `media:read`, header `X-Tenant-Id`). Veja `references/03-endpoints.md`.
- O download da CDN temporária da Meta acontece em background; o `GET /v1/media` retorna `202 processing` até concluir. Faça retry com backoff.
- V1 cobre mídia **WhatsApp**. Mídia inbound do Instagram é deferida (não popula `media[]` ainda).

## Recebendo um evento

```http
POST /webhooks/meta-api HTTP/1.1
Host: seu-backend.internal
Content-Type: application/json
X-Bevox-Signature: t=1714003200,v1=a3c...hex
X-Bevox-Event-Id: 01HX...
X-Bevox-Event-Type: message.received
X-Bevox-Delivery-Attempt: 1

{
  "event_id": "01HX...",
  "event_type": "message.received",
  "tenant_id": "01HY...",
  "occurred_at": "2026-04-27T12:00:00.123Z",
  "data": { ... payload normalizado ... }
}
```

## Validação HMAC (Stripe-style)

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

function validateBevoxSignature(
  signingSecret: string,
  signatureHeader: string, // valor de X-Bevox-Signature
  rawBody: string,         // body cru, antes de JSON.parse
  toleranceSeconds = 300   // 5 min
): boolean {
  const parts = signatureHeader.split(",").reduce<Record<string, string>>(
    (acc, part) => {
      const [k, v] = part.split("=");
      acc[k] = v;
      return acc;
    },
    {},
  );

  const ts = parseInt(parts.t, 10);
  const v1 = parts.v1;
  if (!ts || !v1) return false;

  // Anti-replay: rejeita timestamps com skew > tolerance
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > toleranceSeconds) return false;

  const signedPayload = `${ts}.${rawBody}`;
  const expected = createHmac("sha256", signingSecret)
    .update(signedPayload)
    .digest("hex");

  if (expected.length !== v1.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(v1));
}
```

**Pegadas críticas:**
- Use `rawBody` (string original), não `JSON.stringify(parsedBody)`. Whitespace conta.
- Use `timingSafeEqual` para evitar timing attack.
- Rejeite se `t` está muito no passado/futuro (anti-replay).
- Rejeite se signature falha — **não logue o secret no warning**.

## Idempotência no seu lado

Eventos podem chegar duplicados (retry após timeout do seu handler). Cada evento tem `event_id` UUIDv7 estável.

```ts
// Pseudo:
const exists = await db.processedEvents.findById(event_id);
if (exists) return res.status(200).end(); // ack silencioso
await processEvent(event);
await db.processedEvents.insert({ id: event_id });
```

## Retry policy da meta-api

- **6 tentativas** com backoff exponencial: 0s, 30s, 2m, 10m, 30m, 2h.
- Considera "delivery OK" qualquer 2xx no seu retorno.
- 4xx (exceto 408, 429) = stop imediato (não retry; vai para `dead_letter`).
- 5xx, timeout, conexão recusada = retry.
- Após 6 tentativas falhas, evento entra em `dead_letter` e admin pode replay via CLI:
  ```bash
  pnpm cli dead-letter list --subscription-id <id>
  pnpm cli dead-letter replay --subscription-id <id> --since=24h
  ```

## Latência aceitável do seu handler

- Meta-api timeout: 10s por tentativa.
- Recomendado: handler responder 2xx em ≤ 1s.
- Padrão: enfileirar processamento real em fila interna do seu projeto (BullMQ, SQS, etc.) e retornar 200 rápido. **Não** processe síncrono se há DB lento, chamadas externas, etc.

## Filtros e múltiplas subscriptions

- Pode ter N subscriptions por app, cada uma com filtro próprio.
- Útil para separar concerns: uma subscription para `waba.connection_changed` (lógica de onboarding) e outra para `message.*` (lógica de chat).

## Implementação prontas

- Fastify: `snippets/webhook-handler-fastify.ts` (com raw body parsing).
- Next.js Route Handler: `snippets/webhook-handler-nextjs.ts`.

## Erros comuns

| Sintoma | Causa |
|---|---|
| Tudo cai em dead-letter | URL inacessível pela meta-api (firewall, DNS, TLS errado). |
| HMAC sempre inválido | Você está validando contra `JSON.stringify(parsed)` em vez do raw body. |
| HMAC inválido só em alguns eventos | Body com caracteres unicode reformatados pelo seu framework antes do raw body chegar ao validator. |
| Eventos chegam duplicados | Seu handler está demorando > 10s e meta-api retry. Faça processamento async + idempotência por `event_id`. |
| Nenhum evento chega | Subscription `status: paused` (após N falhas seguidas). Conferir com `GET /v1/webhooks/subscriptions/{id}`. |
