# Gap Analysis — bevox-meta-api — 2026-06-04

> Auditoria de prontidão (read-only) contra a documentação canônica (PRD V1, ADRs
> MA-001..MA-008/MA-012..MA-016, ADRs `_shared` ADR-005/012/017/019/020/021, OpenAPI
> repo+canon, `runtime-topology`, go-live plan) **focada no delta** desde a auditoria
> `runtime-gap-audit-2026-06-02.md`. Gerada autonomamente por Claude Code (effort max,
> multi-agente: 16 auditores dimensionais + verificação adversarial; 5 dos auditores são
> os agentes especializados do próprio repo). HEAD auditado: **`d8aa30b`** (main).
> Nenhum código de produto foi alterado.

## Resumo executivo

Entre 2026-06-02 e 2026-06-04 houve uma **campanha de remediação intensa e em larga medida
bem-sucedida** (~25 PRs em `main`, +5.671 linhas de teste): **4 dos 5 CRÍTICOS foram fechados
de verdade** (C1 redação de OAuth, C2 worker de mídia deployado, C3 dead-letter alcançável +
backoff §10.2, C4 cobertura do dispatcher) e **~16 ALTOS** (A3, A4, A6, A11–A14, A17–A19, A25 +
confirmação de MA-008). Verificação independente (leitura direta dos hot paths) corrobora cada
um desses fechamentos.

Mas o delta tem três sinais ruins que **não existiam na auditoria anterior**:

1. **A `main` está com a suíte VERMELHA e o lint VERMELHO — e o CI não roda nenhum dos dois.**
   3 testes falham (2 em `kms-client.test.ts`, 1 em `server.test.ts`), regressão direta do rework
   A19-v2 (`cfca74d`) que mudou o `healthCheck` do KMS para encrypt+decrypt sem atualizar os testes;
   o lint quebra em `src/lib/queues.ts:174`. O **único** workflow de CI (`build-image.yml`) só
   constrói/publica imagem — **nenhum gate de `test`/`lint`/`typecheck`**, e nem dispara em PR. Foi
   exatamente por isso que os reds (e a regressão do gate de produção `/readyz`) entraram em `main`
   e na imagem de prod sem detecção.
2. **Dois "fixes" não aterrissaram de verdade.** O dedup de Instagram (A8) corrigiu a função pura
   (8/8 testes verdes) mas o **call-site passa `value=undefined`**, então o dedup IG continua
   desligado em produção. O `serializeErrorRedacted` (A2) existe e é correto, mas **não está fiado**
   como serializer `err` — os 5 workers logam stack cru (vetor real: `exchangeLongLivedToken` põe
   token Meta + `client_secret` na query string).
3. **A nova superfície entrou em prod adiantando-se à governança.** MA-015 (registro de webhook
   por-WABA) está em `main`/prod com o ADR ainda `Proposta` e os critérios de "Aceita" abertos;
   sem de-subscribe no disconnect (subscriptions órfãs), sem log/métrica, verificado só em unit.

**Riscos para o piloto** (meta-api servir consumidor real + webhooks Meta reais): restam **2
bloqueadores CRÍTICOS** — um jurídico (**C5/MA-012** ainda `Proposta`) e um de código que a
campanha nunca tocou (**A5**: o dedup `SETNX` roda antes de persistir o evento; como a coluna
`meta_event_id` tem índice **não-único**, o SETNX é o único dedup, então um blip de Postgres
— e a camada de dados é **single-instance sem HA** — converte um erro recuperável em **perda
silenciosa e permanente** de mensagem inbound do cliente final). Verificação adversarial refutou
3 hipóteses alternativas e manteve A5 em CRÍTICO.

**Para GA**, o grosso é dívida de qualidade/contrato que não bloqueia o piloto: observabilidade
parcialmente cega (latência Meta e outcomes de refresh de token nunca emitidos → 3 painéis e 2
alertas mortos), drift de contrato bidirecional (repo OpenAPI 1.0.0 vs canon 1.2.0, 3 rotas vivas
fora de qualquer spec), IG meio-implementado (envio lança `INTERNAL`, token nunca renova), rate-limit
de 3 camadas com só 1 ativa, e zero tratamento de 429/quota da Meta.

**Números (workflow):** 162 achados brutos (com corroboração cross-dimensão) → 16 dimensões. Status:
**43 FIXED, 8 PARTIAL, 26 SURVIVES, 6 REGRESSED, 77 NEW, 2 N/A.** Severidade: 9 CRÍTICO (7 entradas
FIXED — C1/C2/C3×2/C4×2 —, 2 SURVIVES), 56 ALTO, 51 MÉDIO, 46 BAIXO. Após dedup por `id` e aplicação
dos 20 vereditos adversariais (**15 CONFIRMED, 5 DOWNGRADED, 0 REFUTED**), o conjunto acionável é
**~2 CRÍTICO + ~22 ALTO + ~30 MÉDIO** únicos. Caminho mínimo defensável p/ piloto: A5 + gate de CI +
3 reds + A2/A8 (~12h eng) **fora** de C5 (jurídico).

---

## Achados por severidade

> Convenção: `arquivo:linha` é evidência verificada (estática + execução de testes/typecheck/lint no
> HEAD; hot paths lidos diretamente pelo orquestrador). `status` ∈ FIXED (delta fechado) / PARTIAL
> (claimed mas incompleto) / SURVIVES (aberto desde 06-02) / NEW / REGRESSED. Achados duplicados entre
> dimensões foram fundidos; severidade reflete o veredito adversarial quando houve ajuste.

