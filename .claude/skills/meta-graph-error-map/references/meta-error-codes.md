# Meta Graph API — Tabela completa de erros e mapeamento canônico

Esta é a tabela de referência usada pelo skill `meta-graph-error-map` e pela
função `mapMetaError()` em `src/integration/meta-client.ts`. Cobre os
endpoints Graph genéricos + WhatsApp Cloud API + Instagram Graph.

**Fontes oficiais Meta (consultar para mudanças):**

- Graph API error handling: <https://developers.facebook.com/docs/graph-api/guides/error-handling>
- WhatsApp Cloud API error codes: <https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes>
- Instagram Graph errors: <https://developers.facebook.com/docs/instagram-platform/reference/error-codes>
- Marketing API rate limiting: <https://developers.facebook.com/docs/graph-api/overview/rate-limiting>

## Convenções

- `httpStatus` = status que a **meta-api devolve ao consumidor**, não o status que a Meta nos deu.
- `retry` é instrução para o **cliente da meta-api** (consumidor).
- Coluna `AppError code` = um dos 10 códigos canônicos do PRD §7.3.
- Quando `subcode` é `—`, a regra vale para qualquer subcode (ou ausência).
- Linhas mais específicas (com subcode) sobrescrevem linhas genéricas do mesmo code.

## Erros gerais Graph API (Authentication / Authorization / Rate)

| Meta code | Subcode | Descrição Meta                                       | AppError code         | httpStatus | Retry                              |
|-----------|---------|------------------------------------------------------|-----------------------|------------|------------------------------------|
| 1         | —       | API Unknown — transient/unknown                      | `META_UNAVAILABLE`    | 502        | exponential-backoff                |
| 2         | —       | API Service — temporary failure                      | `META_UNAVAILABLE`    | 502        | exponential-backoff                |
| 4         | —       | App-level throttling                                 | `RATE_LIMITED`        | 429        | respect Retry-After + backoff      |
| 10        | —       | Permission denied (no perms granted)                 | `FORBIDDEN`           | 403        | none                               |
| 17        | —       | User request limit reached                           | `RATE_LIMITED`        | 429        | respect Retry-After + backoff      |
| 32        | —       | Page-level throttling                                | `RATE_LIMITED`        | 429        | respect Retry-After                |
| 100       | —       | Invalid parameter                                    | `META_REJECTED`       | 422        | none (fix input)                   |
| 100       | 33      | Object does not exist (or no access)                 | `NOT_FOUND`           | 404        | none                               |
| 102       | —       | Session key invalid / user logged out                | `UNAUTHENTICATED`     | 401        | re-auth user                       |
| 190       | —       | Invalid OAuth 2.0 access token                       | `UNAUTHENTICATED`     | 401        | refresh long-lived; if fail re-auth|
| 190       | 458     | App not installed                                    | `UNAUTHENTICATED`     | 401        | re-auth (re-grant app)             |
| 190       | 459     | User checkpointed                                    | `UNAUTHENTICATED`     | 401        | user must complete checkpoint      |
| 190       | 460     | Password changed                                     | `UNAUTHENTICATED`     | 401        | re-auth                            |
| 190       | 463     | Token expired                                        | `UNAUTHENTICATED`     | 401        | refresh long-lived token           |
| 190       | 464     | User not confirmed                                   | `UNAUTHENTICATED`     | 401        | none (user side)                   |
| 190       | 467     | Invalid access token (revoked)                       | `UNAUTHENTICATED`     | 401        | re-auth                            |
| 200       | —       | Permissions error (specific perm missing)            | `FORBIDDEN`           | 403        | none (re-grant scope)              |
| 210       | —       | User not visible (cannot access user object)         | `FORBIDDEN`           | 403        | none                               |
| 230       | —       | Permission disabled                                  | `FORBIDDEN`           | 403        | none                               |
| 240       | —       | Cannot impersonate user                              | `FORBIDDEN`           | 403        | none                               |
| 294       | —       | Manage Pages permission required                     | `FORBIDDEN`           | 403        | none                               |
| 298       | —       | Manage Permissions error                             | `FORBIDDEN`           | 403        | none                               |
| 299       | —       | Publish Actions permission missing                   | `FORBIDDEN`           | 403        | none                               |
| 341       | —       | Application limit reached                            | `RATE_LIMITED`        | 429        | wait + backoff                     |
| 368       | —       | Temporarily blocked for policies violations          | `META_UNAVAILABLE`    | 502        | wait (hours/days); escalate if >1h |
| 506       | —       | Duplicate post                                       | `CONFLICT`            | 409        | none                               |
| 613       | —       | Calls to this api have exceeded rate limit           | `RATE_LIMITED`        | 429        | respect Retry-After                |
| 803       | —       | Some aliases in this request do not exist            | `NOT_FOUND`           | 404        | none                               |
| —         | —       | Network error / status 0 / DNS / TLS                 | `META_UNAVAILABLE`    | 502        | exponential-backoff                |
| —         | —       | 5xx genérico Meta                                    | `META_UNAVAILABLE`    | 502        | exponential-backoff                |

