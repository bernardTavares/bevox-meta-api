# Gap Analysis — bevox-meta-api — 2026-06-02

> Auditoria de prontidão (read-only) contra a documentação canônica: PRD V1, ADRs
> MA-001..MA-008 + MA-012/013/014, ADRs `_shared` (ADR-005/012/019/021), OpenAPI
> (repo v1.0.0 + canon v1.1.0), consumer-integration-guide, go-live checklist e
> runtime-topology. Gerada autonomamente por Claude Code (effort max, multi-agente).
> Nenhum código de produto foi alterado.

## Resumo executivo

A `bevox-meta-api` é **funcionalmente densa e bem-arquitetada** — invariantes de base estão sólidos (UUIDv7, JWT RS256+kid+≤5min, HMAC inbound *e* outbound, envelope-encryption MA-008, `db.transaction()` em escritas múltiplas, `env.ts` que **falha-rápido no boot** se a config de produção estiver errada). 290 testes passam (Node 22). Mas há um **descompasso grave entre o que a documentação diz e o estado real**, e um conjunto de defeitos que quebram o piloto quando ele receber tráfego Meta real.

Estado real (≠ README): a `README` diz "pré go-live, nenhum consumidor em produção", mas o prod **já está no ar** (`meta-api.example.com`, k3s, go-live 2026-05-27) e um consumer-app `bevox-backend` foi **provisionado em 2026-05-31**. Ao mesmo tempo, a topologia canônica do piloto (`runtime-topology.md`, atualizada 2026-06-01) **não inclui a meta-api** — ela roda num host separado, fora do desired-state SoT do piloto. "Entrar no piloto" aqui = a meta-api passar a receber tráfego de consumidor + webhooks reais da Meta.

Principais riscos para o piloto/GA:

1. **MA-012 (LGPD) ainda `Proposta`** — bloqueio jurídico duro de produção; os 4 critérios de "Aceita" estão abertos. (CRÍTICO, não-código.)
2. **Mídia inbound é silenciosamente perdida** — o 5º worker (`media-download`) está habilitado no pipeline mas **não é deployado** em k8s nem compose. (CRÍTICO.)
3. **Eventos inbound são perdidos permanentemente** em qualquer queda de consumidor > ~2 min — os 3 "botões" de retry estão desalinhados, o `dead_letter` nunca é alcançado e o replay não enxerga nada. (CRÍTICO.)
4. **O `code` de OAuth vaza nos logs de request em produção** na rota pública de callback. (CRÍTICO.)
5. **O caminho de envio assíncrono tem 0% de teste** — branch de retry/terminal não-validado num caminho consumer-facing. (CRÍTICO-risco.)

Acima disso: **observabilidade praticamente morta** (a maioria das métricas/alertas MA-007 consulta séries que o código nunca emite; workers não são scrapeáveis; OTEL não exporta), **drift sistemático OpenAPI⇄código** que quebra qualquer consumidor gerado a partir do contrato, e **IG só meio-implementado** (envio lança `INTERNAL`, token nunca renova).

**Números:** 142 achados — **5 CRÍTICO (~38h), 30 ALTO (~141h), 71 MÉDIO (~207h), 36 BAIXO (~60h)** ≈ **447h**. Pós-verificação adversarial: 33 confirmados, 17 rebaixados, 1 refutado (ver Notas de método). Para destravar o piloto com segurança real, o caminho mínimo são os 5 CRÍTICOS + um subconjunto dos ALTOS de contrato/observabilidade/webhook (~80–100h de engenharia, fora MA-012 que é jurídico).

---

## Achados por severidade

> Convenção: `arquivo:linha` é evidência verificada. "Corroborado por N auditores" indica
> achado independente por múltiplos agentes. Achados duplicados entre dimensões foram fundidos.

### CRÍTICO (bloqueia piloto)

**C1 — `code`/`state` de OAuth vazam no log de request das rotas públicas de callback**
- Evidência: `src/bootstrap/server.ts:86` (`disableRequestLogging:false`, sem `req` serializer custom) + `src/modules/wabas/routes.ts:36-66` (`GET /v1/oauth/waba/callback?code=…&state=…`) + `src/modules/ig/routes.ts:37-62`.
- Impacto: o serializer `req` default do Fastify 5 loga `req.url` **com query string**. Nessas rotas **não-autenticadas** do hot path de Embedded Signup, o `code` (segredo curto que troca direto por um `access_token` Meta) e o `state` vão para o log de produção em claro. Verificado empiricamente ("oauth code leaked: true"). Viola invariante §5.4 ("url sem query string sensível").
- Recomendação: registrar o `req` serializer canônico (`{method, url-sem-query, request_id, app_id, tenant_id}`) em `server.ts` **e** `logger.ts`; no mínimo redijir `code`/`state`/`access_token` nessas rotas. Esse mesmo serializer fecha C-relacionados de logging (A3/A4).
- Esforço: 3h · Confiança: ALTA · Verdict: CONFIRMED.

