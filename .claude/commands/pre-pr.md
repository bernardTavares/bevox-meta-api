---
description: Checklist pre-PR — roda typecheck+lint+test, audita invariantes e redação de secrets, detecta toque em contratos/ADRs/migrations. Output GO/NO-GO.
---

# /pre-pr

Gate de qualidade antes de abrir PR. Combina verificações automatizadas com auditoria de agents.

## Argumentos

Nenhum. Sempre opera sobre o diff atual vs `main` (`git diff main...HEAD` + working tree).

## O que faz

1. **Verificações automatizadas (sequencial, falha rápida):**
   - `pnpm typecheck` — se falhar, NO-GO imediato.
   - `pnpm lint` — se falhar, NO-GO imediato.
   - `pnpm test` — unit tests; se falhar, NO-GO imediato.
2. **Auditoria de invariantes:** invoca agent **`invariants-auditor`** com a lista de arquivos modificados. Agent verifica §5.1-§5.10 do CLAUDE.md (UUIDv7, Idempotency-Key, tenant-scope, tokens never logged, JWT RS256, PII redaction, soft-delete, audit log, HMAC webhooks, multi-WABA).
3. **Auditoria de redação de secrets:** invoca agent **`secrets-redaction-auditor`** para varrer o diff atrás de tokens Meta, `access_token`, `private_key_pem`, `messages.content`, payloads de webhook não-redacted, em logs/responses/Sentry.
4. **Detecção de toque em superfícies críticas:**
   - Diff toca `docs/architecture/openapi.yaml` ou `src/modules/*/schemas.ts`? → invoca agent **`contract-guardian`** para validar consistência contrato ↔ implementação.
   - Diff toca `docs/adr/MA-*.md`? → lista ADRs alterados e pede confirmação se há superseding.
   - Diff toca `db/migrations/`? → lista migrations novas, alerta sobre necessidade de revisão dupla (§13).
   - Diff toca `prds/`? → lista seções alteradas e exige PR description referenciando o motivo.
5. **Output GO/NO-GO:**
   - **GO**: nenhuma verificação falhou, nenhum agent retornou bloqueio. Lista resumo do diff (arquivos +/-, módulos tocados) e sugere título de PR em português (§15).
   - **NO-GO**: lista pendências numeradas, agrupadas por origem (typecheck/lint/test/invariants/secrets/contract).

## Não-faz

- Não roda `pnpm test:integration` nem `pnpm test:e2e` (CI faz). Se você quer rodar local, use os scripts de §16.
- Não abre PR. Não faz commit. Não faz push.
- Não modifica arquivos. Read-only para o working tree.