### CRÍTICO (bloqueia piloto)

**C5 — MA-012 (postura LGPD "sub-processador interno") ainda `Status: Proposta`** · SURVIVES · jurídico
- Ev.: `bevox-knowledge/30_adr/bevox-meta-api/MA-012-…:3` (Proposta), `:7` (Bloqueia go-live), `:179-182`
  (4 critérios de "Aceita" todos abertos). PRD §12.1 ainda diz "Acredita-se ser defensável". README.md:18,86.
- Impacto: todo PII tratado (conteúdo de mensagem, números, IG handles, binários de mídia) sob postura
  unilateral sem parecer externo. Nuance: README posiciona `bevox-backend` como coberto por MSA preexistente,
  o que reduz o risco operacional — mas a **RoPa OT-19** que documentaria a meta-api como componente do
  tratamento mestre **nunca foi publicada**, então a "cobertura por MSA" não está registrada na RoPa do
  controlador. A campanha não tocou MA-012.
- Esforço: ~24h (jurídico). **Engenharia não fecha** — exige parecer externo + OT-19 na RoPa (canon, fora deste repo).

**A5 — dedup `SETNX` roda ANTES de persistir o `InboundEvent` → blip de DB perde a mensagem para sempre, silenciosamente** · SURVIVES · CONFIRMED CRÍTICO
- Ev.: `src/modules/inbound/service.ts:276` (`isDuplicate`/`SET NX EX 24h`, def. `:175-185`) executa antes de
  `insertInboundEvent` em `:302`. **Não há `del()` compensatório** (únicas refs a `DEDUPE_PREFIX`: `:104`, `:178`).
  A coluna `meta_event_id` tem índice **NÃO-único**: `db/schema/operations.ts:98` (`index(...)`, não `uniqueIndex`),
  confirmado em `db/migrations/meta/0000_snapshot.json:1400` (`"isUnique": false`) → o SETNX é o **único** dedup.
  Erro de insert (sem try/catch em `repository.ts:24-37`) → 500 (`error-handler.ts:76-87,113-114`) → Meta retenta
  → `isDuplicate('M1')=true` → conta `outcome:"deduplicated"` → 200 OK → evento nunca persistido/entregue.
- Impacto: perda silenciosa de mensagem/status inbound a cada instabilidade de Postgres (failover CNPG, deadlock,
  pool esgotado). Agrava-se com a **camada de dados single-instance sem HA** (ver NEW-infra-4) — failover/restart é
  realista no piloto. Verificação adversarial refutou 3 hipóteses (unique-constraint, `del()` no catch, erro engolido).
- Recomendação: persistir primeiro com `uniqueIndex` em `meta_event_id` (o INSERT vira o dedup atômico) **ou** só
  confirmar a chave após o insert commitar / `del()` no catch. Esforço: ~4h.

> **Delta CRÍTICO:** 4 dos 5 CRÍTICOS de 06-02 fechados (C1, C2, C3, C4 — ver §Delta). Restam C5 (jurídico,
> inalterado) e A5 (código, **nunca endereçado pela campanha** — era a "task #4" não-feita).

### ALTO (bloqueia GA, não bloqueia piloto)

**Segredos / logging**
- **A2 — `serializeErrorRedacted` existe mas NÃO está fiado como serializer `err`** · PARTIAL · CONFIRMED ALTO.
  `src/lib/redact.ts:116-157` (helper correto, testado) é usado só em `error-handler.ts:127` (path HTTP).
  `buildLoggerOptions()` (`src/lib/logger.ts:64-94`) não tem bloco `serializers`; `server.ts:74-79` só define `req`.
  Os 5 workers logam `err` cru (`token-refresh.ts:146,168`; `outbound-dispatcher.ts:173,178`; `webhook-delivery.ts:250`;
  `media-download.ts:91,94`; `cleanup.ts:68`). **Vetor real**: `exchangeLongLivedToken` (`meta-client.ts:296-300`)
  põe token Meta + `client_secret` na query string (`metaGet:230-232`); no catch retryable o erro undici (com a URL)
  vira `cause` sem sanitização (`errors.ts:65,112-117`) e é logado cru no `token-refresh` (a cada 6h). Fix: `serializers:
  { err: serializeErrorRedacted }` em `buildLoggerOptions` + `server.ts`. ~1h.
- **A8 — dedup de Instagram corrigido na função, mas DESLIGADO em produção (call-site)** · PARTIAL · ALTO efetivo.
  `extractMetaEventId` (`service.ts:137-173`) agora cobre IG (8/8 testes em `extract-meta-event-id-ig.test.ts`), **mas**
  `processMetaWebhook` chama o caminho IG com `value=undefined`: `service.ts:238` → `extractMetaEventId(undefined,undefined)`
  → `null` (`:140`) → `isDuplicate` nunca roda para IG. Fix de 1 linha (passar `{messaging}` também como 4º arg). A causa
  é não haver teste exercitando `processMetaWebhook` com payload IG (ver NEW-ig-1). ~1h. *(Corrige a marcação "FIXED" do commit.)*

