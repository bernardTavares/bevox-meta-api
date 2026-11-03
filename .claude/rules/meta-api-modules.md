---
name: meta-api-modules
glob: "src/modules/**"
description: Padrões para módulos Fastify do bevox-meta-api.
priority: 2
---

# Regra: src/modules/

## Stack canônica

- **Fastify** com plugins fluentes; registrado em bootstrap.
- **Zod** para validação de input/output + tipos via `openapi-typescript`.
- **Drizzle ORM** para Postgres; nunca SQL string concatenada.
- **Pino** para logs; `redact` configurado para PII.
- **BullMQ** para jobs (workers em `src/workers/`).

## Idempotência (ADR-023)

Toda mutação (POST/PUT/PATCH/DELETE) DEVE:
- Aceitar header `Idempotency-Key` (obrigatório).
- Persistir resultado por 24h (Redis `SET NX`).
- Reentregar resultado se mesma key chegar de novo.

Ver `src/modules/idempotency/` (canônico).

## Logging com redact PII

```ts
logger.info({ workspace_id, channel_id }, 'channel.created');
// NUNCA: logger.info({ phone: '+5511...', token: '...' })
```

Pino com `redact: ['*.access_token', '*.phone', '*.display_phone_number', 'req.headers.authorization']`.

## Multi-tenant

Toda query DEVE filtrar por `tenant_id` (interno) ou `external_id` (do consumidor).
Nenhuma query "global" — risco LGPD.

## Erros (formato canônico Bevox — NÃO RFC 7807)

PRD §9.4 + OpenAPI v1.1.0 + CLAUDE.md §regras canônicas. Toda resposta
de erro DEVE seguir o envelope:

```json
{
  "error": {
    "code": "INVALID_INPUT",
    "message": "human-readable",
    "details": { "field": "value" },
    "request_id": "uuid"
  }
}
```

`code` é o enum canônico (`INVALID_INPUT`, `UNAUTHENTICATED`, `FORBIDDEN`,
`NOT_FOUND`, `IDEMPOTENCY_CONFLICT`, `INTERNAL`, etc. — ver §9.4). NÃO
usar RFC 7807 (`type`/`title`/`instance`) — divergiu desta rule mas o
canon e o código produzem `{error: {code, message, details, request_id}}`.
(Auditoria 2026-06-02 consistency-critic — `meta-api-modules.md` era o
outlier.)