**C2 — worker `media-download` (5º worker) não é deployado em lugar nenhum → mídia inbound nunca é baixada**
- Evidência: `k8s/deployment-workers.yaml` (só `worker-out/in/tok/cleanup`); `docker-compose.prod.yml:13` ("4 workers"); produtor ativo em `src/modules/inbound/service.ts:281-285` (`getMediaDownloadQueue().add("download", …)`); consumidor em `src/workers/media-download.ts` (BullMQ standalone) **não roda**; `src/modules/media/service.ts:53` devolve `202 {status:"processing"}` até o objeto existir.
- Impacto: o consumidor do piloto (`bevox-backend`, provisionado em prod 2026-05-31) recebendo **qualquer** mídia WhatsApp/IG enfileira jobs que nenhum processo consome. `GET /v1/media/...` devolve 202 para sempre; jobs reenfileiram 4× e acumulam no Redis (PVC único) sem limite. **Perda funcional de dados** no caminho de mídia inbound.
- Recomendação: adicionar 5º Deployment (`worker-media`, `command: node --import tsx/esm src/workers/media-download.ts`, mesma fiação WIF/emptyDir/SA do `worker-out`) + serviço equivalente no compose. `package.json:20` já tem `worker:media`.
- Esforço: 1.5h · Confiança: ALTA · Verdict: CONFIRMED. **(Melhor relação valor/esforço da auditoria.)**

**C3 — entregas de webhook esgotadas nunca viram `dead_letter` → queda de consumidor > ~2 min perde eventos para sempre, sem replay** *(corroborado: pilot-risk + canon-divergence)*
- Evidência: `src/lib/queues.ts:24-29` (`DEFAULT_JOB_OPTIONS.attempts:5`, backoff exp 5s) + `src/modules/inbound/service.ts:314-322` (enfileira sem override → herda `attempts:5`) + `src/workers/webhook-delivery.ts:42` (`MAX_ATTEMPTS=6`) + `:173-186` (`isTerminal` só quando `totalAttempts>=6`) + `src/modules/webhooks/repository.ts:118-133` (`listDeadLetterDeliveries` filtra `status='dead_letter'`).
- Impacto: BullMQ encerra na 5ª tentativa; o worker só grava `dead_letter` em `>=6` — **nunca alcançado**. Na 5ª falha grava `failed` e a row jamais vira `dead_letter`, então `POST /admin/subscriptions/:id/replay` e `pnpm cli dead-letter replay` **não enxergam nada**. Pior: a cadência real é exp-5s (~5s,10s,20s,40s ≈ <2min), **não** o schedule `[0s,30s,2min,10min,1h,6h]` (~7h) do PRD §10.2. Consumidor fora do ar > ~2 min durante um deploy → **perda permanente de toda mensagem inbound**, sem recuperação. `WEBHOOK_DELIVERY_MAX_RETRIES` é parseado mas nunca usado; coluna `nextRetryAt` é escrita e nunca lida.
- Recomendação: alinhar os 3 botões (enfileirar com `attempts=MAX_ATTEMPTS` ou ler `WEBHOOK_DELIVERY_MAX_RETRIES`; marcar `dead_letter` no `attemptsMade>=attempts`); implementar o backoff do PRD §10.2; teste de worker afirmando `dead_letter` + `listDeadLetterDeliveries`.
- Esforço: 6h · Confiança: ALTA · Verdict: CONFIRMED → **FIXED (2026-06-02, branch `fix/webhook-deadletter-alignment`)**. Os 3 botões foram alinhados: produtor (`src/modules/inbound/service.ts` + `src/modules/webhooks/service.ts`) enfileira com `webhookDeliveryJobOptions()` → `attempts = env().WEBHOOK_DELIVERY_MAX_RETRIES` (default 8) + `backoff: { type: WEBHOOK_BACKOFF_STRATEGY }`; `defaultJobOptions` da queue webhook-delivery também passou a refletir esse contrato. Worker (`src/workers/webhook-delivery.ts`) sourceia `MAX_ATTEMPTS` de `env().WEBHOOK_DELIVERY_MAX_RETRIES` e registra a custom strategy `bevox-prd-10-2` em `settings.backoffStrategy` → `getWebhookBackoffDelay(attemptsMade)` (PRD §10.2 `[0s,30s,2min,10min,1h,6h]`, clamp em 6h). Cobertura: 6 testes em `tests/unit/modules/inbound/service.test.ts` + 2 testes adicionais em `tests/unit/workers/webhook-delivery.test.ts` (MAX_ATTEMPTS env-driven + dead_letter terminal mesmo com `delivery.attempts` desalinhado).

**C4 — worker de envio assíncrono (`processOutboundJob`) com 0% de teste — caminho consumer-facing inteiro não-validado** *(risco crítico, não defeito comprovado)*
- Evidência: `src/workers/outbound-dispatcher.ts` (0% — linhas 43-184); grep `processOutboundJob|startOutboundWorker|deliverCallback` em `tests/` → 0. `tests/unit/modules/messages/async.test.ts` testa só o **enfileiramento** (fila mockada), nunca o worker.
- Impacto: `POST /v1/messages/async` é o caminho de mensageria assíncrona do consumidor. O worker que de fato entrega está **completamente não-testado**: a classificação retryable-vs-terminal (`:110-123`) que decide re-throw (backoff) vs marcar `failed` permanente — um branch errado **dropa silenciosamente** ou **retenta para sempre**; as transições de status; e o HMAC de `deliverCallback`. Que esse worker abriga defeitos reais já está **provado** por dois achados ALTO/MÉDIO no mesmo arquivo (IG lança `INTERNAL`; cria `OutboundJob` duplicado por design) — o que eleva a probabilidade de mais branches quebrados não-cobertos.
- Recomendação: teste espelhando `webhook-delivery.test.ts` — happy path → `sent`+callback; `META_UNAVAILABLE` → `queued`+re-throw; `META_REJECTED` → `failed` sem re-throw; falha de callback engolida. Afirmar o HMAC sobre o body exato.
- Esforço: 4h · Confiança: ALTA · Verdict: CONFIRMED (tier mantido; enquadrado como risco).