**Webhook / inbound**
- **A5** — ver CRÍTICO (elevado no contexto piloto).
- **A10 — resolução de tenant inbound por `meta_waba_id`/`meta_ig_id` sem escopo app/tenant** · SURVIVES · CONFIRMED ALTO.
  `wabas/repository.ts:84-91` e `ig/repository.ts:60-67` filtram só por id Meta + `isNull(disconnectedAt)`, `.limit(1)`,
  sem `app_id`/`tenant_id`; unicidade do schema é `(tenant_id, meta_waba_id)` (`bindings.ts:56-60`), não global; HMAC é
  global. `resolveTenant` (`service.ts:284`) pega o 1º match → persiste com app/tenant possivelmente errado → entrega ao
  tenant errado (payload preserva conteúdo por design). **Ampliado pela campanha**: o fix A8 ligou o caminho IG ao mesmo
  `resolveTenant` não-escopado. Não explorável no piloto (Meta não permite a mesma WABA em 2 conexões), mas viola a
  invariante §4.3. ~5h.
- **A_inbound_ratelimit — `/webhooks/meta` sem rate-limit e sem IP-allowlist** · SURVIVES · ALTO. `inbound/routes.ts:81,101`
  registram sem `requireRateLimit` (o plugin exige `req.auth`, que a rota pública não tem); sem filtro de CIDR Meta; `trustProxy:true`
  (`server.ts:103`) sem allowlist → XFF spoofável. PRD §7.5 exige ambos. A4 mitigou o custo por-request, não o flood. ~6h.

**Tenancy**
- **A9 — o plugin `tenant-scope` continua INEXISTENTE; scoping 100% manual e `tenant_id` não vem do JWT** · SURVIVES · CONFIRMED ALTO.
  Não existe `src/plugins/tenant-scope.ts`; `server.ts:147` ("Plugins futuros … farão `patchContext()`"); `patchContext`
  (`request-context.ts:43`) nunca é chamado; `auth-jwt-consumer.ts:168-172` popula `req.auth` **sem** `tenantId` (vem do header
  `X-Tenant-Id`, forjável). **Mitigação real**: `app_id` vem sempre do `iss` assinado e toda query tenant-scoped faz `and(eq(appId),…)`
  antes de tocar sub-tabelas — então forjar `X-Tenant-Id` retorna NOT_FOUND (há testes de IDOR). Não explorável hoje, mas a invariante
  de segurança central é mantida por **disciplina**, não por enforcement, e CLAUDE.md §4.3/MA-003 **descrevem um injetor que não existe**.
  Reconciliar doc↔código ou implementar plugin + `scoped()`. ~8-16h.

**Contrato / OpenAPI** *(drift bidirecional; o spec do repo é o que o consumidor lê)*
- **NEW-CG-11 — repo OpenAPI (1.0.0) e canon (1.2.0) forkaram em DUAS direções** · NEW · CONFIRMED ALTO. `/v1/media/{media_key}`
  (implementado em `media/routes.ts:20`) só existe no **canon**; o `ReadinessReport` correto (`{ok,checks:{postgres,redis,kms}}`) e
  `healthz.build` só existem no **repo**. Nenhum spec é superset do outro; sem tooling de sync no repo. ~2h + PR de canon.
- **NEW-CG-1 — callback WABA: código serve `/v1/oauth/waba/callback`, spec declara `/v1/tenants/{id}/wabas/connect/callback`** · NEW · CONFIRMED ALTO.
  Espelho do A14 (corrigido só para IG). `wabas/routes.ts:36` vs `openapi.yaml:190` (repo) e canon `:192`; tipos gerados (`src/types/api.ts:65`)
  seguem o spec errado. Onboarding só funciona porque a URL real vem de `OAUTH_CALLBACK_BASE_URL`. ~1h.
- **A16 (sub-métricas) — `metaRequestDuration` e `tokenRefreshTotal` definidos mas NUNCA emitidos** · SURVIVES · CONFIRMED ALTO.
  `metrics.ts:42` (Histogram latência Meta) sem nenhum `.observe()` — `meta-client.ts` nem importa `@/lib/metrics`; `metaGet:230`/`metaPost:246`
  não instrumentam. `metrics.ts:116` (`token_refresh_total{channel,outcome}`) sem `.inc()` — `token-refresh.ts` calcula `refreshed/failed/disconnected`
  mas só emite `workerJobsTotal`. Mortos: alertas `MetaApiMetaLatencyP99`, `MetaApiTokenDisconnected` e 3 painéis Grafana; também cega runbooks
  de incidente/DR. ~5h.
- **A23 — `meta-client`: 2 de 14 métodos testados contra a impl real; `mapMetaError` 0 testes** · PARTIAL · CONFIRMED ALTO.
  Só `getMediaMetadata`+`downloadMedia`+`isAllowedMetaMediaUrl` (SSRF, novo) exercitam `UndiciMetaOAuthClient`; o resto é `vi.fn()` no nível de rota.
  `mapMetaError` (`:213`) sem teste. Hot paths do piloto (`sendWhatsAppMessage`, `exchangeCode`, `discoverWaba`, `createMessageTemplate`) sem teste de parsing/erro real. ~6h.
- **A24 — `wabas/repository`: 4 funções transacionais sem harness Postgres** · SURVIVES · CONFIRMED ALTO. `createWabaConnectionWithToken`,
  `disconnectWaba`, `replaceWabaToken`, `reconnectWaba` (esta última código novo de jun-03) usam `db.transaction` mas testes mockam o repo inteiro; a
  atomicidade/rollback (invariante 11) nunca é exercitada. Harness já existe (`token-resolver.test.ts` usa testcontainers). ~8h.
