# Patterns de conflito entre ADRs MA-* (bevox-meta-api)

Adaptado do hub Bevox (`.claude/skills/adr-consistency-check/references/conflict-patterns.md`)
para o contexto local: prefixo `MA-`, fonte canônica em `bevox-knowledge`,
cross-check contra OpenAPI e invariantes §5.

## P1 — Decisões duplicadas

Duas MA-* `Aceita` decidem sobre o mesmo objeto sem `Superseded by`
explícito na antiga.

**Exemplo:** MA-006 decide TTL de idempotência = 24h. Uma MA-014 nova
decide TTL = 1h sem marcar MA-006 como superseded → P1.

**Detecção:**
```bash
rg -n "## Decisão" docs/adr/MA-*.md bevox-knowledge/30_adr/bevox-meta-api/MA-*.md
```

**Resolução:** atualizar a antiga para `Status: Superseded by MA-XXX` na
mesma rodada de PR. A nova ADR deve explicar **o que mudou e por quê**.

---

## P2 — Decisão implícita contradita

MA-A implica X em "Consequências" ou "Alternativas"; MA-B (posterior)
decide não-X sem citar MA-A.

**Exemplo meta-api:** MA-001 escolhe Redis 7 e cita "Redis já é dependência
crítica do BullMQ". Uma MA-NN proposta decide trocar BullMQ por outra fila
sem mencionar a consequência sobre Redis → P2.

**Detecção:** leitura humana das seções "Consequências" das aceitas
relevantes ao tópico.

**Resolução:** ADR posterior referencia explicitamente a anterior, mesmo
que não a supersede formalmente.

---

## P3 — ADR aceita sem implementação

ADR `Aceita` há tempo, mas grep no `src/` não acha implementação.

**Exemplo meta-api hipotético:** uma MA aceita determina "particionamento
mensal de `audit_logs`" mas `db/schema/audit_logs.ts` não tem partição.

**Detecção:**
```bash
# Para cada MA-* Aceita, procurar token-chave da Decisão no src/
rg -n "<token-da-decisao>" src/ db/schema/
```

**Resolução:** abrir task TaskMaster + sinalizar ao decisor. Não é conflito
de ADR — é dívida de implementação.

---

## P4 — PRD cita ADR Proposta como decidida

`prds/bevox-meta-api-prd-v1.md` referencia MA-XXX como fato consumado,
mas a ADR está `Proposta`.

**Exemplo real:** MA-012 está `Proposta` (carimbo jurídico pendente).
PRD §12 não pode tratá-la como aceita sem qualificar com "posição
proposta, aguarda parecer".

**Detecção:**
```bash
# Listar todas MA-NNN citadas no PRD
rg -n "MA-\\d+" prds/bevox-meta-api-prd-v1.md
# Para cada uma, conferir Status na ADR
```

**Resolução:** PRD deve usar formulação tipo "conforme MA-XXX (Proposta,
pendente carimbo)" até a ADR ser aceita. Bloqueia go-live se a ADR
bloqueia go-live (caso MA-012).

---

## P5 — ADR cita ADR inexistente

ADR faz referência a `MA-099` que não existe em nenhum dos dois índices
(local + canonical).

**Detecção:**
```bash
# Numbers citados na ADR-alvo
rg -on "MA-\\d+" docs/adr/MA-${ID}-*.md | sort -u
# Cross-check com índice canonical
ls ../../bevox-knowledge/30_adr/bevox-meta-api/
```

**Resolução:** corrigir referência ou criar a ADR faltante.

---

## P6 — ADR conflita com OpenAPI

ADR declara contrato X, mas `docs/architecture/openapi.yaml` documenta Y.

**Exemplos:**
- MA-002 fixa `RS256 + kid`, mas `securitySchemes` no YAML aceita `HS256`.
- MA-006 fixa header `Idempotency-Key`, mas YAML não declara o header em
  paths mutadores.
- MA-005 fixa três modos de delivery (push + SSE + polling), mas YAML só
  documenta push.

**Detecção:** leitura cruzada — automação possível via
`.claude/skills/openapi-contract-validate` no hub.

**Resolução:** atualizar YAML na **mesma** rodada da ADR. Se a ADR aceita
já está mergeada e o YAML divergiu depois, é violação de
`.claude/rules/meta-api-contracts.md` — exige bump major + ADR
superseding.

---

## P7 — ADR enfraquece invariante §5 sem declarar

ADR introduz exceção a uma das 10 invariantes do `CLAUDE.md §5` sem listar
a exceção em "Consequências → Negativas".

**Exemplos:**
- ADR que permite endpoint mutador sem `Idempotency-Key` (viola I2/MA-006)
  e não declara isso como trade-off aceito.
- ADR que aceita JWT HS256 num caminho específico (viola I5/MA-002) sem
  justificar.
- ADR que persiste `messages.content` em log estruturado (viola I6) sem
  análise LGPD.

**Detecção:** revisor humano + agent `invariants-auditor` após a ADR
entrar em `Aceita`.

**Resolução:** voltar a ADR para `Proposta`, adicionar seção explícita,
re-revisar. Se a invariante é hard-stop (I4 tokens, I9 HMAC, I6 PII),
não há trade-off aceito — ADR deve ser rejeitada.

---

## P8 — Divergência local ↔ canonical

ADR existe nos dois lugares (`docs/adr/` local + `bevox-knowledge/30_adr/
bevox-meta-api/` canonical) e o conteúdo difere.

**Política:** canonical vence. O local só serve como draft pré-merge.

**Detecção:**
```bash
diff docs/adr/MA-XXX-*.md ../../bevox-knowledge/30_adr/bevox-meta-api/MA-XXX-*.md
```

**Resolução:** sincronizar para canonical. Se a divergência for
intencional (refinamento em draft local antes de promover), garantir que
o canonical é atualizado na mesma rodada do carimbo `Aceita`.