**C5 — MA-012 (postura LGPD) ainda `Status: Proposta` — bloqueio duro de produção, 4 critérios de "Aceita" abertos**
- Evidência: `bevox-knowledge/30_adr/bevox-meta-api/MA-012-…:3` (`Proposta`), `:7` (`Bloqueia: go-live`), `:179-182` (4 critérios), `:198-200`; `prds/bevox-meta-api-prd-v1.md:713` ainda diz "Acredita-se ser defensável" — a frase exata que MA-012:160 manda substituir.
- Impacto: go-live contratualmente bloqueado. A postura "sub-processador interno" é declaração unilateral sem parecer externo. Sem ela, todo PII processado para um consumidor real (conteúdo de mensagem, números, IG handles) está sem base jurídica carimbada. 4 portões abertos: (1) parecer escrito de advogado; (2) OT-19 publicada na RoPa (`bevox-compliance-lgpd-prd-v1.md`); (3) PRD §12 atualizado; (4) status → `Aceita`.
- Recomendação: tratar como portão #1. **Engenharia não fecha** — exige os artefatos jurídicos de MA-012:179-182.
- Esforço: ~24h (jurídico) · Confiança: ALTA · Verdict: CONFIRMED · **Dep: advogado externo + RoPa OT-19 (canon).**

### ALTO (bloqueia GA, não bloqueia piloto)

**Segurança / segredos / logging**
- **A1 — `AppError.details` vaza segredos no log de erro**: sem `err` serializer e a lista `redact` de runtime não percorre `err.details.*`. Ev: `src/bootstrap/error-handler.ts:118-126`, `src/bootstrap/server.ts:53-64`, `src/lib/errors.ts:60-66`. Verificado empiricamente (token em `details` → log em claro). 5h.
- **A2 — `serializeErrorRedacted` e `src/lib/redact.ts` não existem**: a regra canônica os exige (scrub de stack para shapes `eyJ…`/`EAA…`); nenhum existe (`grep serializeError* src/` → 0). Stacks nunca são limpos de tokens. 4h.
- **A3 — async outbound grava `request_body` cru + `callback_secret` no job BullMQ/Redis sem redact**: `src/modules/messages/service.ts:249-258`, `src/lib/queues.ts:86-96`. Conteúdo de mensagem (PII) + segredo HMAC persistem em Redis por dias. 4h.
  > A1+A2+C1 têm **a mesma correção raiz** (serializers `req`/`err` canônicos) — resolver juntos.

**Webhook / inbound (caminho que roda primeiro quando a Meta dispara)**
- **A4 — `JSON.parse` não-confiável roda ANTES do HMAC** (`parse-before-verify`): o content-type parser (`src/modules/inbound/routes.ts:47-55`) parseia o body na fase de parsing do Fastify, antes de `verifySignature` (`:78-86`). DoS de CPU por payload forjado não-autenticado. 3h.
- **A5 — dedup `SETNX` roda ANTES do persist** → erro transitório (DB blip, deadlock) no processamento dropa o evento permanentemente no retry da Meta: a chave de dedup (TTL 24h) é reivindicada em `:241` antes de `insertInboundEvent` em `:264`. 3h.
- **A6 — caminho HMAC inválido não emite métrica** (`webhook_signature_invalid_total` ausente) e métricas de entrega definidas mas nunca incrementadas → cego para forja e falha de entrega. `src/modules/inbound/routes.ts:82-86`, `src/lib/metrics.ts`. 2h.
- **A7 — runbook + checklist canônico registram o callback como `/webhooks/meta/{whatsapp,instagram}`, mas o código serve só `/webhooks/meta`** → seguir o runbook 404a o handshake de verificação e **todos** os eventos inbound. `src/modules/inbound/routes.ts:58,78` vs `docs/ops/2026-05-25-go-live-prod-plan.md:289-290`. 2h (+ edit de doc canônico).
- **A8 — eventos inbound do Instagram não têm dedup** (`metaEventId` sempre `null`) → cada re-entrega da Meta duplica o evento. `src/modules/inbound/service.ts:201-211` (IG passa `value=undefined`). 3h.

**Tenancy / isolamento**
- **A9 — o plugin `tenant-scope` NÃO existe**: a invariante §5.3 descreve um componente auto-injetor inexistente; o scoping é 100% manual (cada autor passa `req.auth.appId` à mão). `src/plugins/` (sem `tenant-scope.ts`); `request-context.ts:43` `patchContext` nunca é chamado. Um esquecimento = vazamento cross-app. 6h (+ reconciliar CLAUDE.md §5.3 / MA-003). *(corroborado: invariants + tenant)*
- **A10 — resolução de tenant do webhook inbound busca WABA só por `metaWabaId`** (sem scope app/tenant, `.limit(1)` arbitrário); a unicidade é `(tenant_id, meta_waba_id)`, não global. `src/modules/wabas/repository.ts:84-91` ← `src/modules/inbound/service.ts:160`. Roteamento de evento para o tenant errado se um `meta_waba_id` colidir. 4h.

