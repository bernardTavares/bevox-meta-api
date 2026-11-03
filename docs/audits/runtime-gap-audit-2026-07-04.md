# Gap Analysis — bevox-meta-api — 2026-07-04

## Resumo executivo

Estado geral: **V1 em produção, servindo `bevox-backend` (piloto MVP), com a superfície de _Embedded Signup (ES) + COEX (coexistence)_ recém-aterrissada em prod (commits #35/#37/#39/#40, jun-2026) — auditoria anterior (06-04) nunca a viu.** A campanha entre 06-04 e hoje **fechou as regressões de qualidade** que o audit anterior sangrava (os 3 testes vermelhos estão verdes — suíte **443/443** verificada em Node 22.22.2; tipos OpenAPI regenerados; ES/COEX bem coberto no nível de rota/service), **mas nenhum dos dois CRÍTICOS de piloto fechou** (A5 e MA-012 sobrevivem intactos, verificados no código pelo orquestrador) e o **lint segue vermelho** (o delta-reconciler errou ao marcá-lo como fechado — correção abaixo).

Principais riscos para o piloto/GA:

1. **A5 (CRÍTICO, código)** — dedup `SET NX` roda **antes** de persistir o `InboundEvent`, `meta_event_id` **não** tem `uniqueIndex` e não há `del()` compensatório → **um blip de Postgres perde a mensagem inbound para sempre, silenciosamente, com 200 OK à Meta**. Compõe com a camada de dados single-instance sem HA (infra-4). É o bloqueador #1 do piloto e "a task nunca feita" desde 06-02.
2. **MA-012 (CRÍTICO, jurídico)** — postura LGPD "sub-processador interno" ainda `Status: Proposta`; bloqueia onboarding de novos consumidores. Não fecha por engenharia.
3. **Superfície nova ES/COEX (≈27 achados NEW)** entrou em prod **adiantando-se à governança**: sem ADR, `skill` do consumidor desatualizada, **sem gate de CI**, e carregando um **vazamento de `client_secret`/token via spans OpenTelemetry** (es-1, ALTO), uma **corrida de idempotência que causa envio dobrado ao cliente** (novo, verificado pelo orquestrador), e **ausência total de fluxo de registro de phone number** para Cloud API (novo, pode bloquear o 1º envio no piloto).

Delta vs 06-04: **3 FIXED, 1 REGRESSED, 24 NEW, 3 PARTIAL, 56 SURVIVES.** O padrão que gerou os vermelhos do ciclo anterior persiste: superfície nova em prod **sem rede de CI**.

> **Nota de confiança.** Todos os 87 achados do fan-out passaram por verificação adversarial independente (**0 refutados**). O orquestrador executou o ground-truth (typecheck/lint/test/coverage) e **leu diretamente** os hot-paths de maior severidade (`inbound/service.ts`, `wabas/service.ts`, `meta-client.ts`, `messages/service.ts`, `idempotency.ts`, `audit-log.ts`, `redact.ts`, `logger.ts`, schema de `operations.ts`), corrigindo **dois** erros de subagente (ver Notas de método).

---

## Achados por severidade

> Convenção: `arquivo:linha` = evidência verificada (estática + leitura direta + execução). `delta` ∈ FIXED / PARTIAL / SURVIVES / NEW / REGRESSED (vs 2026-06-04). `verify` = veredito do passe adversarial (CONFIRMED / ADJUSTED). Achados marcados **[orq]** foram verificados em primeira mão pelo orquestrador (não vieram só do fan-out).

### CRÍTICO (bloqueia piloto)

**A5 — dedup `SET NX` roda ANTES de persistir o `InboundEvent`; `meta_event_id` sem `uniqueIndex`; sem `del()` compensatório → perda silenciosa e permanente de inbound em qualquer blip de Postgres** · SURVIVES · verify CONFIRMED · **[orq]**
- Ev.: `src/modules/inbound/service.ts:298` `isDuplicate()` (SET NX EX 24h, def. `:184-194`) **reivindica a chave antes** de `insertInboundEvent()` em `:324`. Nenhum `del()` compensatório (únicas refs a `DEDUPE_PREFIX`: `:104`, `:187`). O índice de `meta_event_id` é **não-único**: `db/schema/operations.ts:98` usa `index(...)`, **não** `uniqueIndex` — e `uniqueIndex` **está importado e usado** logo acima (`:68`, `outbound_jobs`), então a escolha é deliberada. Só existe a migration `0000_initial_schema.sql` (7-mai); **nenhuma migration nova** desde então. Logo o `SET NX` no Redis é o **único** dedup.
- Sequência de falha: insert lança (falha transitória de DB/pool/failover CNPG) → 500 → Meta retenta → `isDuplicate` agora retorna `true` (chave já setada) → conta `outcome:"deduplicated"` → **200 OK** → evento **nunca persistido nem entregue**. O +41L de COEX (#37/#39) **não** tocou a ordem.
- Impacto: perda silenciosa de mensagem/status inbound a cada instabilidade de Postgres. **Compõe com infra-4** (CNPG `instances:1` + Redis `replicas:1`, sem HA) — failover/restart é realista no piloto.
- Recomendação: `uniqueIndex` em `meta_event_id` (o INSERT vira o dedup atômico), **ou** só confirmar a chave após o commit / `del()` no catch. Esforço: **~4h**.

**MA-012 (C5) — postura LGPD "sub-processador interno" ainda `Status: Proposta` → bloqueia onboarding/produção** · SURVIVES · verify CONFIRMED · jurídico
- Ev.: `bevox-knowledge/30_adr/bevox-meta-api/MA-012-…` (`Status: Proposta`, "Bloqueia go-live"). PRD §12.1 ainda hedge ("acredita-se defensável"); `README.md:18,86`.
- Impacto: todo PII tratado (conteúdo de mensagem, números E.164, IG handles, binários de mídia) sob postura unilateral sem parecer externo; a RoPa OT-19 (meta-api como componente do tratamento mestre) **nunca foi publicada**. Nuance: README posiciona `bevox-backend` como coberto por MSA preexistente — reduz o risco operacional, mas não está registrado na RoPa do controlador.
- Esforço: **~24h jurídico**. Engenharia não fecha (parecer externo + OT-19 no canon).

> **Delta CRÍTICO:** os 3 CRÍTICOS reportados pelo fan-out reduzem a **2 distintos** (A5 foi achado por dois finders independentes — `inbound` e `webhook-hmac` — ambos CONFIRMED CRÍTICO). Ambos **sobrevivem intactos** desde 06-02/06-04. **Nenhum CRÍTICO fechou nesta janela.**

### ALTO (bloqueia GA, não bloqueia piloto)

**Segredos / logging (o cluster mais sério da superfície nova)**
- **es-1 — `client_secret` / `access_token` / OAuth `code` vazam via auto-instrumentação undici do OpenTelemetry (`url.full`/`url.query` não redigidos)** · NEW · verify CONFIRMED · **[orq corrobora]**. `src/integration/meta-client.ts:270` (`metaGet` copia **todo** param para `url.searchParams.set`), `:315,319` (`client_secret=META_APP_SECRET` na query de `/oauth/access_token`), `:366` (`app_id|app_secret` no `/debug_token`), `:392,424,549,612` (`access_token` cru na query de `discoverWaba`/`discoverWabaById`/`getPhoneCoexInfo`/`triggerSmbAppDataSync`). `src/lib/telemetry.ts:95-101` liga `getNodeAutoInstrumentations` (só `instrumentation-fs` off); o `instrumentation-undici@0.25.0` grava `ATTR_URL_FULL` (URL completa com query) como atributo de span **sem passar por scrubber algum** — `scrubSentryEvent`/`redactStringSecrets` só correm no Sentry/Pino, nunca nos spans OTLP. Com `OTEL_EXPORTER_OTLP_ENDPOINT` setado (MA-007/Grafana Tempo em prod) → **o segredo do app Meta e tokens de todos os tenants vão em claro ao backend de traces.** Pior: `client_secret` é hex, **não** casa `EAA…/eyJ…`, então nem `serializeErrorRedacted` o pegaria. Viola invariante §4.4 e a regra secrets. **Recomendação:** enviar secret/code/token no corpo POST (form-urlencoded) ou header `Authorization`; e dropar `url.full`/`url.query` dos spans (requestHook/SpanProcessor). Esforço: **~3h**.
- **Idempotência sem reserva atômica → envio DOBRADO ao cliente sob retry concorrente** · NEW · **[orq — verificado em primeira mão]**. `src/plugins/idempotency.ts:98` faz `findIdempotencyRecord` no `preHandler` e só grava no `onSend` (`:136`) — **read-then-write sem `SET NX`/lock in-flight** (a regra `meta-api-modules.md` exige `SET NX`). Dois `POST /v1/messages` com a mesma `Idempotency-Key` (retry por timeout do cliente) **ambos dão miss** e ambos executam; `src/modules/messages/service.ts:183` **chama a Meta antes** do `insertOutboundJob:203`, e o índice `outbound_jobs_app_idempotency_uniq` (`operations.ts:68`) só barra o **segundo insert** — depois de a segunda mensagem já ter saído. Resultado: **2 mensagens ao cliente final**, cliente recebe 1×200 + 1×500 (o 500 pode disparar 3ª tentativa). Blast radius maior nas mutações **sem** índice único (WABA `connect/complete` → duplo subscribe; template create → duplo create). Esforço: **~4h** (reserva `SET NX` no preHandler ou insert-antes-de-enviar com unique constraint).
- **secrets-1 (A2) — `serializeErrorRedacted` NÃO está fiado como serializer `err` do Pino** · SURVIVES · verify ADJUSTED→MÉDIO (mas **eleva** via es-1). `src/lib/logger.ts:64-94` (`buildLoggerOptions`) não tem bloco `serializers`; `server.ts` só define `req`. Os 5 workers logam `err` cru; o catch do sync COEX (`wabas/service.ts:294`) loga `{err}` de chamada Meta autenticada. O verificador rebaixou para MÉDIO (latente), mas es-1 mostra o vetor **vivo** na superfície ES/COEX. Fix conjunto com es-1. **~1h**.

**Webhook / inbound**
- **hmac-a8 — dedup de Instagram continua DESLIGADO em produção** · SURVIVES · verify CONFIRMED · **[orq]**. `src/modules/inbound/service.ts:247` chama `processSingle(object, entry.id, undefined, undefined, {messaging})` — 4º arg (`value`) = `undefined` → `extractMetaEventId(undefined,undefined)` retorna `null` (`:145`). A função pura **já** cobre IG (`:161-180`) mas o call-site nunca a alcança. Fix de 1 linha (passar `{messaging}` também como `value`). **~1h**.
- **tenant-a10 — resolução de tenant inbound por `meta_waba_id`/`meta_ig_id` sem escopo app/tenant** · SURVIVES · verify CONFIRMED · **[orq]**. `resolveTenant` (`service.ts:204,212`) chama `findWabaByMetaWabaId`/`findIgByMetaIgId` sem `app_id`/`tenant_id`, `.limit(1)` sem `orderBy` (não-determinístico). Unicidade do schema é `(tenant_id, meta_waba_id)`, não global → com WABA compartilhada entre tenants (agora possível via ES/COEX, ver coex-1) a entrega vai ao tenant errado. **~5h**.
- **cov-3 (NEW-ci-1 + NEW-coverage-3) — sem gate de CI (`test`/`lint`/`typecheck`) e integration/e2e fora do `pnpm test`** · SURVIVES · verify CONFIRMED · **[orq]**. Único workflow: `.github/workflows/build-image.yml` (build+push; dispara só em `push:main`, nunca em PR). **Causa-raiz** dos vermelhos que chegaram a prod. **~4h**.
- **Ausência total de fluxo de registro de phone number (Cloud API `register`)** · NEW · **[orq — verificado]**. `grep register|request_code|verify_code|two_step` em `src/modules/phone-numbers/`, `meta-client.ts` e `wabas/service.ts` = **zero**. Para onboarding ES de número novo/migrado, o 1º envio via Cloud API exige `POST /{phone_number_id}/register` (PIN/two-step). `completeEmbeddedSignup` não chama. **Escalada a CRÍTICO** se o piloto onboardar número net-new/migrado via ES puro; para COEX (número já ativo no app do negócio) o requisito difere. Esforço: **~6h**.

**Contrato / consumidor**
- **coex-1 / es-coex-1 — ES/COEX persiste WABA a partir do `waba_id` do front sem verificar posse GLOBAL do `meta_waba_id`** · NEW/SURVIVES · verify CONFIRMED (ALTO por `coex`) / ADJUSTED→MÉDIO (por `ten`) · **[orq corrobora]**. `wabas/service.ts:250` `discoverWaba(token,{wabaId:hint})` faz `GET /{waba_id}` — **isso gateia acesso** (não dá pra vincular WABA que o token não alcança), então **não é hijack trivial**. Mas `findWabaByTenantAndMetaId:138` chaveia `(tenant_id, meta_waba_id)` **sem unicidade global** → a mesma WABA pode vincular a dois tenants; combinado com tenant-a10 (resolução inbound não-escopada) → **ambiguidade de roteamento inbound em WABA compartilhada**. O #39 abandonou o cross-check de `granular_scopes` do `/debug_token` (coex-2), removendo a prova explícita de autorização. **~5h**.
- **cg-skill-1 — a `skill bevox-meta-api-consumer` não conhece `connect/complete`, `config_id` nem `coexistence`** · NEW · verify CONFIRMED. Descreve só o fluxo ES antigo. Consumidor que segue a skill não consegue integrar ES/COEX. **~3h**.

**LGPD técnica / tokens / IG**
- **lgpd-a15-dsr — sem endpoint DSR/erasure (`POST /admin/dsr`) nem tabela `dsr_requests`; primitivas de erasure são código morto** · SURVIVES · verify CONFIRMED. ADR-020/PRD §12.4. `listMediaKeys()` sem caller (td-4). **~8h**.
- **lgpd-immutability — imutabilidade de `audit_logs` é só comentário "TODO"; sem REVOKE/RULE/TRIGGER no banco** · SURVIVES · verify CONFIRMED. A role da app pode UPDATE/DELETE → trilha "imutável de 5 anos" refutável em auditoria ANPD. **~4h**.
- **tok-1 — envio Instagram lança `INTERNAL` 500; resolver de token IG inexistente** · SURVIVES · verify CONFIRMED · **[orq]**. `messages/service.ts:166` curto-circuita antes de `sendInstagramMessage`. Atinge sync **e** async (dispatcher reusa `sendMessage`). **~8h**.
- **tok-2 — tokens Instagram nunca renovados** · SURVIVES · verify CONFIRMED. `token-refresh.ts` só WABA; `igTokens.refresh_at/expires_at` sem leitor. Refresh IG usa endpoint distinto (`ig_refresh_token`). **~6-8h**.

**Rate-limit / quota**
- **rlq-2 — Meta 429/throttle vira `META_REJECTED` terminal no dispatcher → mensagem async perdida silenciosamente** · SURVIVES · verify CONFIRMED. `meta-client.ts:~213` só ramifica `>=500`; 429 (codes 4/17/32/80007/130429/613) cai em `metaRejected`, tratado como terminal não-retryável em `outbound-dispatcher.ts`. Sem leitura de `Retry-After`. A skill `meta-graph-error-map` já tem a tabela. **~4h**.

**Observabilidade (métricas definidas mas nunca emitidas — alertas/painéis/runbooks cegos)**
- **obs-1 — `metaRequestDuration` Histogram nunca observado** · SURVIVES · verify CONFIRMED. `meta-client.ts` nem importa `@/lib/metrics`. Alerta "Meta down" (p99) cego.
- **obs-2 — `tokenRefreshTotal{channel,outcome}` nunca incrementado** · SURVIVES · verify CONFIRMED. `token-refresh.ts` só emite `workerJobsTotal` — mascara `disconnected`.
- **obs-3 — `queueSize` Gauge nunca coletado** · SURVIVES · verify CONFIRMED. Nenhum leitor de job counts do BullMQ → painel de backlog e check de DR mortos.
- **infra-5 — sem alerta para workers críticos down (out/in/media/tok)** · SURVIVES · verify CONFIRMED. Pipeline de webhook fica cego no piloto.

### MÉDIO (degrada qualidade)

**Superfície nova ES/COEX (atomicidade, validação, inbound COEX)**
- **es-2 / inv-es-2** (ADJUSTED de ALTO) — `connect/complete` chama `subscribeWabaApp` (Meta) **antes** do persist e fora de atomicidade → subscription órfã se o persist falhar; `code` single-use + idempotency só cacheia 2xx tornam o retry irrecuperável. Verificador notou que `subscribeWabaApp` é idempotente na Meta (órfã auto-cura no re-onboard). **[orq corrobora]** `wabas/service.ts:115` antes de `:149`. **~4h**.
- **es-3** — `waba_id`/`phone_number_id`/`business_id` são `z.string().min(1).max(64)` **sem regex** (`schemas.ts:42-50`) e interpolados direto em paths/query da Graph API (`meta-client.ts:423,548,564`) → injeção de path/param (bounded, autenticado). Aplicar `^\d{1,20}$`. **~1h**.
- **es-4** — `waba_id` opcional no schema mas o fluxo ES quebra sem ele; fallback `/debug_token` normalmente falha para tokens de ES.
- **coex-3 / inbound-coex-nodedup** — dedup desligado para `smb_app_state_sync`/`history` (`service.ts:154-155` retorna `null`) → retries da Meta durante o sync de 24h do COEX reentregam **lotes grandes duplicados**. **[orq]**.
- **inv-es-1** — `GET /v1/oauth/waba/callback` persiste WABA+token mas **não** gera audit log (I8).
- **coex-2** — abandono do `granular_scopes`/`/debug_token` no caminho com hint remove a prova explícita de autorização da WABA para este app.
- **obs-4** — onboarding ES/COEX sem métrica nem log de sucesso/falha → funil novo inobservável.
- **secrets-2** — COEX loga `err` cru de chamadas Meta autenticadas via logger raiz não-scrubado.

**Tenancy (defesa em profundidade — mitigada por `app_id` do JWT assinado)**
- **tenant-a9** — plugin `tenant-scope` ainda inexistente; `patchContext` nunca chamado; `tenant_id` vem do header `X-Tenant-Id` forjável, não do JWT. Mitigado porque `app_id` (do `iss` assinado) entra em toda query tenant-scoped → forjar `X-Tenant-Id` retorna NOT_FOUND. CLAUDE.md §4.3/MA-003 descrevem um injetor **que não existe** → reconciliar doc↔código. **~8-16h**.
- **tenant-1** — worker `webhook-delivery` entrega sem checar match `app_id/tenant_id` entre subscription e inbound_event.
- **tenant-2** — `GET /v1/events` retorna eventos de todos os tenants do app quando `X-Tenant-Id` omitido.
- **tenant-3** — `updateJobStatus`/`incrementAttempts` de `outbound_jobs` por id puro, sem predicado `app_id`.

**Contrato / OpenAPI (drift bidirecional)**
- **cg-collision-1** (REGRESSED, ADJUSTED de ALTO) — repo OpenAPI e canon **ambos em `1.2.0`** mas divergem (repo ganhou ES/COEX em `openapi.yaml:199`, canon não). **Pior** que 06-04 (era 1.0.0 vs 1.2.0, ao menos distinguível). **[orq]** confirmado `openapi.yaml:4 → 1.2.0`.
- **cg-1-callback-path** (SURVIVES) — código serve `/v1/oauth/waba/callback` (`routes.ts:68`); repo spec `:237`, canon e skill declaram `/v1/tenants/{id}/wabas/connect/callback`. Onboarding só funciona porque a URL vem de env.
- **cg-residual-batch** — sete drifts do 06-04 seguem abertos: `/webhooks/meta` fora de spec, `/deactivate` fora de spec, `current_kid` vs `current_public_key_id`, `secret` vs `signing_secret`, `delivery_mode` enum, `events/ack` idempotency não documentada, `media_key`.
- **cg-adr-coex** — ES/COEX entrou no contrato **sem ADR** e com commit mislabelado `docs(api):` para adição de endpoint.

**Idempotência / soft-delete / secrets (invariantes parciais)**
- **inv-i2-admin** — rotas admin de mutação (incl. nova `/deactivate`) não exigem `Idempotency-Key` (I2). *(Nota [orq]: `connect/complete` e `connect/init` **têm** `requireIdempotency` — `routes.ts:28,49,131` — não são violação.)*
- **inv-i7-templates** — DELETE de template é hard-delete em request path; tabela sem `deleted_at` (I7).
- **secrets-3 (A1)** — `error-handler` envia `AppError.details` cru na resposta HTTP; novos `details` COEX ecoam `phone_number_id` ao consumer.
- **secrets-4 (NEW-secrets-1)** — `captureException` repassa `context` como Sentry `extra`; `scrubSentryEvent` não limpa `extra`/`contexts`.
- **Números E.164 persistidos sem máscara em `audit_logs` e `outbound_jobs`** · NEW · **[orq — verificado]**. `audit-log.ts:93` grava `req.body` em `metadata.body` via `redact()`; `redact()` (`logger.ts:145`, `REDACT_KEY_NAMES:136-138`) **redige** `content`/`text`/`body` (invariante 6 **mantida** — conteúdo de mensagem NÃO vaza) **mas não** a chave `to` (telefone E.164 do destinatário). Idem `outbound_jobs.payload_json` (`messages/service.ts:177`). A regra secrets exige `phone_number_e164` mascarado (`+55****1234`) — **não implementado**. Retido 5 anos (audit) / 30 dias (outbound). **~2h**.

**Robustez inbound (piloto com tráfego real)**
- **inbound-NEW-1** (ADJUSTED) — batch multi-mensagem colapsa em 1 `InboundEvent`, dedupado e com mídia baixada só por `messages[0]` (`service.ts:82-83,148`) → mensagens 2..N perdidas. **[orq]**.
- **inbound-NEW-2** — processamento inbound 100% síncrono no request antes do 200; com history/echo COEX de alto volume arrisca a janela da Meta.
- **inbound-NEW-3-coex** — `bodyLimit` global 1MB sem override em `/webhooks/meta`; sync de histórico COEX pode exceder → 413 → Meta retenta até expirar → history sync nunca aterra.
- **inbound-NEW-4** — sem isolamento de erro por-change: um change defeituoso 500a o batch inteiro (compõe com A5).
- **hmac-ratelimit / inbound-ratelimit** (ADJUSTED) — `/webhooks/meta` sem rate-limit nem IP-allowlist; `trustProxy:true` sem allowlist → XFF spoofável; flood forjado consome CPU de HMAC/JSON.parse. PRD §7.5 exige ambos.

**Rate-limit / infra / observabilidade / webhook outbound**
- **rlq-1** (ADJUSTED) — camadas tenant e WABA-tier do rate-limit nunca executam (as chamadas `requireRateLimit()` sem opções → só `DEFAULT_APP_LIMIT`); um tenant esgota a cota Meta dos demais do mesmo app.
- **rlq-3** — sem circuit breaker para `META_UNAVAILABLE`.
- **rlq-4** — SSE `/v1/events/stream` sem cap de backpressure (MA-005 10K/conexão); `write()==false` ignorado → buffer de socket cresce.
- **infra-2** (ADJUSTED) — imagem em tag mutável git-SHA + `imagePullPolicy:Never` viola go-live §8 (exige digest); bumps #38/#40 só trocaram o valor.
- **infra-3** — `job-migrate` aponta para registry-org e SHA antigos (`ghcr.io/bevox migrator-5706afe`) divergentes do runtime (`ghcr.io/bernardtavares dbe9fd6`).
- **infra-4** (ADJUSTED) — camada de dados single-instance sem HA (CNPG `instances:1` + Redis `replicas:1`) → **compõe com A5** (perda silenciosa no failover).
- **infra-6** — dois dos seis alertas são natimortos (métricas subjacentes de obs-1/obs-2 nunca emitidas).
- **hmac-callback-format** — callback async (status outbound) assina com header/formato não-canônico (`x-bevox-signature-256: sha256=`) e **sem anti-replay**, vs o canônico `t=,v1=` de `webhook-delivery.ts`. Consumidor conforme o guia canônico não valida.
- **hmac-desub (NEW-ma015-3)** — `disconnectWaba` **não** faz de-subscribe no Meta (`DELETE /{waba_id}/subscribed_apps`) → subscriptions órfãs seguem entregando; **agravado** porque ES/COEX agora subscrevem ativamente.

**LGPD técnica (retenção)**
- **lgpd-a21-audit-retention** — cleanup não aplica retenção de 5 anos de `audit_logs` (mecanismo inexistente).
- **lgpd-a22-tokens / tok-3** — rows de token superseded+expirado (`waba_tokens`/`ig_tokens`) nunca deletadas; ciphertext acumula.
- **lgpd-coex-1** (ADJUSTED de ALTO) — COEX history/contact-sync persiste **conteúdo de mensagem e agenda do titular** cru em `inbound_events` (via `redactSecrets`, por design de forwarding), retido 90d, **sem base legal registrada nem erasure**.
- **lgpd-media-erasure** — binários de mídia inbound (S3) sem política de retenção nem erasure.
- **lgpd-region** — `MEDIA_S3_REGION` default `us-east-1` sem validação de residência BR em prod.

**Dívida / docs**
- **td-1** — README diz "249 testes" (real **443**) + "Code-complete 2026-04-26" stale.
- **td-2** — README aponta para `consumer-integration-guide-v1.md` (**ausente no repo**, só no canon) e `go-live-checklist.md` (ausente) → links quebrados. **[orq confirmado]**.
- **td-4** — `listMediaKeys()` sem caller → cascade de erasure DSR nunca ligado.
- **cov-1 (A23)** (ADJUSTED) — `mapMetaError`+`exchangeCode`+`sendWhatsAppMessage` sem teste contra a impl real do meta-client (cobertura `meta-client.ts` 47% stmt / 38% func).
- **cov-2 (A24)** (ADJUSTED) — `wabas/repository.ts` **0%** de cobertura; funções transacionais (invariante 11, incl. `reconnectWaba`) nunca exercitadas.
- **cov-4** — suíte E2E só scaffolding (PING+SELECT 1); `setup.ts` não migra nem sobe o app.

### BAIXO (higiene)

- **NEW-lint-1 — lint VERMELHO: `src/lib/queues.ts:174` (`import()` type annotation proibida) + 4 snippets em `skills/bevox-meta-api-consumer/snippets/` fora do `tsconfig project`** · **SURVIVES** · **[orq — CORREÇÃO]**. `pnpm lint` → **exit 1, 5 problemas** (verificado; `queues.ts:174` = `import("./job-seal.js").SealedSecrets` ainda presente). *(O delta-reconciler do fan-out marcou este item como FIXED — está errado; ver Notas de método.)* **~1h**.
- **hmac-verifytoken** — `GET /webhooks/meta` compara `hub.verify_token` com `===` (não constant-time). Baixo risco.
- **inv-i3-recon / inv-i4-a2** — lookup de reconexão e disconnect por webhook não são `app_id`-scoped (defense-in-depth); `exchangeCode` reusa `metaGet` com secret na query (vetor es-1).
- **es-5** — `connect/complete` não emite log de mutação canônico no caminho de sucesso (ops cego no onboarding).
- **rlq-5** — `DEFAULT_WABA_LIMIT` bucket fixo hardcoded, não derivado do tier real Meta.
- **secrets-5** — `redact.paths` do Fastify sem `x-hub-signature-256`/`x-admin-token`/`x-meta-token`.
- **tok-4** — ES/COEX persiste token de code-exchange sem upgrade long-lived, assumindo TTL 60d → risco de expiry precoce fora do alcance do refresh worker.
- **tok-5** — coluna `refresh_at` gravada mas nunca lida na seleção de refresh (drift com docstring).
- **infra-7** — PDB ausente para worker-media/tok/cleanup (`replicas:1`); node drain evacua o único worker sem budget.
- **coex-4** — sem teste de regressão para colisão de `meta_waba_id` entre tenants no caminho complete.
- **td-3** — comentário stale `wabas/service.ts:4` ("Callback handler vem na task #13" — já implementado). **[orq]**.
- **td-5** — dois scripts operacionais untracked (`scripts/check-meta-app.mjs`, `scripts/provision-bevox-direct-consumer.js`). **[orq]**.
- **td-6** — MA-016 analytics só ADR `Proposta` sem módulo; TODO dead-letter em `webhook-delivery.ts:211`.
- **obs-5** — `webhook_signature_invalid_total` emitida sob outro nome, sem label provider/app.

**Pontos sólidos confirmados (não-achados):** I1 UUIDv7; I5 JWT RS256+kid+TTL≤300s; I6 (conteúdo de mensagem **é** redigido por `redact()` em log/audit/outbound); I9 HMAC inbound+outbound; I10 multi-WABA; **I11 (DB)** transações atômicas no persist; **MA-008** envelope encryption per-tenant com AAD (`tenant_id,waba_id,app_id,v`) e `tokenBytes.fill(0)` no `finally` — **incl. o novo caminho ES/COEX** (`wabas/service.ts:126-132`). O `connect/complete` respeita I2 (idempotency-key). Suíte **443/443** verde em Node 22.

---

## Itens-de-fechamento ordenados por valor/esforço (top 10)

| # | Item | Esforço | Destrava |
|---|------|---------|----------|
| 1 | **A5** — `uniqueIndex` em `meta_event_id` ou confirmar SETNX pós-commit / `del()` no catch | ~4h | **Bloqueador #1 do piloto**: perda silenciosa de inbound em blip de DB |
| 2 | **Gate de CI** (`typecheck`+`lint`+`test` em PR e push) — cov-3 | ~4h | Causa-raiz: impede red/regressão chegar à imagem de prod |
| 3 | **Lint verde** (`queues.ts:174` + eslint config dos snippets) — NEW-lint-1 | ~1h | Desbloqueia o gate #2 (hoje `pnpm lint` = exit 1) |
| 4 | **es-1** — tirar secret/code/token da query (POST body/header) + dropar `url.full`/`url.query` dos spans OTel + fiar `serializeErrorRedacted` | ~3h | Fecha vazamento de `client_secret`/token ao Tempo + A2 |
| 5 | **Idempotência com reserva `SET NX`** (ou insert-antes-de-enviar) | ~4h | Para de mandar mensagem dobrada ao cliente sob retry concorrente |
| 6 | **Fluxo `register` de phone number** para onboarding ES | ~6h | Desbloqueia o 1º envio no piloto p/ número novo/migrado |
| 7 | **hmac-a8** — 1 linha no call-site IG + teste de `processMetaWebhook` com payload IG | ~1.5h | Dedup IG realmente passa a funcionar em prod |
| 8 | **rlq-2** — mapear 429/quota Meta → `RATE_LIMITED` (retryable) + `Retry-After` | ~4h | Para de dropar mensagem async em throttle da Meta |
| 9 | **Acender observabilidade** (`metaRequestDuration.observe` + `tokenRefreshTotal.inc` + coletor `queueSize`) + de-subscribe no disconnect (hmac-desub) | ~7h | 3 painéis + alertas + runbooks e onboarding deixam de ser cegos; sem subscriptions órfãs |
| 10 | **Carimbar MA-012 + RoPa OT-19** | jurídico ~24h | Bloqueio legal de onboarding de novos consumidores / GA |

> **Mínimo defensável para o piloto:** #1–#6 (~22h eng) + aceitar formalmente RPO/RTO de infra-4, **fora** de MA-012 (jurídico). **GA** exige #7–#10 + reconciliação de contrato (cg-*) + IG (tok-1/tok-2) + tenant-a10/tenant-scope + E2E (cov-4) + imutabilidade/retenção de audit (lgpd-immutability/a21).

---

## Dependências cruzadas

- **MA-012, lgpd-a15-dsr, lgpd-coex-1, lgpd-immutability, lgpd-region/media** → advogado externo + RoPa **OT-19** em `bevox-compliance-lgpd-prd-v1.md` (canon; ADR-019/020). **Não-código.**
- **cg-collision-1, cg-1-callback-path, cg-residual-batch, cg-skill-1** (lado canon) → PRs em `bevox-knowledge` (SoT por ADR-005; CLAUDE.md §8 "Parar — PR"). Falta `scripts/sync-contracts.sh` no hub. Atualizar a `skill bevox-meta-api-consumer` (repo) para ES/COEX.
- **Campos de contrato** (`current_kid`, `signing_secret`, `delivery_mode`) → coordenar com **bevox-backend** (consumidor já provisionado) antes de mudar nomes/shapes.
- **tok-1/tok-2 (IG)** → roadmap IG (`ig/token-resolver.ts`, task #20); refresh IG usa endpoint Meta distinto (verificar Graph real).
- **es-1 (secret via OTel)** → depende de `OTEL_EXPORTER_OTLP_ENDPOINT` estar setado (MA-007 Grafana); confirmar a config de prod.
- **register de phone number, ES/COEX, MA-015** → dependem do **app compartilhado "Bevox Solutions"** e do **Meta App Review**; smoke/e2e contra Meta sandbox é critério de "Aceita" da ADR.
- **infra-4 (HA)** → decisão de infra (aceitar single-node ou adicionar réplica CNPG/Redis); **compõe com A5** no risco de perda de dados.
- **Reconciliação de invariante** → tenant-a9 (tenant-scope) e I7 (soft-delete) podem exigir editar CLAUDE.md §4.3/§4.7 e/ou MA-003/ADR-021.
- **bevox-direct → meta-api** (MA-016 analytics) → módulo `src/modules/analytics` a especificar+construir (gate do sub-projeto Cleanup).

---

## Delta vs auditoria anterior (2026-06-04)

**Fechados de verdade (FIXED — verificado por execução):**
- **Os 3 reds do baseline** (`kms-client` ×2 + `/healthz` build) → **suíte 443/443 verde** (executado, Node 22.22.2). `cov-6`.
- **CG-10** — `src/types/api.ts` regenerado (não mais congelado no commit inicial). `cg-10-types-regen`.
- **cov-5** — superfície ES/COEX bem coberta no nível de rota/service (`wabas/service.ts` 94%, `complete.test.ts` +338L).

**Regredido (REGRESSED):**
- **cg-collision-1** — repo e canon OpenAPI **ambos `1.2.0`** mas forkados (repo tem ES/COEX, canon não). Pior que os `1.0.0` vs `1.2.0` distinguíveis de 06-04.

**Sobrevivem (SURVIVES — 56 itens, campanha não tocou):** os 2 CRÍTICOS (A5, MA-012); ALTOS A8 (dedup IG), A9/A10 (tenancy), A15 (DSR), A16 (obs ×3), A21/A22 (retenção), A23/A24 (cobertura), A26/A27 (IG), rlq-1..5, infra-2..6, inbound-NEW-1..4 + ratelimit, tenant-1..3, secrets-1/3/4, hmac-callback-format/desub/verifytoken, I7, inv-i2-admin, cg-1/cg-residual; **e — correção do orquestrador — NEW-lint-1** (o reconciler o marcou FIXED por engano; `pnpm lint` segue exit 1).

**Novos (NEW — 24 do fan-out + 3 do orquestrador):**
- *Superfície ES/COEX* (auditoria anterior nunca viu): **es-1** (secret via OTel — o mais sério), es-2/es-3/es-4/es-5, coex-1..4, es-coex-1, inv-es-1/inv-es-2, lgpd-coex-1, cg-skill-1, cg-adr-coex, secrets-2, obs-4, tok-4/tok-5, infra-7.
- *Achados do orquestrador* (fora do fan-out, verificados em 1ª mão): **corrida de idempotência → envio dobrado** (ALTO); **ausência de fluxo `register` de phone number** (ALTO); **E.164 sem máscara em audit_logs/outbound_jobs** (MÉDIO).
- *Dívida/docs*: README stale (443 testes, não 249), links quebrados.

**Saldo do delta:** a campanha finalmente aterrissou as **regressões de qualidade** que o 06-04 sangrava (3 reds verdes, tipos regenerados, ES/COEX coberto), **mas o lint segue vermelho**, **nenhum CRÍTICO de piloto fechou** (A5 e MA-012 intactos), e uma **grande superfície ES/COEX entrou em prod adiantando-se à governança** (sem ADR, skill desatualizada, **sem CI**) — o mesmo padrão que gerou os reds do ciclo anterior — trazendo ~27 achados NEW, incluindo um vazamento de segredo do app via OpenTelemetry e uma corrida de idempotência com envio dobrado ao cliente.

---

## Notas de método

**Orquestração.** Fan-out determinístico via Workflow (ultracode, effort high): **15 finders** (dimensões a–l + superfície ES/COEX + auditores do repo `contract-guardian`/`invariants-auditor`/`webhook-hmac-auditor`/`tenant-scope-auditor`/`secrets-redaction-auditor` via `agentType`) → **verify adversarial** por achado CRÍTICO/ALTO (cético instruído a refutar) → **delta-reconciler** + **crítico de completude**. **52 agentes, 0 erros, 87 achados, 0 refutados**, ~2,1M tokens, ~13min. Distribuição efetiva (pós-verify): 3 CRÍTICO (2 distintos), 15 ALTO, 51 MÉDIO, 18 BAIXO.

**Ground-truth executado pelo orquestrador** (Node **22.22.2**, HEAD `5516c2a`): `pnpm typecheck` → **VERDE**; `pnpm lint` → **VERMELHO** (exit 1; `queues.ts:174` + 4 snippets); `pnpm exec vitest run --coverage` → **VERDE** (45 arquivos, **443 passed / 0 failed**); cobertura **69.57% stmt / 61.5% branch / 60.88% func / 72.47% line**. Sinais: camada `repository.ts` ~**0%** (DB mockado — A24/cov-2), `meta-client.ts` **47%** (cov-1), workers **21%** no nível de função, `media-storage.ts` **16%** (erasure morta).

**Duas correções a subagentes** (valor do orquestrador ler o código):
1. O **delta-reconciler** marcou **NEW-lint-1 como FIXED** ("`import()` gone, grep=0"). **Errado** — `sed`+`eslint` diretos mostram `queues.ts:174 = import("./job-seal.js").SealedSecrets` presente e `pnpm lint` = exit 1. **NEW-lint-1 SURVIVES.**
2. O **crítico de completude** alegou que `audit-log.ts` grava **conteúdo de mensagem** cru em `audit_logs`. **Parcialmente errado** — `redact()` (`logger.ts:145`, `REDACT_KEY_NAMES` inclui `content/text/body`) **redige** o conteúdo (invariante 6 mantida). O que **de fato** vaza é a chave `to` (telefone E.164, não mascarado) — rebaixado de ALTO para MÉDIO e reescrito com precisão.

**Achados do crítico de completude ainda em aberto (não passaram pelo verify adversarial — confiança média; a investigar):** (a) **cache de auth aceita JWT com chave/app revogados por ≤5min** (`auth-jwt-consumer.ts:41,65,78`) — sem deny-list de `jti` no off-boarding; (b) **`crypto-envelope.ts` nunca testado quanto a tamper de AAD / reuso de nonce** (raiz de MA-008); (c) **semântica de entrega SSE `events`** — há replay por `Last-Event-ID`/cursor ou eventos entre desconexões são perdidos?; (d) **coreografia SIGTERM↔`/readyz`↔workers** no rollout single-replica (`shutdown.ts:87-98`); (e) **formato HMAC da fila `webhook-delivery`** (rota de maior volume) nunca comparado ao guia do consumidor; (f) **`ADMIN_API_KEY` aceita 8 chars** (`env.ts:82` `min(8)`) para assinar JWT admin; (g) **pool/retry do `meta-client`** (keep-alive? retry em ECONNRESET/5xx?). ADRs MA-001..MA-014 **não existem no repo** (só `MA-015`/`MA-016` em `docs/adr/`) — rastreabilidade in-repo dos invariantes depende do canon.

**Fontes canônicas** (`$BEVOX_KNOWLEDGE_PATH=$BEVOX_KNOWLEDGE_PATH`): PRD `10_prd/bevox-meta-api/2026-05-08-…`, ADRs `30_adr/bevox-meta-api/` (MA-001..MA-016) + `_shared/`, OpenAPI canon `20_architecture/bevox-meta-api/openapi.yaml` (v1.2.0), consumer guide canon, `runtime-topology.md`. **Restrição respeitada:** nenhum arquivo de produto foi modificado — este relatório é o único artefato produzido.
