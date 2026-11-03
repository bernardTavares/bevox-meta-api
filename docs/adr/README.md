# Architecture Decision Records — bevox-meta-api

> **Movido para canonical em 2026-05-08 (W7 pilot adopt).**
>
> As ADRs `MA-*` deste produto não vivem mais aqui. Fonte única em
> [`bevox-knowledge/30_adr/bevox-meta-api/`](https://github.com/bernardTavares/bevox-knowledge/tree/main/30_adr/bevox-meta-api)
> (currently em draft branch `draft/bevox-meta-api-knowledge-bootstrap` até review+merge).

## Por que numeração separada

A `bevox-meta-api` é produto autônomo. Misturar numeração com as ADRs do Bevox confundiria o leitor sobre o escopo de cada decisão. ADRs Bevox aplicam ao Bevox (mobile, web, backend, harness, console, compliance). ADRs `MA-*` aplicam apenas à meta-api.

ADRs Bevox são **referenciadas** quando uma decisão da meta-api espelha intencionalmente uma decisão Bevox (ex.: stack, idempotência, observabilidade). Isso é registro de "decisão alinhada", não de "decisão herdada".

## Índice (carimbar decisões já tomadas no PRD V1)

| # | Título | Status |
|---|--------|--------|
| MA-001 | Stack do bevox-meta-api (Node + TS + Fastify + Drizzle + PG + Redis) | Aceita |
| MA-002 | Auth de apps consumidores (JWT RS256 com kid) | Aceita |
| MA-003 | Tenancy model: meta-api tem registro próprio de tenants | Aceita |
| MA-004 | Multi-WABA por tenant (cada tenant traz seu próprio WABA) | Aceita |
| MA-005 | Webhook delivery em três modos (push + SSE + polling) | Aceita |
| MA-006 | Idempotência mandatória em mutações (espelha ADR-023 Bevox) | Aceita |
| MA-007 | Observabilidade: OTel + Sentry + Grafana (espelha ADR-017 Bevox) | Aceita |
| MA-008 | Cifra de tokens Meta (envelope encryption KMS + AES-256-GCM) | Aceita |
| MA-012 | LGPD — bevox-meta-api é sub-processador interno do grupo Bevox | **Proposta** (carimbo jurídico pendente — bloqueia produção) |

Ainda sem ADR escrita (PRD V1 §15):

- **MA-009** — Particionamento de AuditLog (volume).
- **MA-010** — Quando introduzir mTLS entre apps e meta-api.
- **MA-011** — Política de retenção fina (variar por app consumidor?).

## Regras

- **Uma decisão por ADR.**
- **Data obrigatória.**
- **Consequências negativas não podem ser omitidas.**
- **Nunca edite uma ADR aceita para mudar a decisão.** Escreva uma nova que a supersede.
- **Nunca reutilize um número MA-NNN.**

## Lifecycle

- **Proposta:** em discussão; arquivo exibe `Status: Proposta`.
- **Aceita:** consolidada; `Status: Aceita` + data.
- **Superada:** ADR permanece, com `Status: Superada por MA-XXX`. A ADR superadora explica o que muda.