- **NEW-e2e-1 — suíte E2E ainda é só scaffolding (PING+SELECT 1)** · SURVIVES · CONFIRMED ALTO. `tests/e2e/smoke.e2e.test.ts:32-45`; `setup.ts`
  **não** aplica migrations nem boota o app (apesar de o docstring afirmar). Os 6 fluxos do PRD §16 (OAuth, sync, async, webhook, replay, token-rotation) inexistem. ~24h.

**CI / testes / qualidade** *(causa-raiz dos reds em prod)*
- **NEW-ci-1 — CI não tem gate de `test`/`lint`/`typecheck`** · NEW · CONFIRMED ALTO. Único workflow: `.github/workflows/build-image.yml`
  (só build+push runtime+migrator; dispara só em `push:main`, nunca em PR). Sem husky/lint-staged/outro provider. Por isso suíte vermelha + lint
  vermelho + regressão do `/readyz` entraram na imagem de prod. ~4h.
- **NEW-tests-1 / NEW-health-kms-readyz-1 — suíte VERMELHA: 2 testes de `GcpKmsClient.healthCheck` quebrados pelo rework A19-v2** · REGRESSED · CONFIRMED ALTO.
  `kms-client.test.ts:144-170` mocka só `getKeyRing`; `kms-client.ts:170-191` agora faz `encrypt`+`decrypt`. Execução: `2 failed | 10 passed` (Node 22.22.2).
  `git show cfca74d --stat` **não** inclui o test file. O comportamento de prod do `/readyz` está correto (A19 FIXED no código); os testes ficaram órfãos. ~1h.
- **A8/A2** — ver acima (fixes que não aterrissaram).

**Tokens / IG / LGPD técnica**
- **A26 — envio Instagram lança `INTERNAL` ("token resolution not yet implemented")** · SURVIVES · CONFIRMED ALTO. `messages/service.ts:165-167`
  curto-circuita antes de `sendInstagramMessage` (que existe). Atinge sync **e** async (`outbound-dispatcher.ts:101` reusa `sendMessage`). Não existe
  `ig/token-resolver.ts` (WhatsApp tem). Todo `POST /v1/messages channel=instagram` → 500. ~8h.
- **A27 — tokens Instagram nunca renovados** · SURVIVES · ALTO. `token-refresh.ts:12` ("V1: apenas WABA"); sem `listExpiringIgTokens`/`replaceIgToken`.
  `igTokens` tem `refresh_at`/`expires_at` (`bindings.ts:158-161`) mas nada os lê. Nota: refresh de token IG long-lived usa endpoint distinto (`ig_refresh_token`) —
  reuso cego de `exchangeLongLivedToken` pode não servir. ~6-8h.
- **A15 — `POST /admin/dsr` (DSR/erasure LGPD) não implementado** · SURVIVES · ALTO. Sem endpoint, sem tabela `dsr_requests` (ADR-020), sem cascade por titular;
  primitivas (`media-storage.ts:82-102`) são código morto. PRD §12.4. Dep. MA-012/MA-014. ~8h.
- **A21 — cleanup NÃO aplica retenção de 5 anos de `audit_logs`** · SURVIVES · ALTO. `cleanup.ts` só trata idempotency/inbound(90d)/outbound(30d);
  `audit_logs` cresce sem mecanismo de deleção temporal (não é "dentro da janela", é "mecanismo inexistente"). ~4h.
- **NEW-lgpd-1 — imutabilidade de `audit_logs` é só comentário/TODO, sem REVOKE/RULE/trigger no DB** · NEW · ALTO. `db/schema/audit.ts:8`;
  migration única não tem GRANT/REVOKE/RULE/TRIGGER. A mesma role da app pode UPDATE/DELETE → trilha "imutável" é refutável em auditoria ANPD. Distinto de A21 (retenção). ~4h.
- **A22 — rows de token (`waba_tokens`/`ig_tokens`) superseded+expirado nunca deletadas** · SURVIVES · ALTO (efeito MÉDIO-LGPD). Cleanup ignora as tabelas; ciphertext acumula (blast radius crescente). ~4h.

**Rate-limit / quotas** *(dimensão não coberta como eixo em 06-02; quase tudo NEW vs PRD §5.11/MA-005)*
- **NEW-rlq-1 — camadas tenant e WABA-tier do rate-limit NUNCA rodam** · NEW · ALTO. As 27 chamadas de `requireRateLimit()` são sem opções → `resolveTenantId`/`resolveWabaId`
  undefined → buckets pulados (`rate-limit-buckets.ts:84-92`). Só `DEFAULT_APP_LIMIT` é checado → um tenant esgota a cota Meta dos outros do mesmo app. ~6h.
- **NEW-rlq-2 — `mapMetaError` não trata 429/rate-limit da Meta → vira `META_REJECTED` (422) terminal** · NEW · ALTO. `meta-client.ts:213-228` só ramifica `>=500`;
  429 (codes 4/17/32/80007/130429/613) cai em `metaRejected`. No `outbound-dispatcher.ts:124-125` `META_REJECTED` é **terminal não-retryable** → mensagem perdida quando deveria
  só esperar a janela Meta. Sem leitura de `Retry-After`. A skill `meta-graph-error-map` já documenta a tabela. ~4h.

**Go-live / infra**
- **NEW-infra-2 — imagens em tag mutável (git short SHA) + `imagePullPolicy:Never`** · NEW · ALTO. `deployment-api.yaml:49-50`, `deployment-workers.yaml` (5×). Push pro ghcr.io
  fica **órfão** (k8s nunca puxa; exige `ctr import` manual no host); nada por digest, contra o próprio go-live plan §8. Frágil em restart de pod. ~4h.
