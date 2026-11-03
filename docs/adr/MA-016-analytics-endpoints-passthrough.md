# MA-016: meta-api expõe endpoints de analytics (conversation + template)

**Status:** Proposta
**Data:** 2026-06-02
**Decisor(es):** Bernard Tavares (fundador), equipe Bevox
**Revisor(es):** —
**Bloqueia:** Sub-projeto **Cleanup** da migração bevox-direct → meta-api
(critério "zero `graph.facebook.com`"). **Não** bloqueia Foundation/Dispatch.

---

> **ADR de intenção/backlog.** Carimba a decisão de *direção* (o meta-api ganha
> analytics) para destravar o planejamento da migração do bevox-direct. O
> **design concreto fica para o spec** — ver "Escopo deixado para o spec".

## Contexto

ADR-012 (bevox-knowledge) estabelece o meta-api como **gateway único** da Meta:
nenhum consumer Bevox fala com `graph.facebook.com` direto. Hoje o meta-api
**não expõe analytics** — zero endpoints de insights/métricas.

O consumer **bevox-direct** ainda lê **direto do Graph**, num job diário, dois
endpoints: `conversation_analytics` (custo/conversas) e `template_analytics`
(qualidade/uso de template) — em `apps/api/src/services/metrics.service.ts` +
`jobs/metrics-sync.job.ts`.

A migração do bevox-direct para o meta-api (PRD `2026-05-07-bevox-meta-api-migration-prd.md`)
tem um sub-projeto **Cleanup** que **dropa o token Meta** do bevox-direct e
exige "zero `graph.facebook.com`". Sem analytics no meta-api, o bevox-direct ou
(a) perde a leitura de analytics (sem token), ou (b) mantém um token só pra
isso — violando ADR-012 e re-introduzindo custódia de token. Nenhum dos dois é
aceitável.

## Alternativas consideradas

### Opção A — meta-api expõe analytics read-only (escolhida)

O meta-api ganha endpoints read-only, multi-tenant, que fazem passthrough das
Analytics da Graph API (conversation + template), escopados por tenant/WABA e
usando o token cifrado da WABA (MA-008). O consumer chama o meta-api, não a Meta.

**Prós:**
- Fecha "zero `graph.facebook.com`" do Cleanup sem perder analytics.
- Preserva a não-custódia de token no bevox-direct (ganho central da migração).
- Mantém o boundary de ADR-012 (gateway único) consistente.

**Contras:**
- Novo módulo no meta-api — trabalho não trivial.

### Opção B — bevox-direct mantém um token Meta só para analytics

Manter no bevox-direct um token Meta de leitura, exclusivo para os dois
endpoints de analytics, e não migrar essa parte.

**Prós:**
- Zero trabalho no meta-api.

**Contras:**
- Viola ADR-012 (consumer falando direto com o Graph).
- Re-introduz custódia/rotação de token no bevox-direct — exatamente o que a
  migração elimina.
- Deixa o critério "zero `graph.facebook.com`" do Cleanup permanentemente aberto.

## Decisão

**O meta-api passa a expor endpoints de analytics read-only, multi-tenant,
escopados por tenant/WABA, fazendo passthrough das Analytics da Graph API
(conversation analytics + template analytics) e usando o token cifrado da WABA
(MA-008) — substituindo o consumo direto do Graph pelos consumers.**

Forma exata dos endpoints, parâmetros e estratégia de cache ficam para o spec.

### Escopo deixado para o spec (não decidir aqui)

- Passthrough puro vs. persistir/cache com TTL — analytics Meta tem latência e custo.
- Forma dos endpoints (ex.: `GET /v1/tenants/{id}/wabas/{waba_id}/analytics/conversations`
  e `.../analytics/templates`) + parâmetros (range, granularity, métricas/dimensões).
- Rate limit e scoping; reuso do token cifrado da WABA (MA-008).
- Redação/PII nas métricas retornadas.

## Consequências

### Positivas

- Fecha o critério "zero `graph.facebook.com`" do Cleanup do bevox-direct.
- Mantém o ganho de não-custódia de token no consumer.
- Reforça o boundary de gateway único (ADR-012).

### Negativas / riscos aceitos

- **Novo módulo de superfície read da Meta** — custo de build + manutenção, e
  expõe o meta-api a quotas/latência das Analytics da Meta (que diferem do hot
  path de messaging). Aceito: é o preço de honrar ADR-012; mitigação (cache/TTL)
  fica para o spec.
- **Decifra token da WABA fora do hot path de messaging** (MA-008) — analytics
  passa a ser mais um caminho que decifra `access_token` em memória. Confronta o
  invariante CLAUDE.md §4.4 (token nunca em log/response/Sentry): o token deve
  permanecer variável local de escopo de função e a chamada Meta passar por
  `serializeErrorRedacted`. Confronto com `.claude/rules/secrets-never-log.md`
  obrigatório no PR do spec/implementação.
- **PII nas métricas** — analytics Meta pode carregar dimensões sensíveis; a
  redação/allowlist do payload fica como requisito explícito do spec (não
  retornar dimensão crua sem allowlist).

### Neutras

- Gate do **Cleanup** (último sub-projeto da migração), não de Foundation/Dispatch
  — pode ser construído em paralelo sem bloquear as fases iniciais.

## Plano de implementação

1. Escrever o spec de design (endpoints, parâmetros, cache/TTL, rate limit,
   redação) — resolve as questões "deixadas para o spec".
2. Implementar o módulo `analytics` (read-only) seguindo o spec.
3. Migrar o `metrics-sync.job.ts` do bevox-direct para consumir o meta-api.
4. Fechar o critério "zero `graph.facebook.com`" no Cleanup + dropar o token Meta
   do bevox-direct.

## Referências

- ADR-012 (gateway boundary — bevox-knowledge).
- PRD de migração bevox-direct → meta-api
  (`bevox-knowledge/35_specs/bevox-direct/2026-05-07-bevox-meta-api-migration-prd.md`).
- ADR MA-008 — Cifra de tokens Meta (reuso do token cifrado da WABA para chamar
  Graph analytics).
- ADR MA-004 — Multi-WABA por tenant (scoping tenant/WABA).
- `.claude/rules/secrets-never-log.md` (confronto §4.4 — token + redação de PII).