**Contrato / OpenAPI (quebra consumidor gerado a partir do spec)**
- **A11 — `GET /v1/messages/{message_id}` declarado em ambos os specs, sem handler**: `openapi.yaml` repo `:526-544` + canon `:528` (operationId `getMessage`); `src/modules/messages/routes.ts` só tem POST/POST async. SDK gerado → 404. 3h. *(corroborado: endpoint + drift)*
- **A12 — conflito de idempotência devolve HTTP 409, specs (repo+canon) anunciam 422** para `IDEMPOTENCY_CONFLICT`; PRD §5.10 e MA-006 dizem 422. `src/lib/errors.ts:33`, `src/plugins/idempotency.ts:103`, canon `openapi.yaml:86,490`. 2h.
- **A13 — endpoints de lista devolvem `{items:[…]}` mas o spec exige envelope `{data:[…]}`** (7 endpoints: tenants/wabas/webhooks/apps/templates/ig/phone-numbers). `src/modules/*/routes.ts`. Mismatch sistemático em toda coleção que o piloto consome. 4h.
- **A14 — callback OAuth do Instagram (`GET /v1/oauth/ig/callback`) implementado mas declarado em NENHUM spec** → round-trip IG só meio-documentado. `src/modules/ig/routes.ts:37`. 2h.
- **A15 — `POST /admin/dsr` (DSR/erasure LGPD) especificado em PRD §12.4 / MA-012, não implementado** e ausente de qualquer spec (deferido p/ iteração 1.1). Sem mecanismo de erasure roteado de um consumidor. `grep dsr src/` → só um comentário. 8h. *(corroborado: endpoint + lgpd + bugs — primitivas de cascade são código morto)* · **Dep: MA-012.**

**Observabilidade (cega exatamente no que importa no piloto)**
- **A16 — observabilidade em grande parte MORTA**: 5 de 6 painéis Grafana + 3 de 6 alertas consultam métricas que **nenhum código** emite. `metaRequestDuration.observe()` / `webhookDeliveryTotal.inc()` / `tokenRefreshTotal.inc()` → 0 chamadas em `src/`. `src/lib/metrics.ts`. 6h.
- **A17 — métricas de worker são fisicamente não-scrapeáveis**: o `ServiceMonitor` seleciona só `component=api`; workers são processos tsx sem servidor `/metrics`. `k8s/observability/servicemonitor.yaml:14-17`. A única métrica emitida hoje (cleanup) já é invisível. 4h.
- **A18 — traces OTEL silenciosamente ausentes em prod**: `configmap.yaml` omite `OTEL_EXPORTER_OTLP_ENDPOINT` (no-op) e o valor do go-live-plan duplica `/v1/traces` (404). `src/lib/telemetry.ts:43,64-65`. 2h.
- **A19 — `/readyz` checa só postgres+redis, NÃO KMS** (contradiz comentário do manifest): WIF/KMS quebrado → pods Ready, rollout verde, e a **primeira** chamada Meta/refresh/mídia falha em runtime. `src/lib/health.ts:56-62`. 3h.

**Go-live / topologia canônica**
- **A20 — meta-api AUSENTE de todo registry canônico `_shared`** (`runtime-topology.md`, `hardening-registry`, `health-registry`, `registry`, `system-map`) e a SoT de runtime do piloto omite a dependência viva `bevox-backend→meta-api`. Responder a incidente consultando esses docs não acharia a meta-api. 4h (edit canônico). *(corroborado: go-live + consistency)* · **Dep: bevox-knowledge.**

**Tokens / retenção / LGPD técnica**
- **A21 — cleanup NÃO aplica retenção de 5 anos de `audit_logs`** (nenhuma deleção temporal): `src/workers/cleanup.ts:1-11,38-46` só trata idempotency/inbound/outbound. `audit_logs` cresce sem limite. 4h.
- **A22 — rows de token Meta (`waba_tokens`/`ig_tokens`) nunca são deletadas** — ciphertext superseded+expirado acumula para sempre (blast radius crescente). Rotação só faz `SET supersededAt`. `db/schema/bindings.ts:70-87,146-162`. 4h.

**Testes (hot paths)**
- **A23 — cliente Meta Graph: só 2 de 13 métodos testados** (`getMediaMetadata`+`downloadMedia`); `exchangeCode`, `discoverWaba`, `send*`, `template*` e `mapMetaError` 0% exercitados contra respostas Meta-shaped. `src/integration/meta-client.ts` 27%. 6h.
- **A24 — transações multi-write de `wabas/repository.ts` 0% cobertas** e sem harness Postgres (as únicas paths da invariante 11). `:40-283`. 5h.
- **A25 — `token-resolver.ts` (seleção/decrypt de token MA-008) 0% coberto** — a query que escolhe o token ativo (`supersededAt IS NULL AND expiresAt > now` ORDER BY createdAt DESC LIMIT 1) nunca roda em teste. 3h.

**IG meio-implementado (README diz "code-complete")**
- **A26 — envio de mensagem Instagram não-implementado (lança `INTERNAL`)**: `src/modules/messages/service.ts:162-165` (`"Instagram token resolution not yet implemented (task #20)"`) depois de já rodar queries de binding. `channel=instagram` → 500. 8h.
- **A27 — tokens IG nunca são renovados** → expiram silenciosamente em 60d: `src/workers/token-refresh.ts:11` ("V1: apenas WABA"); sem branch IG em lugar nenhum. 6h.

**Doc/estado**
- **A28 — README afirma falsamente "nenhum consumidor em produção" e "Pré go-live"** — mas prod está vivo (2026-05-27) servindo o `bevox-backend` provisionado (2026-05-31). `README.md:7,18` vs `git b2cb5e2`, `CLAUDE.md §11`, memória. Direciona resposta-a-incidente errada. 1h.

### MÉDIO (degrada qualidade)

> 71 achados; agrupados por tema, com evidência. (Inclui rebaixados pós-verificação.)