## WhatsApp Business Cloud API — codes 130xxx (mensageria & throughput)

| Meta code | Descrição                                                  | AppError code      | httpStatus | Retry                       |
|-----------|------------------------------------------------------------|--------------------|------------|-----------------------------|
| 130429    | Rate limit hit (messages per second)                       | `RATE_LIMITED`     | 429        | respect Retry-After         |
| 130472    | User's number is part of an experiment                     | `META_REJECTED`    | 422        | none                        |
| 131000    | Generic error from WhatsApp service                        | `META_UNAVAILABLE` | 502        | retry                       |
| 131005    | Access denied (recipient not allowed)                      | `META_REJECTED`    | 422        | none                        |
| 131008    | Required parameter missing                                 | `INVALID_INPUT`    | 400        | none (fix payload)          |
| 131009    | Parameter value not valid                                  | `META_REJECTED`    | 422        | none                        |
| 131016    | Service unavailable                                        | `META_UNAVAILABLE` | 502        | retry                       |
| 131021    | Sender and recipient phone are the same                    | `META_REJECTED`    | 422        | none                        |
| 131026    | Message undeliverable (recipient cannot receive now)       | `META_REJECTED`    | 422        | none (24h window/template)  |
| 131031    | Account has been locked                                    | `META_REJECTED`    | 422        | none (operator escalation)  |
| 131042    | Business eligibility payment issue                         | `META_REJECTED`    | 422        | none (billing)              |
| 131045    | Sender registration / phone not registered                 | `META_REJECTED`    | 422        | none (register phone)       |
| 131047    | Re-engagement message (24h window expired)                 | `META_REJECTED`    | 422        | none (use template)         |
| 131048    | Spam rate limit hit                                        | `RATE_LIMITED`     | 429        | backoff (per quality)       |
| 131049    | Meta chose not to deliver (quality)                        | `META_REJECTED`    | 422        | none                        |
| 131051    | Unsupported message type                                   | `META_REJECTED`    | 422        | none                        |
| 131052    | Media download error                                       | `META_REJECTED`    | 422        | none (re-upload)            |
| 131053    | Media upload error                                         | `META_REJECTED`    | 422        | retry once then fail        |
| 131056    | Per-pair rate limit (sender↔recipient)                     | `RATE_LIMITED`     | 429        | backoff per pair            |
| 131057    | Account in maintenance mode                                | `META_UNAVAILABLE` | 502        | retry                       |
| 132000    | Number of parameters does not match template               | `META_REJECTED`    | 422        | none (fix components)       |
| 132001    | Template does not exist                                    | `META_REJECTED`    | 422        | none (check name+language)  |
| 132005    | Template hydrated text too long                            | `META_REJECTED`    | 422        | none                        |
| 132007    | Template format violates policy                            | `META_REJECTED`    | 422        | none (re-submit)            |
| 132012    | Parameter format mismatch                                  | `META_REJECTED`    | 422        | none                        |
| 132015    | Template is paused due to low quality                      | `META_REJECTED`    | 422        | none (wait/improve)         |
| 132016    | Template is disabled                                       | `META_REJECTED`    | 422        | none                        |
| 132068    | Flow is blocked                                            | `META_REJECTED`    | 422        | none                        |
| 132069    | Flow is throttled                                          | `RATE_LIMITED`     | 429        | backoff                     |
| 133000    | Incomplete deregistration                                  | `META_REJECTED`    | 422        | none                        |
| 133004    | Server temporarily unavailable                             | `META_UNAVAILABLE` | 502        | retry                       |
| 133005    | Two-step verification PIN mismatch                         | `META_REJECTED`    | 422        | none                        |
| 133006    | Phone number re-verification needed                        | `META_REJECTED`    | 422        | none (operator action)      |
| 133008    | Too many 2FA PIN guesses                                   | `RATE_LIMITED`     | 429        | wait then retry             |
| 133009    | PIN entered too quickly                                    | `RATE_LIMITED`     | 429        | wait                        |
| 133010    | Phone number not registered                                | `META_REJECTED`    | 422        | none                        |
| 133015    | Please wait a few minutes before attempting                | `RATE_LIMITED`     | 429        | wait                        |
| 135000    | Generic user error                                         | `META_REJECTED`    | 422        | none                        |

## WhatsApp Cloud — rate limits específicos (Business Management API)

