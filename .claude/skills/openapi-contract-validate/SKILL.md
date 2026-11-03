---
name: openapi-contract-validate
description: |
  Validar `docs/architecture/openapi.yaml` (contrato público da bevox-meta-api)
  contra a versão anterior no git, detectar breaking changes e bloquear commits
  que introduzam quebra sem o bump major exigido pela política local
  (`.claude/rules/meta-api-contracts.md`).
when_to_invoke: |
  - Edit/Write em `docs/architecture/openapi.yaml` (ou `.yml`).
  - Antes de PR que altera o contrato OpenAPI.
  - Usuário pede "checar breaking change neste OpenAPI" ou "validar contrato".
  - Hook PostToolUse de contratos disparou.
inputs:
  - Path do OpenAPI atual (default: `docs/architecture/openapi.yaml`).
  - Ref git da versão anterior (default: `HEAD~1`).
outputs:
  - Lista de diferenças categorizadas: `breaking` | `non-breaking` | `informational`.
  - Recomendação de bump: `major` | `minor` | `patch` | nenhum.
  - Verdict: **PASS** ou **BLOCK** (bloqueia commit se houver breaking sem bump major).
  - Se BLOCK, mensagem listando: (a) ADRs MA-### necessários, (b) prefixo de commit exigido (`feat(api)!:` ou body com `BREAKING CHANGE:`).
references:
  - references/breaking-change-rules.md
  - ../../rules/meta-api-contracts.md
---

# Skill: openapi-contract-validate (bevox-meta-api)

Adaptação local do skill do hub. **Arquivo único** de contrato: `docs/architecture/openapi.yaml`. Política de breaking change em `.claude/rules/meta-api-contracts.md`.

## Procedimento

1. **Carregar versão atual** de `docs/architecture/openapi.yaml`.
2. **Carregar versão anterior** via `git show HEAD~1:docs/architecture/openapi.yaml`.
3. **Diff estrutural** seguindo `references/breaking-change-rules.md`:
   - Paths e operationIds (add/remove/rename).
   - Request bodies: propriedades required, tipos, enums.
   - Responses: status codes de sucesso, schemas, propriedades.
   - Security schemes (bearer JWT vs outros).
   - Headers obrigatórios (`X-Tenant-Id`, `Idempotency-Key`).
   - Códigos de erro canônicos em `components.schemas` (não remover `UNAUTHENTICATED`, `FORBIDDEN`, `INVALID_INPUT`, `NOT_FOUND`, `CONFLICT`, `IDEMPOTENCY_CONFLICT`, `RATE_LIMITED`, `META_UNAVAILABLE`, `META_REJECTED`, `INTERNAL`).
4. **Categorizar** cada diferença em `breaking` / `non-breaking` / `informational`.
5. **Comparar `info.version` atual vs anterior** (SemVer estrito):
   - Há `breaking` e major **bumpado** → OK.
   - Há `breaking` e major **NÃO bumpado** → **BLOCK**.
   - Apenas `non-breaking` (add endpoint, add property optional, add enum value, add error code) → exigir bump **minor**.
   - Apenas `informational` (description, summary, example) → bump **patch** aceitável (ou nenhum).
6. **Verificar ADR** quando houver breaking:
   - Procurar em `docs/adr/` arquivo `MA-###-*.md` que documente a mudança.
   - Verificar `Status: Accepted` e que ele `Supersedes:` um ADR anterior se aplicável.
   - Sem ADR → **BLOCK** com instrução para criá-lo.
7. **Verificar mensagem de commit** (se contexto disponível):
   - Breaking exige `feat(api)!:` ou `BREAKING CHANGE:` no body.
   - Non-breaking: `feat(api): ...`.
   - Patch: `docs(api): ...`.
8. **Emitir relatório**:
   ```
   OpenAPI diff — docs/architecture/openapi.yaml
   Previous version: <X.Y.Z>
   Current  version: <X.Y.Z>

   [breaking]      <descrição>          → exige major
   [non-breaking]  <descrição>          → exige minor
   [informational] <descrição>

   Verdict: PASS | BLOCK
   Required actions: <bump | ADR | commit prefix>
   ```

## SemVer estrito (MAJOR.MINOR.PATCH em `info.version`)

- **Major** — qualquer breaking change. Exige ADR MA-### + `feat(api)!:` ou `BREAKING CHANGE:` no commit + nota no CHANGELOG.
- **Minor** — nova capability backward-compatible. Exige `feat(api): ...`.
- **Patch** — apenas doc, exemplo, descrição. `docs(api): ...`.

## Sinais imediatos de breaking

Lista resumida (detalhes em `references/breaking-change-rules.md`):

- Remover/renomear endpoint ou operationId.
- Adicionar property **required** em request body.
- Remover property de response.
- Mudar tipo de property (string→number etc).
- Remover valor de enum.
- Mudar status code de sucesso (200→204 etc).
- Tornar header obrigatório que não era.
- Remover ou renomear código de erro canônico.

## Quando NÃO bloquear

- Apenas mudança em `description`, `summary`, `examples`, `externalDocs`.
- Reordenação de propriedades no schema (semanticamente equivalente).
- Adição de novo path/operação sem afetar existentes.
- Adição de property opcional em request ou response.
- Adição de novo código de erro 4xx/5xx (mantendo os canônicos).

## Output final esperado

Sempre devolver o verdict explícito ao agente chamador para que ele decida prosseguir ou abortar. Em caso de BLOCK, **não** continuar a operação que estava em andamento.
