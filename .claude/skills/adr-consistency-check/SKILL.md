---
name: adr-consistency-check
description: |
  Validar uma ADR `MA-XXX` do bevox-meta-api contra: (a) outras ADRs MA-*
  (irmãs e antecessoras), (b) `prds/bevox-meta-api-prd-v1.md`, (c)
  `docs/architecture/openapi.yaml`, (d) invariantes do `CLAUDE.md §5`.
when_to_invoke: |
  - Edit ou Write em docs/adr/MA-*.md
  - Criação de ADR nova via agent `adr-author`
  - PRD ou OpenAPI acabou de citar uma MA-*; verificar coerência
  - Pedido explícito: "valida MA-014" / "essa ADR conflita com algo?"
inputs:
  - Número da ADR (ex: 014) ou path completo
outputs:
  - Lista de inconsistências (conflitos, supersedes implícitos, referências
    quebradas, status fora da tabela canônica)
  - Cross-check específico contra invariantes §5
  - Recomendações: bumpar status, criar ADR superseding, atualizar PRD/YAML
    que citam, abrir issue em bevox-knowledge
references:
  - docs/adr/README.md
  - references/conflict-patterns.md
  - hub: .claude/skills/adr-consistency-check/references/adr-status-rules.md
---

# Skill: adr-consistency-check (bevox-meta-api)

Variante local da skill homônima do hub Bevox, ajustada ao contexto
`MA-*`: prefixo diferente, fonte canônica externa (`bevox-knowledge`),
cross-check explícito contra OpenAPI e invariantes §5.

## Diferenças vs versão hub

| Item | Hub Bevox | Local meta-api |
|---|---|---|
| Prefixo | `ADR-NNN` | `MA-XXX` |
| Localização | `docs/adr/ADR-*.md` | `docs/adr/MA-*.md` **+** `bevox-knowledge/30_adr/bevox-meta-api/MA-*.md` (canonical) |
| PRD alvo | múltiplos em `prds/produto/` | apenas `prds/bevox-meta-api-prd-v1.md` |
| Cross-check extra | glossário, capability-matrix | **OpenAPI** + **invariantes §5** |
| Status válidos | mesma tabela `adr-status-rules.md` | idem |

## Procedimento

### 1. Resolver o path canônico

```bash
ADR_ID="$1"   # ex: 014
LOCAL="docs/adr/MA-${ADR_ID}-*.md"
KNOWLEDGE="../../bevox-knowledge/30_adr/bevox-meta-api/MA-${ADR_ID}-*.md"

# Existência em cada lado
ls $LOCAL $KNOWLEDGE 2>/dev/null
```

Se a ADR existe nos dois lugares, comparar `diff`. Divergência = SEV-H
(canonical é fonte de verdade; local deve ser o draft).

### 2. Ler a ADR completa

Extrair: Status, Data, Decisor(es), Decisão (frase categórica),
Alternativas (>= 2), Consequências (positivas + negativas + neutras),
Plano de implementação, Referências.

**Checks estruturais:**

- [ ] Status presente e dentro da tabela canônica (`adr-status-rules.md`).
- [ ] Data no formato `YYYY-MM-DD`.
- [ ] Pelo menos 2 alternativas (a escolhida + 1).
- [ ] Pelo menos 1 consequência negativa (se ausente → SEV-M).
- [ ] Referências apontam para paths/URLs que existem.

### 3. Cross-check contra outras MA-*

```bash
# Decisões duplicadas (P1)
rg -n "## Decisão" docs/adr/MA-*.md bevox-knowledge/30_adr/bevox-meta-api/MA-*.md \
  | sort

# Referências a MA-NNN
rg -n "MA-\\d+" docs/adr/MA-${ADR_ID}-*.md
```

Padrões a aplicar (de `references/conflict-patterns.md`):

- **P1 — Decisões duplicadas:** se MA-XXX decide sobre o mesmo objeto que
  outra MA Aceita sem `Status: Superseded by MA-XXX` na antiga, sinalizar.
- **P2 — Decisão implícita contradita:** ler "Consequências" das MA aceitas
  para detectar contradição lateral.
- **P3 — ADR aceita sem implementação:** se `Aceita` há > 90 dias mas grep
  no `src/` não encontra rastro, sinalizar (verificar com `invariants-auditor`).
- **P5 — ADR cita ADR inexistente:** `rg "MA-\\d+"` na ADR-alvo → checar
  cada referência contra `docs/adr/README.md`.

### 4. Cross-check contra PRD

```bash
rg -n "MA-${ADR_ID}\\b" prds/bevox-meta-api-prd-v1.md
```

- Se o PRD cita a ADR como `decidido` mas Status é `Proposta` → **P4**
  (PRD cita ADR Proposta). Bloqueia go-live se for MA-012-like.
- Se o PRD descreve comportamento incompatível com a Decisão da ADR →
  inconsistência semântica. Sinalizar com trechos lado a lado.

### 5. Cross-check contra OpenAPI

```bash
rg -n "MA-${ADR_ID}|<comportamento-decidido>" docs/architecture/openapi.yaml
```

Aplicável quando a decisão tem efeito de contrato (ex.: MA-002 define
formato de JWT; MA-006 define semântica de `Idempotency-Key`). Se a ADR
diz "RS256 com kid" e o OpenAPI documenta `securitySchemes` com `HS256`,
isso é conflito → SEV-H.

### 6. Cross-check contra invariantes §5

Para cada invariante I1..I10 do `CLAUDE.md §5`, perguntar:

- A decisão desta ADR **mantém** a invariante?
- A decisão **enfraquece** a invariante (ex.: introduz uma exceção)?
- A decisão **fortalece** a invariante (bom — registrar).

Se enfraquece sem mitigação explícita na seção "Consequências →
Negativas / riscos aceitos" → SEV-H. ADR que viola invariante sem
declarar é mudança de invariante por contrabando.

### 7. Severidade

| Severidade | Critério |
|---|---|
| SEV-H | Conflito direto Aceita ↔ Aceita; status inválido; viola invariante sem declarar; PRD trata Proposta como Aceita |
| SEV-M | Falta consequência negativa; alternativas < 2; referência quebrada P5 |
| SEV-L | Typo, formato de data, ordem de seção |

### 8. Saída

Tabela markdown:

| Check | Resultado | Evidência (path:linha) | Severidade |
|---|---|---|---|
| Estrutural — Status na tabela canônica | PASS / FAIL | ... | ... |
| Cross MA-* — P1 duplicada | PASS / FAIL | ... | ... |
| Cross PRD — cita como Aceita? | PASS / FAIL | ... | ... |
| Cross OpenAPI — coerente? | PASS / FAIL / N/A | ... | ... |
| Cross §5 — toca invariante I? | LISTAR I tocadas | ... | ... |
| ... | | | |

Recomendações em verbo infinitivo, ordenadas por SEV.

## NÃO faço

- Não edito a ADR.
- Não promovo status.
- Não escrevo o draft (isso é o `adr-author`).
- Não substituo carimbo humano (jurídico/fundador).
