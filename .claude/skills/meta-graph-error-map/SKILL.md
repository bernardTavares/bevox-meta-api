---
name: meta-graph-error-map
description: |
  Mapear erros do Meta Graph API (WhatsApp Business Cloud + Instagram Graph)
  para o `AppError` canônico da bevox-meta-api, conforme o PRD §7.3 e a função
  `mapMetaError()` em `src/integration/meta-client.ts`. Garante que toda nova
  chamada Meta classifique corretamente erros como `META_REJECTED` (4xx de
  negócio, sem retry), `META_UNAVAILABLE` (5xx/transient, com retry),
  `RATE_LIMITED` (429-equivalentes) ou `UNAUTHENTICATED` (token inválido).
when_to_invoke: |
  - Ao **implementar nova chamada Meta** em `src/integration/meta-client.ts`
    (ou qualquer client que fale com `graph.facebook.com`).
  - Ao **revisar handler de erro** de chamada Meta existente.
  - Ao **adicionar caso novo a `mapMetaError()`** (e.g., novo subcódigo
    descoberto em produção via fbtrace_id).
  - Ao **escrever teste** de cenário de erro Meta (mock retornando status+code).
  - Usuário pede "como mapear erro Meta X" ou "qual AppError usar para
    código Meta Y".
inputs:
  - HTTP status retornado pela Meta (ou 0 para erros de rede).
  - Body Meta `{ error: { code, error_subcode, message, fbtrace_id, type } }`.
  - Endpoint chamado (path Graph, ex.: `/<phoneId>/messages`).
outputs:
  - `AppError` canônico (`errors.metaRejected | metaUnavailable | rateLimited | unauthenticated | internal`).
  - HTTP status que a meta-api devolverá ao consumidor (422 | 502 | 429 | 401 | 500).
  - Estratégia de retry recomendada (none | exponential-backoff | respect Retry-After).
  - Campos a incluir em `details` (sempre: `meta_endpoint`, `meta_status`, `meta_code`, `meta_subcode`, `fbtrace_id`).
references:
  - references/meta-error-codes.md
  - ../../../src/integration/meta-client.ts
  - ../../../skills/bevox-meta-api-consumer/references/07-error-codes.md
---

# Skill: meta-graph-error-map

## Princípio

A função `mapMetaError(status, body, endpoint)` em
`src/integration/meta-client.ts` é o **único ponto** de tradução
Meta → AppError. Hoje ela tem a regra geral:

- `status >= 500 || status === 0` → `META_UNAVAILABLE` (502, retry OK).
- `status >= 400` → `META_REJECTED` (422, sem retry).

Isso é **correto como default**, mas insuficiente para casos como:

- Rate limit (Meta usa 4xx com code 4/17/32/80007) → deveria virar `RATE_LIMITED` (429), não `META_REJECTED`.
- Token expirado (code 190) → deveria virar `UNAUTHENTICATED` (401) ou ser sinalizado para refresh, não `META_REJECTED`.
- Transient temporário (codes 1, 2) → deveria virar `META_UNAVAILABLE` (502, retry) apesar de ser 4xx.

Este skill ajuda a refinar `mapMetaError()` caso a caso, sem regredir o
default seguro.

## Procedimento ao implementar nova chamada Meta

1. **Consultar `references/meta-error-codes.md`** para os códigos esperados
   no endpoint que você está integrando.
2. **Identificar buckets**:
   - Auth/token (190, 102, 463, 467) → `UNAUTHENTICATED`.
   - Rate/limit (4, 17, 32, 80007, 80008, 130429) → `RATE_LIMITED`.
   - Permission/scope (10, 200, 210, 299) → `FORBIDDEN`.
   - Transient (1, 2, 368 temp, 613) → `META_UNAVAILABLE` (retry).
   - Business reject (100 + subcódigos, 131xxx, 132xxx) → `META_REJECTED`.
3. **Verificar se `mapMetaError()` já cobre** — se não, adicionar ramo
   específico ANTES do default. Manter o default como fail-safe.
4. **Adicionar teste** em `tests/integration/meta-client.*.test.ts`
   mockando o status+code esperado.
5. **Atualizar `references/meta-error-codes.md`** se descobrir
   código/subcódigo novo em produção (via `fbtrace_id` rastreado).