**Invariantes parciais**
- I7 — templates são **hard-deleted** no request path (`db.delete`) e a tabela não tem `deleted_at`: `src/modules/templates/repository.ts:84-100` ← `routes.ts` DELETE. Contradiz invariante §5.7.
- I7 — `deleted_at` existe **só** em `tenants`; demais entidades usam `disconnected_at` ad-hoc ou nada. `db/schema/tenancy.ts:36` vs `bindings.ts:54,135`.
- I2 — `Idempotency-Key` é **opt-in por rota** (`requireIdempotency()`), não global: um esquecimento desliga silenciosamente. `src/plugins/idempotency.ts:121`.
- I2 — rotas de mutação **admin** (create app, rotate key, deactivate) **não exigem** `Idempotency-Key`. `src/modules/apps/routes.ts:24,35,44`.
- I8 — audit log é fire-and-forget (`void logAudit`, não-transacional, onResponse só em 2xx): falhas engolidas → mutação sem registro de auditoria. `src/plugins/audit-log.ts:50-53,82`.

**Tenancy (defesa em profundidade)**
- Tabelas scoped por indireção (`phone_numbers`, `templates`, `waba_tokens`, `ig_tokens`, `webhook_deliveries`) não têm `app_id`/`tenant_id`; repos filtram só por FK do pai. `db/schema/bindings.ts:93-114` etc.
- worker `webhook-delivery` carrega subscription e inbound_event independentes, **sem checar match app/tenant**. `src/workers/webhook-delivery.ts:105,124,142`.
- `findWabaByTenantAndMetaId` filtra por `tenant_id` sem `app_id`. `src/modules/wabas/repository.ts:96-106`.
- endpoints `/v1/events*` expõem payloads inbound de **todos** os tenants a um token app-scoped quando `X-Tenant-Id` é omitido. `src/modules/events/repository.ts:14-56`.
- cobertura de regressão de isolamento de tenant quase-zero (1 teste só). `tests/unit/modules/wabas/routes.test.ts:275`.
- mecanismo da invariante 3 (ALS scope) nunca populado (`RequestContext.appId/tenantId` sempre `undefined`). `src/lib/request-context.ts:43`.

**Contrato / OpenAPI / drift**
- `webhook.dead_letter` nunca emitido na exaustão (MA-005/§10.2 exigem). TODO em `src/workers/webhook-delivery.ts:188`. *(corroborado 3×)*
- métricas Prometheus MA-007 renomeadas (`bevox_meta_api_*` com labels diferentes) **e** a maioria definida-mas-nunca-observada. `src/lib/metrics.ts`.
- create-subscription devolve `signing_secret`, OpenAPI diz `secret`. `src/modules/webhooks/schemas.ts:35`.
- `delivery_mode` aceita só `push`; OpenAPI anuncia enum `[push, sse, polling]`. `src/modules/webhooks/schemas.ts:10`.
- `POST /v1/events/ack` devolve 200 `{acked,requested}` + exige Idempotency-Key; spec diz 204 sem body. `src/modules/events/routes.ts:184-197`.
- resposta sync `POST /v1/messages` diverge de `MessageSendResult` (adiciona `channel`, omite `sent_at`, enum estreito). `src/modules/messages/schemas.ts:83-89`.
- ConsumerApp usa `current_public_key_id`/`key_id`; OpenAPI diz `current_kid`. `src/modules/apps/service.ts:30-39`.
- rate-limit de 3 camadas (PRD §5.11): só a camada app roda; tenant/WABA-tier nunca são fiados nos hot paths. `src/plugins/rate-limit-buckets.ts:84-92`.
- SSE não implementa o cap de backpressure de 10K eventos/conexão (MA-005); `write()` ignorado → consumidor lento bufferiza sem limite. `src/modules/events/routes.ts:64-96`.
- `/webhooks/meta` (GET+POST) implementado mas **ausente de todo OpenAPI** (repo+canon). `src/modules/inbound/routes.ts:58,78`. *(corroborado: drift + endpoint + consistency)*
- callback OAuth WABA: spec tenant-scoped (`/v1/tenants/{id}/wabas/connect/callback`) vs código flat (`/v1/oauth/waba/callback`). `src/modules/wabas/routes.ts:36`.
- repo OpenAPI v1.0.0 atrás do canon v1.1.0 por 1 op: `GET /v1/media/{media_key}` (código implementa). `src/modules/media/routes.ts:19`.
- `POST /admin/apps/{id}/deactivate` e `GET /metrics` implementados mas não-declarados (superfície admin/health assimétrica).
- PRD §5.4 `two-step PIN` (`POST .../phone-numbers/:id/two-step`) especificado, não-implementado, ausente dos specs.
- handshake de verificação de URL de subscription usa `verification_challenge`/`challenge` — convenção de código sem âncora em PRD/OpenAPI. `src/modules/webhooks/service.ts:67,73-74`.

