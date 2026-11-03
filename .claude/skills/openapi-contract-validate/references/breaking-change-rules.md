# OpenAPI — Regras de breaking change (bevox-meta-api)

Adaptado de `bevox-PRD-consolidation/.claude/skills/openapi-contract-validate/references/breaking-change-rules.md` com particularidades do `docs/architecture/openapi.yaml` deste serviço.

Política local que rege esta tabela: `.claude/rules/meta-api-contracts.md`.

## 1. Sempre breaking — exigem bump **major** + ADR MA-### + `feat(api)!:`

1. **Remover endpoint** — deletar um `path` ou um `operationId` existente.
2. **Mudar método HTTP** no mesmo path (ex.: `GET /v1/templates` → `POST /v1/templates`).
3. **Remover propriedade `required`** de request body que já era exigida.
4. **Adicionar propriedade `required` nova** em request body (consumidores antigos quebram).
5. **Remover propriedade de response** que clients podem estar lendo (ex.: tirar `provider_message_id` de `POST /v1/messages`).
6. **Mudar tipo** de propriedade (`string → number`, `string → array`, `object → string`).
7. **Mudar enum removendo valores** (ex.: tirar `META_UNAVAILABLE` do enum de `error.code`).
8. **Renomear propriedade** (deletar + adicionar nova ≠ rename para o cliente).
9. **Mudar formato de path** (`/v1/waba/:id` → `/v2/waba/:id` ou `/v1/whatsapp-business-accounts/:id`).
10. **Mudar status code de sucesso** (`200 → 204`, `201 → 200`).
11. **Mudar/restringir esquema de autenticação** (bearer JWT → cookie sem manter o anterior; trocar `kid` obrigatório por outro mecanismo).
12. **Mudar limites mais restritivos** (`maxLength` menor, `maximum` menor, `minimum` maior).

### Específicos do meta-api

13. **Tornar obrigatório** um header que era opcional (`X-Tenant-Id`, `Idempotency-Key`, `X-Request-Id`).
14. **Remover ou renomear código de erro canônico** em `components.schemas.ErrorCode` ou no enum `error.code`. Os 10 códigos canônicos do PRD §7.3 são **contrato firme**:
    `UNAUTHENTICATED`, `FORBIDDEN`, `INVALID_INPUT`, `NOT_FOUND`, `CONFLICT`, `IDEMPOTENCY_CONFLICT`, `RATE_LIMITED`, `META_UNAVAILABLE`, `META_REJECTED`, `INTERNAL`.
15. **Mudar mapeamento HTTP** de código canônico (ex.: `META_REJECTED` deixar de ser 422).
16. **Remover scope** do JWT que clients usavam, ou restringir scope existente.

## 2. Geralmente non-breaking — exigem bump **minor** + `feat(api): ...`

1. **Adicionar endpoint novo** (path/operationId que não existia).
2. **Adicionar propriedade opcional em response** (clients antigos ignoram).
3. **Adicionar propriedade opcional em request body** (com default sensato).
4. **Adicionar valor a enum** — atenção: clients com validação estrita podem quebrar. Documentar.
5. **Adicionar novo código de erro 4xx/5xx** mantendo os canônicos (ex.: novo subcase mapeado de Meta).
6. **Relaxar limites** (`maxLength` maior, `minimum` menor).

### Específicos do meta-api

7. Adicionar header opcional de resposta (ex.: `X-RateLimit-Remaining`).
8. Adicionar novo campo em `error.details` (cliente trata como `unknown`).
9. Documentar nova entrada na tabela `details.meta_code` (continua sendo passthrough).

## 3. Sempre safe — bump **patch** + `docs(api): ...` (ou nenhum)

- Editar `description`, `summary`, `externalDocs`.
- Editar `examples`.
- Reorganizar ordem de propriedades no schema (semanticamente equivalente).
- Corrigir typo em descrição.
- Adicionar `x-*` extension informacional.

## 4. Casos ambíguos — pedir revisão humana

- **Mudar `format`** (`date-time` → `date`, `uuid` → `string`).
- **Adicionar `nullable: true`** em resposta (cliente que assumia non-null quebra).
- **Renomear `operationId`** mantendo path/método (SDK gerado quebra; HTTP cliente direto não).
- **Tornar `additionalProperties: false`** onde antes era permissivo.
- **Mudar `discriminator`** em oneOf/anyOf.
- **Mudar tipo de retorno de erro** de `META_REJECTED` (422) para `META_UNAVAILABLE` (502) ou vice-versa para a mesma falha — pode quebrar lógica de retry no cliente.

## 5. Checklist rápido para o validador

Para cada diff:

- [ ] É remoção? → breaking.
- [ ] É adição required? → breaking.
- [ ] Muda tipo/enum/status? → breaking.
- [ ] Toca em código de erro canônico? → breaking.
- [ ] É adição opcional pura? → non-breaking (minor).
- [ ] É apenas texto/exemplo? → informational (patch).
- [ ] Está num caso ambíguo? → pedir revisão humana, marcar como breaking por default (fail-safe).
