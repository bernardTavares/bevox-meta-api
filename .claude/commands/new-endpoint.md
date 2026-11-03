---
description: Orquestra o workflow §8.1 do CLAUDE.md (novo endpoint REST) invocando o agent endpoint-implementer.
---

# /new-endpoint

Implementa um endpoint novo seguindo a sequência canônica de §8.1: schema Zod → repository → service → routes → integration test → OpenAPI.

## Argumentos

Dois inputs obrigatórios, no formato livre:

1. **Módulo**: nome do módulo destino (ex.: `tenants`, `wabas`, `templates`, `messages`). Se o módulo não existir em `src/modules/`, o command pede confirmação antes de criar a estrutura padrão (§8.5).
2. **Descrição do endpoint**: método HTTP + path + propósito + payload esperado. Ex.: `POST /v1/tenants/:id/wabas/connect/init — inicia OAuth com Meta, retorna URL de redirect e state opaco`.

Uso típico:

```
/new-endpoint
módulo: wabas
descrição: POST /v1/tenants/:id/wabas/connect/init — inicia OAuth Meta, retorna { redirect_url, state }
```

## O que faz

1. Valida os dois inputs. Pergunta se faltar.
2. Carrega contexto: PRD §9 (contratos HTTP), MA-002 (auth), MA-003 (tenancy), MA-006 (idempotência), `docs/architecture/openapi.yaml`.
3. Invoca o agent **`endpoint-implementer`** passando módulo + descrição + refs de contexto.
4. Aguarda o agent produzir: `schemas.ts`, `repository.ts`, `service.ts`, `routes.ts`, teste em `tests/integration/<modulo>.test.ts`, patch no OpenAPI.
5. Roda `pnpm typecheck && pnpm lint` para sanity check.
6. Reporta arquivos tocados + próximos passos (rodar testes, atualizar PRD §9 se for endpoint novo não previsto, abrir PR).

## Invariantes obrigatórias (§5)

O agent deve respeitar: UUIDv7 (§5.1), Idempotency-Key em mutação (§5.2), scope por `app_id`/`tenant_id` (§5.3), redação de PII em logs (§5.6), audit log automático (§5.8), AppError tipado (§7.3).

## Não-faz

- Não cria migrations. Para schema novo, use `/new-migration` antes.
- Não atualiza ADRs. Se a implementação exige decisão nova, abortar e usar `/propose-adr`.
- Não roda `pnpm test:e2e` (só CI).