- **A20 — meta-api ausente de 4 dos 5 registries canon `_shared`** · PARTIAL · ALTO. `runtime-topology.md:131-153` foi corrigido (canon `0448914`), mas `hardening-registry`,
  `health-registry`, `registry`, `system-map` seguem com zero menção. Edit-de-canon (PR no hub). ~3h.

### MÉDIO (degrada qualidade)

**Invariantes parciais**
- **NEW-INV-I2-admin** — rotas admin de mutação não exigem `Idempotency-Key` (`apps/routes.ts:24,35,44`).
- **NEW-INV-I8-txn** — audit log é fire-and-forget em `onResponse` (`audit-log.ts:45,82` `void logAudit`), não-transacional → mutação sem registro se falhar.
- **I7** — templates fazem **hard-delete** em request path (`templates/repository.ts`); tabela sem `deleted_at` (viola §4.7 soft-delete).

**Tenancy (defesa em profundidade)**
- **NEW-tenant-1** — worker `webhook-delivery` entrega sem checar match `app_id/tenant_id` entre subscription e inbound_event (`webhook-delivery.ts:119-166`).
- **NEW-tenant-2** — `GET /v1/events` e `/v1/events/stream` retornam todos os tenants do app quando `X-Tenant-Id` é omitido (`events/repository.ts:20-21,44-45`).
- **NEW-tenant-3** — `updateJobStatus`/`incrementAttempts` de `outbound_jobs` por id puro, sem predicado `app_id` (`messages/repository.ts:57-85`).
- **NEW-tenant-4** — falta teste de regressão para colisão `meta_waba_id`/`meta_ig_id` (A10) e match app/tenant no worker.

**Segredos / Sentry** *(rebaixados pelo verificador — latentes, sem vetor vivo hoje)*
- **A1 — `error.details` enviado CRU na resposta HTTP** · PARTIAL · DOWNGRADED p/ MÉDIO. `error-handler.ts:62-74` não redige `details` no `reply.send` (só o log). Todos os
  callsites atuais auditados são benignos; `mapMetaError` não ecoa body cru; `cause` não chega ao body. Defesa-em-profundidade ausente. ~1.5h.
- **NEW-secrets-1 — `captureException` repassa `context` como Sentry `extra` e `scrubSentryEvent` não limpa `extra`/`contexts`** · NEW · DOWNGRADED p/ MÉDIO.
  `telemetry.ts:141,166-205`. Zero callers inseguros hoje (`index.ts:39,47` passam literais), mas helper inseguro-por-design. ~1.5h.
- **NEW-secrets-2** — `redact.paths` não cobrem `x-hub-signature-256`, `x-admin-token`, `x-meta-token` (`server.ts:55-71`, `logger.ts:25-62`).
- **NEW-health-kms-readyz-6** — confirmado positivo: erro de KMS **não** vaza segredo/PII na resposta unauth de `/readyz` (cause fica em `Error.cause`).

**Webhook / contrato (drift residual)**
- **NEW-webhook-hmac-1 — callback async usa header/formato NÃO-canônico (`x-bevox-signature-256: sha256=`) e SEM anti-replay** · NEW · DOWNGRADED p/ MÉDIO.
  `outbound-dispatcher.ts:48-52` vs o canônico `t=,v1=` de `webhook-delivery.ts:71-76`. Callback é notificação de status idempotente sob TLS; sub-especificado no PRD §5.8 (não contradiz §10.5). Unificar. ~3h.
- **NEW-webhook-hmac-2** — secret HMAC inbound é GLOBAL único (`META_WEBHOOK_APP_SECRET`), não per-app (`inbound/routes.ts:46`); coerente com MA-015 (app compartilhado) mas conflita com a premissa multi-app (I10).
- **NEW-webhook-hmac-3 / NEW-ma015-3 — MA-015 override por-WABA SEM de-subscribe no `disconnectWaba`** · NEW · MÉDIO. `wabas/service.ts:234-249` só soft-deleta; nunca `DELETE /{waba_id}/subscribed_apps` → subscriptions órfãs no Meta continuam entregando. Follow-up da ADR aberto. ~3h.
- **NEW-CG-6 — criar subscription retorna `signing_secret`, spec diz `secret`** · NEW · DOWNGRADED p/ MÉDIO. `webhooks/service.ts:149` vs `openapi.yaml:628`. A skill consumer usa `signing_secret` (alinhada ao código) → spec é o outlier; não quebra a integração documentada. ~0.5h.
- **NEW-CG-2** — `/webhooks/meta` (GET+POST) ausente de ambos os specs (`inbound/routes.ts:81,101`).
- **NEW-CG-4** — `/admin/apps/{id}/deactivate` ausente de ambos os specs (`apps/routes.ts:44`).
- **NEW-CG-5** — ConsumerApp: spec `current_kid` vs código `current_public_key_id` (`apps/service.ts:30`).
- **NEW-CG-7** — `delivery_mode`: spec enum `[push,sse,polling]`, código só `push` (`webhooks/schemas.ts`).
- **NEW-CG-9** — `POST /v1/events/ack` exige `Idempotency-Key` no código; spec não lista o parâmetro (`events/routes.ts:190`).
- **NEW-CG-10** — `src/types/api.ts` congelado no commit inicial (2026-05-07); YAML mudou até jun → tipos gerados stale.
- **NEW-CG-12** — `/v1/media/{media_key}` implementado mas ausente do spec **do repo** (só no canon).
- **NEW-CG-13** — leva de mudanças de contrato de jun (A11/A12/A14) sem bump de `info.version` nem ADR.
- **NEW-CG-15** — sem teste de regressão de contrato; CI não roda `openapi:check` nem regen de tipos.

