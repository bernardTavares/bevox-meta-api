# 07 — Códigos de erro canônicos

Fonte canônica: PRD §9.4.

## Formato de resposta de erro

Toda falha (4xx, 5xx) retorna JSON canônico:

```json
{
  "error": {
    "code": "META_REJECTED",
    "message": "Template was rejected by Meta",
    "details": {
      "meta_code": 131000,
      "meta_endpoint": "/messages"
    },
    "request_id": "01HX..."
  }
}
```

`request_id` é UUIDv7 e correlaciona logs/audit/traces. **Sempre** logue do seu lado, **sempre** retorne ao usuário em telas de erro inesperado.

## Tabela canônica

| Código | HTTP | Significado | O que fazer no consumidor |
|---|---|---|---|
| `UNAUTHENTICATED` | 401 | JWT inválido, expirado, kid desconhecido. | Regenerar JWT. Se persistir, conferir `kid` e env vars. |
| `FORBIDDEN` | 403 | Scope insuficiente, ou tenant não pertence ao app, ou X-Tenant-Id faltando. | Conferir scope no JWT e header X-Tenant-Id. |
| `INVALID_INPUT` | 400 | Body/query/header com schema inválido. | Bug do consumidor. `details` traz campo + razão. |
| `NOT_FOUND` | 404 | Recurso não existe (ou não pertence ao seu app — meta-api não diferencia para evitar enumeração). | Tratar como ausente; não retry. |
| `CONFLICT` | 409 | Estado em conflito (ex.: WABA já desconectada). | Re-buscar estado atual e reagir. |
| `IDEMPOTENCY_CONFLICT` | 409 | Mesma `Idempotency-Key` usada com **body diferente**. | Bug: você está reusando key para operações distintas. |
| `RATE_LIMITED` | 429 | Bucket do app/endpoint estourado. | Respeitar header `Retry-After`. Backoff exponencial após. |
| `META_UNAVAILABLE` | 502 | Graph API caída ou inalcançável. | Retry com backoff. Operação pode ter sido aceita pela Meta — verificar idempotência. |
| `META_REJECTED` | 422 | Meta retornou erro de negócio (template rejeitado, número inválido, etc.). | Não retry. `details.meta_code` traz código Meta original. |
| `INTERNAL` | 500 | Bug ou falha inesperada na meta-api. | Reportar com `request_id`. Retry com backoff. |

## Mapeando para o seu domínio

Recomendação: **não exponha** códigos canônicos da meta-api ao seu usuário-final. Mapeie:

```ts
function mapMetaApiError(error: MetaApiError): UserFacingError {
  switch (error.code) {
    case "META_REJECTED":
      // ex.: meta_code 131000 = template não existe na linguagem solicitada
      return { kind: "channel_error", retry: false, displayMessage: friendlyMessageForMeta(error.details.meta_code) };
    case "META_UNAVAILABLE":
    case "INTERNAL":
      return { kind: "transient", retry: true, displayMessage: "Tente novamente em instantes" };
    case "RATE_LIMITED":
      return { kind: "rate_limited", retry: true, retryAfter: error.retryAfter };
    case "FORBIDDEN":
    case "UNAUTHENTICATED":
      // bug seu — não exponha
      return { kind: "internal", retry: false, displayMessage: "Erro interno" };
    case "INVALID_INPUT":
      return { kind: "invalid_input", retry: false, displayMessage: "Dados inválidos" };
    default:
      return { kind: "unknown", retry: false, displayMessage: "Erro inesperado" };
  }
}
```

## Pegadas com idempotência + erros

- `META_UNAVAILABLE` em `POST /v1/messages` é ambíguo: a Meta pode ter recebido ou não. **Você deve retry com a mesma `Idempotency-Key`** — a meta-api detecta o caso e devolve o resultado da primeira tentativa quando completar.
- `IDEMPOTENCY_CONFLICT` significa que você reusou a mesma key com body diferente. Quase sempre bug. Veja `references/08-idempotency.md`.

## Códigos Meta importantes (`details.meta_code`)

Estão na resposta quando `code: META_REJECTED`. Alguns úteis:

| Meta code | Significado | Ação |
|---|---|---|
| 131000 | Template não existe | Conferir `name` + `language`. |
| 131009 | Template não aprovado | Aguardar aprovação ou usar outro. |
| 131026 | Número não autorizado a receber mensagem (rate / 24h window) | Esperar janela ou usar template aprovado. |
| 132000 | Template em variável errada | Conferir `components`. |
| 100 | Param inválido | Conferir formato (E.164 do número, etc.). |

Lista completa: docs da Meta. A meta-api **não traduz** códigos Meta — passa adiante em `details.meta_code`.

## Headers úteis em respostas

| Header | Quando | Significado |
|---|---|---|
| `Retry-After` | em 429 e 503 | Segundos antes de retry. |
| `X-Request-Id` | sempre | UUIDv7 da request (mesmo em sucesso). |
| `X-RateLimit-Remaining` | em endpoints rate-limited | Quantas requests restam na janela. |
| `X-RateLimit-Reset` | em endpoints rate-limited | Epoch quando bucket reseta. |

## Logging recomendado no consumidor

Para toda chamada à meta-api, logue:

- `request_id` (do response header, mesmo em sucesso).
- `endpoint` chamado.
- `tenant_id` (não loge `app_id` — vazaria credencial-equivalente).
- `latency_ms`.
- Em erro: `error.code` e `error.message`.

**Nunca logue:**
- O JWT inteiro (header e payload são fingerprintáveis).
- Body de mensagem (PII do usuário-final).
- `signing_secret`.