| Meta code | Descrição                                                  | AppError code   | httpStatus | Retry                       |
|-----------|------------------------------------------------------------|-----------------|------------|-----------------------------|
| 80007     | Rate limit issues (business mgmt — read)                   | `RATE_LIMITED`  | 429        | respect Retry-After         |
| 80008     | Rate limit issues (business mgmt — write)                  | `RATE_LIMITED`  | 429        | respect Retry-After         |
| 80014     | Catalog batch limit reached                                | `RATE_LIMITED`  | 429        | backoff                     |

## Instagram Graph API — codes específicos

| Meta code | Descrição                                                       | AppError code      | httpStatus | Retry                |
|-----------|-----------------------------------------------------------------|--------------------|------------|----------------------|
| 9         | App has been disabled                                           | `FORBIDDEN`        | 403        | none                 |
| 24        | Posting to Instagram failed                                     | `META_REJECTED`    | 422        | none                 |
| 36        | Media not found                                                 | `NOT_FOUND`        | 404        | none                 |
| 9004      | Media ID not found                                              | `NOT_FOUND`        | 404        | none                 |
| 18001     | IG Business — recipient out of 24h window (DM)                  | `META_REJECTED`    | 422        | none (use template)  |
| 18008     | IG Business — too many sent to user                             | `RATE_LIMITED`     | 429        | wait                 |
| 18013     | IG Business — message blocked by user                           | `META_REJECTED`    | 422        | none                 |
| 36003     | Insights data not available yet                                 | `META_UNAVAILABLE` | 502        | retry later          |
| 100       | Invalid parameter (IG-specific contexts)                        | `META_REJECTED`    | 422        | none                 |

## Casos especiais — autenticação OAuth e debug_token

| Cenário                                                            | AppError code      | httpStatus | Notas                                   |
|--------------------------------------------------------------------|--------------------|------------|-----------------------------------------|
| `/oauth/access_token` retorna sem `access_token`                   | `META_REJECTED`    | 422        | já tratado em `meta-client.ts`          |
| `/debug_token` retorna `is_valid: false`                           | `UNAUTHENTICATED`  | 401        | forçar re-auth                          |
| `granular_scopes` sem `whatsapp_business_management`               | `META_REJECTED`    | 422        | usuário não concedeu escopo necessário  |
| `owned_whatsapp_business_accounts` retorna lista vazia             | `META_REJECTED`    | 422        | conta sem WABA — pedir Embedded Signup  |
| `me/accounts` sem `instagram_business_account` em nenhuma Page     | `META_REJECTED`    | 422        | nenhuma Page com IG vinculada           |

## Como o `mapMetaError()` consome esta tabela

Estado atual (default seguro):

```ts
if (status >= 500 || status === 0) throw errors.metaUnavailable(...);
else throw errors.metaRejected(reason, details);
```

Refinamento incremental sugerido (pseudocódigo):

```ts
const code = meta?.code;
const subcode = meta?.error_subcode;

// 1. transient / network
if (status === 0 || status >= 500) return metaUnavailable;
if (code === 1 || code === 2 || code === 133004 || code === 131057) return metaUnavailable;
if (code === 131000 || code === 131016) return metaUnavailable;
if (code === 368) return metaUnavailable; // escalate after long backoff

// 2. rate
if ([4, 17, 32, 341, 613, 130429, 131048, 131056, 132069, 80007, 80008, 80014, 133008, 133009, 133015, 18008].includes(code)) return rateLimited;

// 3. auth
if (code === 102 || code === 190) return unauthenticated;

// 4. permission
if ([10, 200, 210, 230, 240, 294, 298, 299, 9].includes(code)) return forbidden;

// 5. not found
if (code === 803 || (code === 100 && subcode === 33) || code === 36 || code === 9004) return notFound;

// 6. invalid input (Meta blames payload, not policy)
if (code === 131008) return invalidInput;

// 7. conflict
if (code === 506) return conflict;

// 8. default: business reject (most 4xx, 13xxxx, 18xxx)
return metaRejected;
```

**Importante:** ao adicionar ramos novos ao `mapMetaError()`, atualizar
esta tabela e adicionar teste em `tests/integration/meta-client.*.test.ts`.

## Manutenção

- Sempre que aparecer `meta_error_unmapped` em logs (ver SKILL.md),
  capturar `meta_code`, `meta_subcode`, `fbtrace_id`, e backfill aqui.
- Quando a Meta versionar Graph API (`META_GRAPH_API_VERSION` bump),
  rodar grep em changelog oficial e revisar esta tabela.
- Esta tabela **não deve** divergir do enum de erros em
  `skills/bevox-meta-api-consumer/references/07-error-codes.md` —
  consumidores externos contam com o mesmo mapeamento.
