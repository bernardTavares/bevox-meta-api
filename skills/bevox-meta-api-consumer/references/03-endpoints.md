# 03 — Endpoints V1

Fonte canônica: `docs/architecture/openapi.yaml`. Lista resumida abaixo.

## Tenants

| Método | Path | Scope | Idempotency? |
|---|---|---|---|
| `POST` | `/v1/tenants` | `tenants:write` | sim |
| `GET` | `/v1/tenants` | `tenants:read` | — |
| `GET` | `/v1/tenants/{tenant_id}` | `tenants:read` | — |
| `PATCH` | `/v1/tenants/{tenant_id}` | `tenants:write` | sim |
| `DELETE` | `/v1/tenants/{tenant_id}` | `tenants:write` | sim |

## WABA OAuth + gestão

| Método | Path | Scope | Idempotency? |
|---|---|---|---|
| `POST` | `/v1/tenants/{tenant_id}/wabas/connect/init` | `wabas:write` | sim |
| `GET` | `/v1/tenants/{tenant_id}/wabas/connect/callback` | público (state-validated) | — |
| `GET` | `/v1/tenants/{tenant_id}/wabas` | `wabas:read` | — |
| `GET` | `/v1/tenants/{tenant_id}/wabas/{waba_id}` | `wabas:read` | — |
| `DELETE` | `/v1/tenants/{tenant_id}/wabas/{waba_id}` | `wabas:write` | sim |

## Phone numbers

| Método | Path | Scope | Idempotency? |
|---|---|---|---|
| `GET` | `/v1/tenants/{tenant_id}/wabas/{waba_id}/phone-numbers` | `phone-numbers:read` | — |
| `POST` | `/v1/tenants/{tenant_id}/wabas/{waba_id}/phone-numbers/{phone_id}/profile` | `phone-numbers:write` | sim |

## Instagram OAuth + gestão

| Método | Path | Scope | Idempotency? |
|---|---|---|---|
| `POST` | `/v1/tenants/{tenant_id}/ig-accounts/connect/init` | `ig:write` | sim |
| `GET` | `/v1/tenants/{tenant_id}/ig-accounts` | `ig:read` | — |
| `GET` | `/v1/tenants/{tenant_id}/ig-accounts/{ig_id}` | `ig:read` | — |
| `DELETE` | `/v1/tenants/{tenant_id}/ig-accounts/{ig_id}` | `ig:write` | sim |

## Templates

| Método | Path | Scope | Idempotency? |
|---|---|---|---|
| `POST` | `/v1/tenants/{tenant_id}/wabas/{waba_id}/templates` | `templates:write` | sim |
| `GET` | `/v1/tenants/{tenant_id}/wabas/{waba_id}/templates` | `templates:read` | — |
| `GET` | `/v1/tenants/{tenant_id}/wabas/{waba_id}/templates/{name}/{language}` | `templates:read` | — |
| `POST` | `/v1/tenants/{tenant_id}/wabas/{waba_id}/templates/{name}/{language}/resync` | `templates:write` | sim |
| `DELETE` | `/v1/tenants/{tenant_id}/wabas/{waba_id}/templates/{name}/{language}` | `templates:write` | sim |

## Mensagens

| Método | Path | Scope | Idempotency? |
|---|---|---|---|
| `POST` | `/v1/messages` | `messages:write` | sim |
| `POST` | `/v1/messages/async` | `messages:write` | sim |
| `GET` | `/v1/messages/{message_id}` | `messages:write` | — |
| `GET` | `/v1/jobs/{job_id}` | `messages:write` | — |

## Webhooks (subscriptions)

| Método | Path | Scope | Idempotency? |
|---|---|---|---|
| `POST` | `/v1/webhooks/subscriptions` | `webhooks:write` | sim |
| `GET` | `/v1/webhooks/subscriptions` | `webhooks:read` | — |
| `GET` | `/v1/webhooks/subscriptions/{id}` | `webhooks:read` | — |
| `DELETE` | `/v1/webhooks/subscriptions/{id}` | `webhooks:write` | sim |

## Events (SSE / polling)

| Método | Path | Scope | Idempotency? |
|---|---|---|---|
| `GET` | `/v1/events/stream` | `events:read` | — |
| `GET` | `/v1/events` | `events:read` | — |
| `POST` | `/v1/events/ack` | `events:read` | sim |

## Media (inbound)

| Método | Path | Scope | Idempotency? |
|---|---|---|---|
| `GET` | `/v1/media/{media_key}` | `media:read` | — |

- `media_key` = o `media_key` recebido em `data.media[].media_key` no evento `message.received` (V1: WhatsApp). É o `media_id` da Meta.
- Tenant-scoped: exige header `X-Tenant-Id` e que o app possua uma WABA ativa para aquele tenant (senão `403 FORBIDDEN`).
- Respostas:
  - `302` redirect para uma URL pré-assinada de TTL curto (segue o `Location`). **Não cacheie a URL** — ela expira.
  - `202 { "status": "processing" }` se a mídia ainda está sendo baixada da CDN da Meta. Faça retry com backoff.
  - `400 INVALID_INPUT` se `media_key` for malformada.
  - `403 FORBIDDEN` se `X-Tenant-Id` não pertence ao app.
- A URL pré-assinada nunca aparece em logs do meta-api.

## Admin (não para apps consumidores)

| Método | Path | Auth |
|---|---|---|
| `POST` | `/admin/apps` | admin JWT (HS256) |
| `POST` | `/admin/apps/{app_id}/keys/rotate` | admin JWT |
| `POST` | `/admin/subscriptions/{id}/replay` | admin JWT |

> Apps consumidores **não** chamam `/admin/*`. Operação humana via CLI.

## Health (público, sem auth)

- `GET /healthz` — liveness.
- `GET /readyz` — readiness (DB + Redis).
- `GET /metrics` — Prometheus exposition.

## Headers obrigatórios em chamadas autenticadas

| Header | Quando |
|---|---|
| `Authorization: Bearer <jwt>` | Sempre. |
| `X-Tenant-Id: <tenant_id>` | Sempre que o endpoint for tenant-scoped (a maioria). |
| `Idempotency-Key: <chave>` | Toda mutação `POST/PUT/PATCH/DELETE` (exceto `/healthz`, `/readyz`, `/metrics`). |
| `X-Request-Id: <uuid>` | Opcional. Se ausente, meta-api gera. Útil para tracing cross-service. |
| `Content-Type: application/json` | Em requests com body. |

## Rate limiting

Buckets por `app_id` + por endpoint. Resposta `429 RATE_LIMITED` com header `Retry-After` em segundos. Veja PRD §13.

## Versionamento

- V1 vive em `/v1/*`. Mudanças breaking → V2 paralelo.
- Mudanças aditivas (campo opcional novo) acontecem em V1.
- Breaking change sem V2 = bug, abrir issue.