**Pilot-risk inbound (robustez)**
- **NEW-inbound-1 — batch multi-mensagem dedupado/persistido por `messages[0].id` apenas** · NEW · ALTO→listado aqui por probabilidade moderada no piloto. N mensagens colapsam em 1 `InboundEvent`; só a 1ª tem mídia baixada (`service.ts:143-144,82-83`). Iterar `messages[]` por change. ~8h.
- **NEW-inbound-2** — processamento inbound 100% síncrono no request (insert+queue.add+publishEvent+listSubscriptions antes do 200) — aceitável p/ volume de piloto, mas contraria MA-005.
- **NEW-inbound-3** — `bodyLimit:1MB` global sem override em `/webhooks/meta`: batch grande → 413 → Meta retenta até expirar (`server.ts:102`).
- **NEW-inbound-4** — sem isolamento de erro por-change: um change defeituoso 500a o batch inteiro (interage mal com A5).

**Observabilidade / infra**
- **NEW-infra-3** — `job-migrate` fixado em tag de migrator 42 commits atrás das tags de runtime (`job-migrate.yaml:48`).
- **NEW-infra-4** — camada de dados single-instance sem HA (CNPG `instances:1`, Redis `replicas:1`) — piloto precisa aceitar RPO/RTO + perda de jobs in-flight; **compõe com A5**.
- **NEW-infra-5** — sem alerta para workers críticos down (out/in/media/tok); só `cleanup` e o agregado da API.
- **queueSize** nunca coletado (nenhum coletor lê job counts do BullMQ) → painel "Queue depth" morto.

**LGPD técnica / IG**
- **NEW-lgpd-2** — residência BR de mídia não pinada: `MEDIA_S3_REGION` default `us-east-1` sem validação de região em prod (`env.ts:103`). Dep. MA-014 gate #3.
- **NEW-lgpd-3** — binários de mídia inbound (S3) sem política de retenção nem erasure (cleanup não os toca).
- **NEW-ig-1** — IG inbound com zero cobertura de integração; fixture `instagramMessageReceived` definida e nunca usada (raiz do A8 quebrado).
- **NEW-ma015-5** — `subscribeWabaApp` verificado só em unit (Meta mockada); sem e2e contra Meta real (idempotência/shape de erro reais).
- **NEW-ma015-6** — sem log/métrica de sucesso/falha do registro de webhook (`wabas/service.ts` sem logger) → ops cego.
- **NEW-ma015-8** — governança: ADR MA-015 `Proposta` com critérios de "Aceita" abertos, mas código em main/prod.
- **NEW-rlq-3** — sem circuit breaker para `META_UNAVAILABLE` (grep `circuit|breaker` = 0).
- **NEW-rlq-4** — SSE não respeita o cap de backpressure de 10K eventos/conexão (MA-005).
- **NEW-rlq-5** — `DEFAULT_WABA_LIMIT` é bucket fixo hardcoded, não derivado do tier real Meta.

### BAIXO (higiene)

- **NEW-health-kms-readyz-2** — teste `/healthz` quebrado (`toEqual({status:'ok'})` não espera o campo `build` adicionado em `cfca74d`) · REGRESSED · 3ª falha da suíte. ~0.25h.
- **NEW-lint-1** — lint vermelho: `src/lib/queues.ts:174` (`import()` type annotation proibida) + 4 snippets `skills/…` fora do `tsconfig project`. ~1h.
- **NEW-coverage-3** — testes de integration (`token-resolver`, `media-flow`) excluídos do default `pnpm test` e de qualquer CI (`vitest.config.ts`).
- Custo do probe `/readyz` KMS subestimado no commit (~US$6–31/mês vs "<US$1/mês"), mas sem risco de quota; KMS só no readiness (não mata pods em liveness) — **decisão correta**.
- README ainda diz "Code-complete em 2026-04-26" e "249 testes" (real ~420); link para `consumer-integration-guide-v1.md` e `docs/go-live-checklist.md` **quebrados** (ambos ausentes no repo — só no canon).
- Comentário stale em `wabas/service.ts:1-5` ("Callback handler vem na task #13") e `kms-client.ts:158`/`health.ts:61` ("getKeyRing").
- `verify_token` (GET `/webhooks/meta`) compara com `===` não constant-time (`inbound/routes.ts:91`) — baixo risco.
- MA-016 (analytics) é ADR de intenção `Proposta`; módulo `src/modules/analytics` não existe — caminho de PII/decrypt corretamente deferido.

**Pontos sólidos confirmados (não-achados):** I1 UUIDv7, I5 JWT RS256+kid+TTL≤300s, I6 PII redact, I9 HMAC inbound+outbound,
I10 multi-WABA, I11 transações; **MA-008** envelope encryption per-tenant (AAD) com token decifrado só na linha de uso — incl. o
novo caminho MA-015 que usa o plaintext recém-trocado e zera o buffer; refresh WABA agenda 7d antes do expiry, supersede transacional.

---

## Itens-de-fechamento ordenados por valor/esforço (top 10)