**Webhook / inbound (robustez)**
- processamento inbound 100% síncrono (sem ack <500ms + handoff BullMQ) contradiz MA-005/regra. `src/modules/inbound/routes.ts:88-93`. *(verificador rebaixou: aceitável p/ volume de piloto; o risco real está em A5/C3)*
- batch de várias mensagens WhatsApp num `change` é deduplicado/keyed só por `messages[0].id` → re-entrega com nova 1ª mensagem dropa o resto. `src/modules/inbound/service.ts:128-138`.
- `/webhooks/meta` sem rate-limit e sem IP-allowlist (PRD §7 linha 720 exige ambos) → vetor de flood não-autenticado. `src/modules/inbound/routes.ts:57-94`.
- `bodyLimit:1MB` global aplica a `/webhooks/meta`; batch Meta grande → 413 → Meta retenta o mesmo payload até expirar (perda). `src/bootstrap/server.ts:87-91`.
- sem isolamento de erro por-`change`: um `change` que falha 500a o batch inteiro e a Meta retenta tudo (interage mal com dedup-pré-persist). `src/modules/inbound/service.ts:196-231`.
- callback async usa header `x-bevox-signature-256: sha256=<hex>` (sem timestamp), divergindo do esquema canônico `t=,v1=` usado no resto. `src/workers/outbound-dispatcher.ts:44-48`.
- **SSRF/token-leak**: `media-download` manda o Bearer da WABA para qualquer URL absoluta que a Meta retornar, sem allowlist de host/scheme. `src/integration/meta-client.ts:478-523`.

**Secrets / Sentry**
- `Sentry.captureException` encaminha `extra` não-redacted; sem `beforeSend`. `src/lib/telemetry.ts:107-110,31-38`.
- headers sensíveis (`x-hub-signature-256`, `x-admin-token`, `x-meta-token`) ausentes das paths de redact. `src/bootstrap/server.ts:55-57`.
- teste unit de redaction a nível-logger ausente (item do checklist da regra). `tests/unit/lib/redact.test.ts`.
- blacklist de chaves do `redact()` larga demais (redige qualquer chave `body`/`text`/`content`) pode corromper payloads de audit. `src/lib/logger.ts:104-117`.
- **[NET-NEW — orquestrador]** `ADMIN_API_KEY: z.string().min(8)` — o schema permite chave de 8 chars; o checklist canônico exige ≥32 e o admin JWT é **HS256 assinado com essa chave**. Piso de validação fraco para a credencial que minta JWTs admin (provisiona consumer-apps). `src/config/env.ts:78`. ~1h.

**Testes**
- `webhooks/secret-resolver.ts` (decrypt do segredo HMAC outbound) 0% coberto. `:14-26`.
- camada repository inteira (9 arquivos) 0% coberta, sem harness Postgres em CI.
- E2E é só scaffolding de boot (testcontainers + `SELECT 1`), não exercita `src/` nem a sandbox Meta. `tests/e2e/smoke.e2e.test.ts`. **(O critério de prontidão v1.0 do PRD §16 exige suite E2E OAuth/sync/async/webhook/replay/token-rotation — não atendido.)**
- contagem de testes/coverage do README é computada no Node errado; Node 20 nem carrega 18/34 suites.

**LGPD / compliance**
- imutabilidade do audit-log (sem UPDATE/DELETE) prometida mas **não aplicada no DB** (só comentário TODO). `db/schema/audit.ts:7-9`.
- disclosure de sub-processador incompleta: store de mídia S3/MinIO ausente da lista RoPa OT-19 (MA-012:159). **Dep: MA-014 gate #1.**
- `MEDIA_S3_REGION` default `us-east-1` sem pin de região BR → risco de transferência internacional não-declarada. `src/config/env.ts:95`. **Dep: MA-014 gate #3.**

**Bugs / dívida**
- dedup inbound bypassado para todos os eventos não-message e para **todo** Instagram. `src/modules/inbound/service.ts:128-138,201-212`.
- replay de dead-letter entrega `event_type="replay"` sintético em vez do tipo original. `src/modules/webhooks/service.ts:188-196`.
- async outbound cria `OutboundJob` duplicado por design ("V1 simplificação"). `src/workers/outbound-dispatcher.ts:76-100`.
- cascade de erasure DSR é código morto — `listMediaKeys()` sem callers. `src/lib/media-storage.ts:86-102`.

**Go-live / infra**
- dois paradigmas de prod não-reconciliados: piloto = compose+SOPS+hetzner-mcp num host; meta-api = k3s+`kubectl create secret`+WIF noutro → meta-api fora do desired-state SoT do piloto.
- imagens prod+migrator pinadas a tag mutável `:5706afe` (3 commits atrás do HEAD, **antes** do commit do openapi.yaml), `imagePullPolicy:Never` — viola digest-pinning do checklist §5 e arrisca rodar código pré-openapi.
- scrape Prometheus bloqueado a menos que um label `monitoring` ad-hoc/não-manifestado seja setado. `k8s/networkpolicy.yaml:23-31`.
- sem HA na camada de dados (CNPG `instances:1`, Redis `replicas:1`, ambos num cax11 single-node) — piloto precisa aceitar explicitamente RPO/RTO + perda de jobs in-flight do Redis.
- staging (`docker-compose.prod.yml`) usa `postgres:16-alpine` sem backup/WAL-archiving e sem media worker — não-equivalente ao checklist §2.

### BAIXO (higiene)

**Pontos sólidos confirmados (não-achados — registrados p/ balanço):** I1 UUIDv7 em todas as PKs (`src/lib/uuid.ts`, `db/schema/_shared.ts:73`); I9 HMAC inbound+outbound satisfeito (`inbound/routes.ts:24-42`, outbound Stripe-style `t=,v1=`); I5 consumer JWT RS256+kid+exp-iat≤max (`auth-jwt-consumer.ts:93-164`); I11 `db.transaction()` em escritas múltiplas; `env.ts` falha-rápido robusto em prod; verificação de URL de subscription (§10.4) implementada (`webhooks/service.ts:57-91`); retenção 90d/30d/24h aplicada pelo cleanup.

