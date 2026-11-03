---
name: meta-api-contracts
glob: "{docs/architecture/openapi.yaml,docs/architecture/openapi.yml,src/mcp/**,src/bin/mcp-server.ts,skills/bevox-meta-api-consumer/**}"
description: Contratos públicos. Breaking change exige ADR + bump major + nota no commit.
priority: 1
---

# Regra: contratos públicos do meta-api

Você está editando um contrato público. Política:

1. **Breaking change** exige:
   - Bump major em `info.version` (OpenAPI) ou em `package.json` (MCP/skill)
   - ADR documentando
   - Commit `feat(api)!: ...` ou `BREAKING CHANGE: <descrição>` no body

2. **Non-breaking** (adicionar capability): bump minor + `feat(api): ...`

3. **Patch** (descrição, exemplo, fix doc): bump patch + `docs(api): ...`

4. **Sempre** após merge: rodar `scripts/sync-contracts.sh` no hub.

## Sinais de breaking

Ver hub: `.claude/skills/openapi-contract-validate/references/breaking-change-rules.md`
(12 padrões sempre-breaking, 6 non-breaking, casos ambíguos).

## Não fazer

- Editar contrato sem testes regression.
- Remover propriedade sem deprecate-period.
- Mudar tipo sem migration path.
- Passar `app_secret` ou `access_token` em response (NUNCA).