| # | Item | Esforço | Destrava |
|---|------|---------|----------|
| 1 | **Corrigir ordem dedup-vs-persist (A5)** — `uniqueIndex` em `meta_event_id` ou confirmar SETNX pós-commit | ~4h | **Bloqueador #1 do piloto**: perda silenciosa de inbound em blip de DB |
| 2 | **Gate de CI (`typecheck`+`lint`+`test`) em PR e push** (NEW-ci-1) | ~4h | Causa-raiz: impede red/regessão chegar à imagem de prod |
| 3 | **Consertar os 3 reds** (`kms-client` ×2 + `/healthz` build) (NEW-tests-1, -kms-2) | ~1.25h | Suíte verde; cobertura viva do probe KMS de `/readyz` |
| 4 | **Fiar `serializeErrorRedacted` como serializer `err` (A2)** | ~1h | Fecha vazamento de token/`client_secret` em stack de worker |
| 5 | **A8: 1 linha no call-site IG** + teste de `processMetaWebhook` com payload IG | ~1.5h | Dedup IG realmente passa a funcionar em prod |
| 6 | **Lint verde** (`queues.ts:174` + eslint config dos snippets) (NEW-lint-1) | ~1h | Desbloqueia o gate #2 |
| 7 | **MA-015: de-subscribe no disconnect + log/métrica de subscribe** (NEW-ma015-3/-6) | ~4h | Sem subscriptions órfãs; ops deixa de ser cego no onboarding |
| 8 | **Mapear 429/quota da Meta → `RATE_LIMITED` (retryable) + `Retry-After`** (NEW-rlq-2) | ~4h | Para de dropar mensagem em throttle da Meta |
| 9 | **Acender observabilidade** (`metaRequestDuration.observe` + `tokenRefreshTotal.inc`) (A16) | ~5h | 3 painéis + 2 alertas + runbooks deixam de ser cegos |
| 10 | **Carimbar MA-012 (C5) + RoPa OT-19** | jurídico ~24h | Bloqueio legal de onboarding de novos consumidores / GA |

> Mínimo defensável para o piloto: **#1–#6 (~12h eng)** + aceitar formalmente RPO/RTO de NEW-infra-4, **fora** de C5
> (jurídico). GA exige #7–#10 + reconciliação de contrato (NEW-CG-*) + IG (A26/A27) + E2E (NEW-e2e-1).

---

## Dependências cruzadas