**Higiene / doc:**
- `mapMetaError` encaminha `error.message` cru da Meta para `AppError` (regra pede sanitização de echoes). `src/integration/meta-client.ts:166-179`.
- verify-token (GET) compara com `===` (não constant-time). `src/modules/inbound/routes.ts:66-72`. (Baixo risco — token de baixa sensibilidade.)
- inbound persiste/encaminha PII de contato (wa_id, profile.name, phone) — `redactSecrets` mantém PII **por design** (consumidor precisa do conteúdo). Confirmar que é decisão consciente sob MA-012. `src/modules/inbound/service.ts:260`.
- repositories lançam `throw new Error(string)` cru (viola §5.3 — usar `AppError`). `messages/repository.ts:44,103`, `apps/repository.ts:43,52,90`, etc.
- provider AWS KMS é stub que lança em runtime. `src/integration/kms-client.ts:219-221`.
- artefatos `.js`/`.js.map` compilados (gitignored) presentes em `db/schema/` num runtime tsx-only.
- `pnpm start` morto em prod (`node dist/index.js`, mas a imagem runtime só tem `src/`+tsx). `package.json:15`.
- Service `api` definido 2× (`k8s/service.yaml` + inline em `deployment-api.yaml:98-113`).
- tunnel-id + tag de imagem do cloudflared hardcoded (`k8s/cloudflared.yaml:28,75`).
- gotchas do go-live-plan §1 estão **estáveis/desatualizados** vs o rewrite de manifests de 2026-05-28 (#4 workers-via-dist e #5 emptyDir **já corrigidos**; line-numbers do plano errados) — texto engana o operador.
- callback OAuth WABA flat (`/v1/oauth/waba/callback`) é provavelmente o design correto (tenant em state opaco) — o spec é que está errado.
- **[NET-NEW — orquestrador]** `docs/architecture/error-mapping.md` referenciado pelo PRD §9.4 ("a criar") nunca foi criado; o mapeamento Meta→canônico vive só em `mapMetaError()`.

**Inconsistências de documentação (consistency-critic):**
- erro RFC 7807 em `.claude/rules/meta-api-modules.md:41-45` contradiz o formato canônico `{error:{code,message,details,request_id}}` (PRD §9.4, CLAUDE.md, ambos os specs) — **a regra é o outlier, está errada**.
- 3-way de path de webhook inbound: código `/webhooks/meta` vs regra `/webhooks/whatsapp/{opaque_id}` vs checklist `/webhooks/meta/{whatsapp,instagram}`.
- regra `meta-api-webhooks.md` diverge do código em nome de fila (`bevox.whatsapp.events`) e chave de dedup.
- regras citam ADRs Bevox-pai (ADR-011, ADR-023) como se governassem a meta-api, contra o esquema MA-NNN.
- CLAUDE.md §3 "Node 20+ LTS" contradiz `package.json`/`.nvmrc`/Dockerfile (Node 22) — e o código não carrega no Node 20.
- link do README para `consumer-integration-guide-v1.md` quebrado (existe só no canon); `docs/go-live-checklist.md` idem; `docs/adr/` só tem README (índice omite MA-013/014).
- README "249 testes" desatualizado (real: 290); fragilidade Node-version não mencionada.
- framing de identidade diverge: README "produto autônomo, não específico de Bevox" vs CLAUDE.md "serviço interno, exclusivo da família Bevox, não comercial".

---

## Itens-de-fechamento ordenados por valor/esforço (top 10)

| # | Item | Esforço | Destrava |
|---|------|---------|----------|
| 1 | **Deployar o worker `media-download`** (5º Deployment + serviço compose) — C2 | 1.5h | Mídia inbound (perda de dados funcional) |
| 2 | **Serializers `req`/`err` canônicos** (sem query-string; scrub de `details`/stack) — C1+A1+A2 | ~5h | 1 CRÍTICO + 3 ALTO de vazamento de segredo de uma vez |
| 3 | **Alinhar os 3 botões de retry + `dead_letter` na última tentativa + backoff §10.2** — C3+A6 | ~7h | Perda permanente de eventos + replay funcional + visibilidade |
| 4 | **Corrigir ordem dedup-antes-de-persist** (persistir antes do SETNX, ou tornar o pipeline idempotente) — A5 | ~3h | Drop silencioso de inbound em erro transitório |
| 5 | **Resolver convenção de path de webhook + corrigir runbook/checklist `/webhooks/meta`** — A7 | ~2h | 404 de **todo** o inbound no go-live |
| 6 | **Dedup IG + keying de batch multi-mensagem** — A8 + MÉDIO | ~4h | Eventos IG duplicados / mensagens WA perdidas |
| 7 | **Testes de `outbound-dispatcher` + `token-resolver` + `meta-client`** — C4+A23+A25 | ~12h | Valida envio assíncrono + MA-008 (caminhos consumer-facing) |
| 8 | **Acender observabilidade** (emitir métricas; scrape de worker; OTEL endpoint; `/readyz` KMS) — A16-A19 | ~12h | Resposta-a-incidente cega vira visível no piloto |
| 9 | **Sync de contrato** (`{items}`→`{data}` ou editar canon; 409→422; `getMessage`; callbacks IG/WABA; `/webhooks/meta`+media no spec; repo→canon v1.1.0) — A11-A14 + drift | ~10h | Consumidor gerado a partir do spec deixa de quebrar |
| 10 | **Carimbar MA-012 + registrar meta-api em topology/registries** — C5+A20 | jurídico + ~4h | Bloqueio legal de prod + visibilidade de SoT |

> Mínimo defensável para o piloto: itens 1–6 + 10 (≈ 25h eng + jurídico). GA exige também 7–9 e o grosso do MÉDIO.

---

## Dependências cruzadas

- **MA-012 (LGPD)** → advogado externo + RoPa OT-19 em `bevox-compliance-lgpd-prd-v1.md` (canon). Bloqueia C5, A15 (DSR), e os MÉDIOs de sub-processador/região. **Não-código.**
- **Edits no canon (`bevox-knowledge`, SoT por ADR-005)** → A20 (registries + runtime-topology), A11/A14 e cluster de drift (OpenAPI canon v1.1.0), A7 (checklist + runbook), reconciliação da regra de path de webhook. Exigem PR explícito no hub (CLAUDE.md §8 "Parar — PR").
- **`scripts/sync-contracts.sh`** (hub) → re-sincronizar repo OpenAPI v1.0.0 ↔ canon v1.1.0 após decisões de contrato.
- **bevox-backend (consumidor do piloto)** → contrato de envelope `{data}` vs `{items}` (A13), 409 vs 422 (A12), paths de callback OAuth, headers de entrega documentados, e (se adotado) claim de tenant no JWT. Mudanças de contrato precisam de coordenação com o consumidor já provisionado.
- **MA-014 (mídia inbound)** → gates de DPO/região/sub-processador dos MÉDIOs de LGPD; e A26/A27 dependem do roadmap IG (task #20).
- **Meta App Review (externo)** → aprovação do app + registro da URL de webhook são pré-condições de go-live não-verificáveis pelo repo (checklist §0).
- **Reconciliação de invariante** → A9 (tenant-scope) e I7 (soft-delete) podem exigir editar CLAUDE.md §5.3/§5.7 e/ou MA-003/ADR-021 (decidir entre "plugin auto-injetor" prometido vs scoping manual real).

---

## Notas de método

**Fontes canônicas.** `$BEVOX_KNOWLEDGE_PATH` está **não-setado** neste shell; a SoT foi lida em `$BEVOX_KNOWLEDGE_PATH` (PRD `10_prd/bevox-meta-api/2026-05-08-…`, ADRs `30_adr/bevox-meta-api/` + `_shared/`, OpenAPI canon `20_architecture/bevox-meta-api/openapi.yaml` v1.1.0, consumer-guide, go-live-checklist `40_roadmap/…`, `runtime-topology.md`). O repo `docs/adr/` só tem README — os corpos das ADRs vivem no canon.

**Ground-truth executado** (não só leitura): suite de testes rodada nas duas versões de Node. **Node 20.18.1 (que CLAUDE.md §3 chama de suportado) falha 18/34 suites** (`undici@8` exige `webidl.util.markAsUncloneable` do Node 22). **Node 22.22.2: 290 testes passam** (`fnm exec --using=v22.22.2 pnpm test`), coverage v8 = **64.15% stmts / 54.6% branches / 56.39% funcs / 67.2% lines**. Diff char-level dos dois PRDs e dos dois OpenAPI; verificação de existência de docs referenciados; leitura direta dos hot paths (inbound webhook, `env.ts`, `token-resolver`, manifests k8s, `cleanup`).

**Orquestração multi-agente.** Workflow de 3 fases (run `wf_66ef060d-f5c`, 68 agentes, ~24 min, 4.26M tokens): (1) 4 extratores de contexto (canon-spec, ADR-reqs, route↔contract matrix, infra-readiness); (2) **13 auditores em paralelo** — incluindo os 4 agentes especializados do próprio repo (`invariants-auditor`, `secrets-redaction-auditor`, `tenant-scope-auditor`, `webhook-hmac-auditor`) + 9 dimensionais (cobertura de endpoint, divergência-de-canon, testes, bugs/dívida, LGPD, drift, go-live, pilot-risk, consistency-critic); (3) **verificação adversarial de todos os 51 achados CRÍTICO/HIGH** (cada verificador instruído a *refutar*). Resultado da verificação: **33 CONFIRMED, 17 DOWNGRADED, 1 REFUTED**. O artefato bruto (143 achados estruturados + verdicts) está em `wf_66ef060d-f5c` (transcript da sessão).

**O achado refutado** (registrado para honestidade): "HMAC de webhook usa um `app_secret` global, não por-app" foi **REFUTADO** — a premissa de que cada consumer-app teria seu próprio Meta App/secret está errada; o design é um único Meta App Bevox com N WABAs via Embedded Signup, então um `META_WEBHOOK_APP_SECRET` global está correto. Vários achados de "secrets" e "drift" foram rebaixados quando o vetor se mostrou latente (não-ativo) ou quando o design do código era na verdade o correto e o spec/regra é que estavam errados.

**Severidade.** CRÍTICO = bloqueia o piloto (meta-api servir um consumidor real + webhooks Meta reais com segurança); ALTO = bloqueia GA; MÉDIO = degrada qualidade; BAIXO = higiene. Onde o auditor e o verificador discordaram, prevaleceu a severidade ajustada do verificador.

**Limitações.** (1) Análise estática + testes unit; **nenhum teste de integração com Postgres/Redis vivo** foi rodado, então defeitos só observáveis com DB real (transações, queries de repository) são inferidos da leitura. (2) A reachability real da Meta (sandbox/prod) não foi exercida. (3) Coverage reflete unit-only; a camada repository aparece 0% por ser mockada — parte disso seria coberta por integração. (4) Esforços são estimativas de engenharia, não compromissos. (5) Edits no canon (`bevox-knowledge`) e no estado de prod estão fora do escopo desta auditoria read-only.