## Tabela de mapeamento (resumo)

Tabela completa em `references/meta-error-codes.md`. Resumo dos mais comuns:

| Meta code | Subcode | AppError              | httpStatus | Retry                    |
|-----------|---------|-----------------------|------------|--------------------------|
| 1         | —       | `META_UNAVAILABLE`    | 502        | exponential-backoff      |
| 2         | —       | `META_UNAVAILABLE`    | 502        | exponential-backoff      |
| 4         | —       | `RATE_LIMITED`        | 429        | respect Retry-After      |
| 10        | —       | `FORBIDDEN`           | 403        | none                     |
| 17        | —       | `RATE_LIMITED`        | 429        | respect Retry-After      |
| 32        | —       | `RATE_LIMITED`        | 429        | respect Retry-After      |
| 100       | —       | `META_REJECTED`       | 422        | none                     |
| 100       | 33      | `NOT_FOUND`           | 404        | none                     |
| 190       | —       | `UNAUTHENTICATED`     | 401        | refresh token, then retry|
| 190       | 460     | `UNAUTHENTICATED`     | 401        | password changed; no retry|
| 200       | —       | `FORBIDDEN`           | 403        | none                     |
| 210       | —       | `FORBIDDEN`           | 403        | none                     |
| 368       | —       | `META_UNAVAILABLE`*   | 502        | wait + exponential       |
| 613       | —       | `RATE_LIMITED`        | 429        | respect Retry-After      |
| 80007     | —       | `RATE_LIMITED`        | 429        | respect Retry-After      |
| 80008     | —       | `RATE_LIMITED`        | 429        | respect Retry-After      |
| 131005    | —       | `META_REJECTED`       | 422        | none (recipient invalid) |
| 131008    | —       | `INVALID_INPUT`       | 400        | none (payload malformed) |
| 131009    | —       | `META_REJECTED`       | 422        | none (template params)   |
| 131021    | —       | `META_REJECTED`       | 422        | none (cannot send to self)|
| 131026    | —       | `META_REJECTED`       | 422        | none (24h window closed) |
| 131031    | —       | `META_REJECTED`       | 422        | none (account locked)    |
| 131047    | —       | `META_REJECTED`       | 422        | none (re-engagement)     |
| 131051    | —       | `META_REJECTED`       | 422        | none (unsupported msg)   |
| 131056    | —       | `RATE_LIMITED`        | 429        | per-pair rate; backoff   |
| 132000    | —       | `META_REJECTED`       | 422        | none (template variable) |
| 132001    | —       | `META_REJECTED`       | 422        | none (template not exist)|
| 132005    | —       | `META_REJECTED`       | 422        | none (translation issue) |
| 132007    | —       | `META_REJECTED`       | 422        | none (template policy)   |
| 132012    | —       | `META_REJECTED`       | 422        | none (param format)      |
| 132015    | —       | `META_REJECTED`       | 422        | none (template paused)   |
| 132016    | —       | `META_REJECTED`       | 422        | none (template disabled) |
| 133000    | —       | `META_REJECTED`       | 422        | none (decryption fail)   |
| 133004    | —       | `META_UNAVAILABLE`    | 502        | retry                    |
| 133005    | —       | `META_REJECTED`       | 422        | none (PIN mismatch)      |

*368 é categorizado como `META_UNAVAILABLE` quando temporário; se persistente após backoff longo (>1h), reescalar como `META_REJECTED` e abrir ticket.

## Anti-patterns

- **Não** mapear todo 4xx como `META_REJECTED` sem inspecionar `code`.
- **Não** logar `body.error.message` cru no canal do usuário (pode vazar
  detalhe interno Meta).
- **Não** retry em `META_REJECTED` — é decisão de negócio da Meta.
- **Sempre** preservar `fbtrace_id` em `details` para suporte com a Meta.
- **Sempre** anexar `meta_code`/`meta_subcode` numéricos, não strings.

## Quando o caso é desconhecido

Mantém o default da `mapMetaError()` atual:
`status >= 500 → META_UNAVAILABLE`, senão `META_REJECTED`.
Loga warn `"meta_error_unmapped"` com `meta_code` e `fbtrace_id` para
backfill posterior em `references/meta-error-codes.md`.