- **C5 (MA-012), A15 (DSR), NEW-lgpd-1/2/3** → advogado externo + RoPa **OT-19** em `bevox-compliance-lgpd-prd-v1.md` (canon). **Não-código.**
- **A20, NEW-CG-1, NEW-CG-11** (lado canon) → PRs em `bevox-knowledge` (SoT por ADR-005; CLAUDE.md §8 "Parar — PR"). Falta `scripts/sync-contracts.sh` no hub.
- **A13/NEW-CG-5/NEW-CG-6** (campos de contrato) → coordenação com **bevox-backend** (consumidor já provisionado) antes de mudar nomes/shapes.
- **A26/A27 (IG)** → roadmap IG (task #20: `ig/token-resolver.ts`); refresh IG pode exigir endpoint Meta distinto (verificar Graph real).
- **MA-016 (analytics)** → gate do sub-projeto **Cleanup** da migração **bevox-direct → meta-api** ("zero `graph.facebook.com`"); módulo a especificar+construir.
- **NEW-infra-4 (HA)** → decisão de infra (aceitar single-node ou adicionar réplica CNPG/Redis); **compõe com A5** no risco de perda de dados.
- **Reconciliação de invariante** → A9 (tenant-scope) e I7 (soft-delete) podem exigir editar CLAUDE.md §4.3/§4.7 e/ou MA-003/ADR-021.
- **Meta App Review / Embedded Signup (externo)** → MA-015 depende do app compartilhado "Bevox Solutions"; smoke/e2e contra Meta sandbox é critério de "Aceita" da ADR.

---

## Delta vs auditoria anterior (2026-06-02)

**Fechados de verdade (FIXED, verificados estática + leitura direta):**
- CRÍTICOS: **C1** (serializer strip da query nas rotas OAuth), **C2** (worker `media-download` em k8s `deployment-workers.yaml:262` + compose `:152`), **C3** (`MAX_ATTEMPTS` env-driven, backoff §10.2 `getWebhookBackoffDelay`, `dead_letter` em `webhook-delivery.ts:193-201`), **C4** (`outbound-dispatcher.test.ts`, 11 cenários reais).
- ALTOS: **A3** (`job-seal` AES-256-GCM substitui body+secret crus), **A4** (HMAC antes do `JSON.parse`), **A6** (`metaWebhookReceivedTotal` + `webhookDeliveryTotal` emitidos), **A11** (handler `GET /v1/messages/:id`), **A12** (409→422 + parser isolado), **A13** (envelope `{data}`), **A14** (IG callback no spec), **A17** (worker `/metrics` + ServiceMonitor), **A18** (OTLP endpoint), **A19** (readyz exercita KMS — *código* correto), **A25** (token-resolver coberto).

**Fixes que NÃO aterrissaram (PARTIAL — claimed mas incompletos):**
- **A2** (helper existe, não fiado como serializer `err`), **A8** (função correta, call-site passa `undefined` → dedup IG desligado), **A1** (log coberto, resposta HTTP não — DOWNGRADED p/ MÉDIO), **A20** (só `runtime-topology`, 4 registries faltam), **A23** (SSRF ganhou teste; resto do client descoberto).

**Sobreviventes (SURVIVES, intactos — campanha não tocou):** **C5** (jurídico), **A5** (CRÍTICO), **A9, A10, A15, A16, A21, A22, A24, A26, A27** (ALTO), I7, e os MÉDIOS de tenancy/contrato/inbound.

**Novos (NEW, não existiam em 06-02):**
- *Regressões da própria campanha*: 3 testes vermelhos (rework A19-v2 `cfca74d`), lint vermelho (`queues.ts:174`).
- *Processo*: CI sem gate de test/lint/typecheck (causa-raiz).
- *Nova superfície MA-015*: subscriptions órfãs (sem de-subscribe), sem log/métrica, governança (Proposta em prod), só unit.
- *Dimensão rate-limit/quota* (não auditada antes): 2 de 3 camadas inativas, zero tratamento de 429 Meta, sem circuit breaker, SSE sem cap.
- *Contrato*: fork bidirecional repo↔canon (CG-11), path WABA divergente (CG-1), 3 rotas vivas fora de spec, tipos gerados stale, sem bump/ADR.
- *Robustez inbound*: batch multi-mensagem keyed por `messages[0].id`; sem isolamento de erro por-change.
- *LGPD técnica*: imutabilidade de audit-log só comentário (sem enforcement no DB); mídia sem retenção/erasure; região BR não pinada.
- *Infra*: tag mutável + `imagePullPolicy:Never` (push órfão), migrator 42 commits atrás, sem HA, sem alerta de worker.

**Saldo do delta:** a campanha **reduziu o risco de piloto de 5 CRÍTICOS para 2** (1 jurídico inalterado + 1 de código nunca tocado) e fechou ~16 ALTOS, mas **introduziu uma regressão de qualidade** (suíte/lint vermelhos sem CI para pegá-los) e **colocou superfície nova em prod adiantando-se à governança** (MA-015).

---

## Notas de método

**Fontes canônicas.** `$BEVOX_KNOWLEDGE_PATH=$BEVOX_KNOWLEDGE_PATH` (setado nesta sessão). Lidos: PRD V1
(`10_prd/bevox-meta-api/2026-05-08-…`), ADRs `30_adr/bevox-meta-api/` (MA-001..MA-016) + `_shared/`, OpenAPI canon
(`20_architecture/bevox-meta-api/openapi.yaml` v1.2.0), `runtime-topology.md`. O `consumer-integration-guide-v1.md` e
`go-live-checklist.md` referenciados pelo README **não existem no repo** (só no canon / `docs/ops/2026-05-25-go-live-prod-plan.md`).

**Ground-truth executado** (Node 22.22.2, HEAD `d8aa30b`): `pnpm typecheck` → **VERDE**; `pnpm lint` → **VERMELHO** (5–6
problemas: `queues.ts:174` + 4 snippets); `pnpm exec vitest run` → **VERMELHO** (417 passam, **3 falham** em 2 arquivos:
`kms-client.test.ts` ×2 + `server.test.ts` ×1). `.github/workflows/` contém só `build-image.yml` (sem gate de teste).
Leitura direta dos hot paths pelo orquestrador (corroboração independente): `inbound/routes.ts`, `logger.ts`, `queues.ts`,
`webhook-delivery.ts`, `cleanup.ts`, `wabas/service.ts`, `messages/service.ts`, `token-refresh.ts`, `kms-client.ts`.

**Orquestração multi-agente.** Workflow `wf_ecb8d5d3-128` (49 agentes, ~2.12M tokens, ~11.7 min): (1) **16 auditores em
paralelo** — incluindo os 5 agentes especializados do próprio repo (`secrets-redaction-auditor`, `invariants-auditor`,
`tenant-scope-auditor`, `webhook-hmac-auditor`, `contract-guardian`) + 11 dimensionais (fix-verify de outbound, observabilidade,
tests/CI, health/KMS, go-live, LGPD, tokens, IG, MA-015, pilot-risk inbound, rate-limit); (2) **verificação adversarial**
dos CRÍTICO/ALTO abertos (cada verificador instruído a *refutar*). Resultado da verificação: **15 CONFIRMED, 5 DOWNGRADED
(A1, NEW-secrets-1, NEW-webhook-hmac-1, NEW-CG-6, NEW-kms-2), 0 REFUTED**.

**Limitação da execução adversarial.** 13 dos verificadores adversariais (de um total de ~33 CRÍTICO/ALTO abertos) **não
emitiram o output estruturado** (falha de schema-compliance do subagente); 20 vereditos completaram. O gap foi mitigado por
(a) verificação adversarial independente do orquestrador nos itens de maior risco (C1/C2/C3/A3/A4/A5/A8/A21/A22/A26/A27 lidos
diretamente no código), e (b) os 16 auditores dimensionais terem sido instruídos a aplicar ceticismo ("'existe commit' ≠
'achado fechado'") — o que produziu os PARTIAL de A2/A8/A20. Itens CRÍTICO/ALTO sem veredito adversarial formal estão marcados
implicitamente pela ausência de "CONFIRMED/DOWNGRADED" e foram conservadoramente mantidos na severidade do auditor.

**Outras limitações.** (1) Análise estática + testes unit; nenhum teste de integração com Postgres/Redis vivo foi rodado
(defeitos só observáveis com DB real — transações, queries de repository — são inferidos da leitura). (2) Reachability real
da Meta (sandbox/prod) não exercida. (3) Esforços são estimativas de engenharia, não compromissos. (4) Edits no canon
(`bevox-knowledge`) e no estado de prod (k3s Hetzner) estão fora do escopo desta auditoria read-only. (5) Contagens brutas
(162) incluem corroboração cross-dimensão; o conjunto único acionável é menor (ver Resumo).
