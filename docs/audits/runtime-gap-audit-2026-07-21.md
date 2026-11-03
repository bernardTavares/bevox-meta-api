# Gap Analysis — bevox-meta-api — 2026-07-21

## Resumo executivo

Estado geral: **V1 em produção servindo `bevox-backend` (piloto MVP Hetzner). Código de produto BYTE-IDÊNTICO desde `dbe9fd6` (2026-06-09) — freeze de 42 dias.** HEAD é `e801d24` (só docs de auditoria desde `5516c2a`); `git diff 5516c2a..HEAD -- src/ db/ k8s/ package.json pnpm-lock.yaml` = **vazio**. Esta é a **5ª auditoria consecutiva contra o mesmo alvo**. Como nas 4 anteriores, **zero achados fecharam por engenharia**. O corpus (87 de 07-04 + net-new de 07-17/07-19/07-20) foi re-derivado do código por **6 auditores independentes** (5 especializados do repo + 1 completeness-critic) e **verificação em primeira mão do orquestrador** — **0 anchor refutado, 0 drift de linha**.

**O valor distintivo desta passada** (o que 07-04/07-17/07-19/07-20 NÃO fizeram):

1. **es-1 sai de "ALTO condicional" para CRÍTICO confirmado-vivo.** As 4 auditorias anteriores hedgearam: *"se `OTEL_EXPORTER_OTLP_ENDPOINT` estiver setado em prod, tratar como CRÍTICO"*. Esta passada **fechou a condição por evidência**: `k8s/configmap.yaml:50` **seta** o endpoint OTLP, consumido por `k8s/deployment-api.yaml:53-54` (`envFrom`), e `src/lib/telemetry.ts:71` ativa a auto-instrumentação OTel exatamente nessa variável. O **secret do Meta App "Bevox Solutions"** (`meta-client.ts:366`, `APP_ID|APP_SECRET` na query string de um GET) + **tokens WABA de cada tenant** são exportados como atributo `url.full` de span ao collector in-cluster, em `http://` claro. O único scrubber (`redactStringSecrets`) só roda no path **Sentry** (`telemetry.ts:179-208`), nunca em spans OTel — e nem casaria a forma `id|secret` se rodasse.
2. **Net-new material de correção de ciclo-de-vida de job outbound** (completeness-critic): N1 (`pool.on error` → `uncaughtException` sem handler → **crash-loop de pod** em failover de Postgres), N2 (double-send do path async — mensagem WhatsApp entregue **duas vezes** ao cliente final em retry/SIGKILL), N3 (drain de shutdown de 10s corta job in-flight de &gt;15s → stalled → redelivery), N4 (job preso em `sending` para sempre em blip de KMS). N2/N3/N4/N1 **compõem** e disparam no **mesmo gatilho** que A5: um blip de infra ou um rollout.
3. **3 correções factuais ao corpus** (delta honesto): (a) o "vetor VIVO de token no worker de refresh" (07-20 #16) **é LATENTE, não vivo** — erros de transporte undici carregam mensagem fixa, o token não chega ao `err.message`; (b) `scripts/seed.ts` **não** vaza `private_key_pem` em prod — é production-guarded (`:29-34`, recusa `NODE_ENV=production`); (c) labels de métrica são **rule-compliant** (`route` templatizado, `app_id` UUID limitado) — não há label de alta cardinalidade viva.
4. **Resolução da questão MA-015/inbound do piloto:** o override de webhook por-WABA **está implementado, wired e fail-closed** (`wabas/service.ts:115`, `:102` "falha aborta antes de persistir"). Isto **rebaixa** o framing da ADR ("WABAs enviam mas não recebem") — o mecanismo funciona; os gaps reais são a ADR ainda `Proposta` apesar de já estar em prod (inversão de processo) e `OAUTH_CALLBACK_BASE_URL` não ser fail-fast no boot (N7).

**Riscos para piloto/GA (ordenados):**

1. **es-1 (CRÍTICO, vivo-em-prod)** — egress do secret do Meta App + tokens ao backend de telemetria. **Gate de verificação de 5 min:** `kubectl -n monitoring get deploy otel-collector` — se o collector existe, os secrets **estão vazando agora**; se não, o egress é incondicional no código e passa a vazar no instante em que um collector subir. **Não** rebaixa por contagem de consumer (é o secret do próprio serviço). Correção ~3-4h.
2. **Classe "perda/corrupção silenciosa + crash em blip de Postgres/Redis"** — A5 (inbound perdido), A5b (inbound sub-entregue), N1 (crash-loop de pod), N2 (double-send async), F2/N1 (`pool.on error` footgun), durabilidade+integridade do audit (I8) + **N8 (CLI admin não audita — o path privilegiado canônico de prod não deixa trilha)**. Todos **compõem com infra-4** (CNPG `instances:1` + Redis `replicas:1`, sem HA → o blip é *quando*, não *se*).
3. **MA-012 (jurídico)** — `Status: Proposta`, bloqueia go-live/onboarding. RoPa **OT-19** nunca publicada. Não fecha por engenharia. Agrava: sua base legal (MA-012 §4 "audit log, retenção, PII redaction — tudo já implementado") é **minada pelos gaps I8/N8/es-1/redação** encontrados.
4. **Governança de qualidade sem rede** — `pnpm lint` = exit 1 (6 problemas idênticos aos de 07-19/07-20) e **sem gate de CI em PR**. Congelado através de 5 auditorias em frente a um piloto vivo.

**Tese central (governança, não descoberta):** o alvo não se moveu por 42 dias e 5 auditorias. **A revisão humana de amanhã deve produzir uma DECISÃO por item — fix, ou aceite-de-risco explícito com mitigação — não mais achados.** Para isso, a **Parte D (Ledger de Decisão)** é o entregável de maior valor desta passada: para cada item congelado, as opções (fix / aceitar-para-piloto-com-nota / não-aceitável) + o risco residual.

> **Nota de confiança.** Ground-truth executado pelo orquestrador (Node **v22.23.1**, HEAD `e801d24`). Fan-out via **Agent tool** (não Workflow), read-only, 6 agentes re-derivando do CÓDIGO (não do relatório anterior), default-cético: `invariants-auditor`, `webhook-hmac-auditor`, `tenant-scope-auditor`, `secrets-redaction-auditor`, `contract-guardian`, + 1 `general-purpose` completeness-critic dirigido às superfícies sub-cobertas (workers/config/health/migration). O orquestrador leu em **primeira mão**: `inbound/service.ts`+`routes.ts`, `db/schema/operations.ts`, `db/client.ts`, `integration/meta-client.ts`, `wabas/service.ts`, `lib/telemetry.ts`, `lib/metrics.ts`, `config/env.ts`, `k8s/*` (configmap/deployment/job-migrate/cnpg/redis/observability), a migration única, o **guia consumer + openapi canônicos**, PRD §9-§15, MA-012, ADR-019/020, runtime-topology. Nenhum arquivo de produto foi modificado.

---

## Parte A — Ground-truth (orquestrador, Node v22.23.1, HEAD e801d24)

| Verificação | Resultado 2026-07-21 | vs 2026-07-20 |
|---|---|---|
| `pnpm typecheck` | **VERDE** (exit 0) | igual |
| `pnpm lint` | **VERMELHO** (exit 1) — `src/lib/queues.ts:174` (`import()` type annotation) + 4 snippets em `skills/bevox-meta-api-consumer/snippets/` (`parserOptions.project`) + `.claude/tmp-gap-audit-workflow.mjs:194` (**artefato de auditoria untracked**, não meu) = **6 problemas** | **igual** (6 problemas byte-idênticos) |
| `pnpm test` (unit) | **443/443 VERDE** (45 arquivos, run limpo, **sem flake** rodado isolado) | igual |
| Cobertura unit | **~69.57%/61.5%/60.88%/72.47%** (não re-medida — código byte-idêntico; cito a medição de 07-20) | byte-idêntica |
| `git diff 5516c2a..HEAD` | só `docs/audits/*` | igual |
| Freeze | **42 dias** (`dbe9fd6` = 2026-06-09) | +1 dia |

- **Sinal de cobertura persistente:** `repository.ts` de **todos** os 12 módulos segue **0% unit**. 07-20 exercitou 2 paths (token/MA-008 + media) em infra real (`test:integration` 9/9); esta passada **não re-rodou** integração (byte-idêntico) mas confirmou por leitura que os predicados de scoping (I3) dos demais repositories seguem verificados só por leitura estática.
- Working tree: 4 untracked não-produto (`.claude/tmp-gap-audit-workflow.mjs` = o 6º erro de lint, artefato de sessão anterior; `docs/superpowers/specs/...`; `scripts/check-meta-app.mjs`; `scripts/provision-bevox-direct-consumer.js`). **Recomendação:** remover o `.mjs` (não-produto) fecha 1/6 do lint.

**Pontos sólidos re-confirmados em primeira mão (não-achados):** I1 UUIDv7 (`db/schema/_shared.ts:73`; `uuid.ts:12` usa `v7` de `uuid@14` — UUIDv7 genuíno); HMAC inbound constant-time **antes** do `JSON.parse` (`inbound/routes.ts:112`→`:120-121`, A4 anti-DoS sólido); MA-008 envelope KEK/DEK + AAD `{tenant_id,app_id,waba_id}`; I11 transações; timeouts em toda chamada Meta (`meta-client.ts:21`, 10s); config fail-fast no boot (`env.ts` superRefine: proíbe KMS local em prod, exige secrets, proíbe log debug, exige TLS no S3); `mediaObjectKey` com guard de path-traversal (`media-storage.ts:46-58`); migration/schema íntegros (1 migration, 16 tabelas = 16 pgTable, sem drift); envelope de erro canônico Bevox (sem RFC7807).

---

## Parte B — Os 3 CRÍTICOs (bloqueiam piloto / vivos em prod) — leitura em primeira mão

### CRÍT-1 · A5 + A5b — perda/sub-entrega silenciosa de inbound em blip de Postgres/Redis
`inbound/service.ts:298` chama `isDuplicate(metaEventId)` (SET NX EX 24h, def. `:184-193`) **antes** de `insertInboundEvent()` em `:324`. Nenhum `del()` compensatório no arquivo. `db/schema/operations.ts:98` usa `index("inbound_events_meta_event_id_idx")` — **não-único** — enquanto `uniqueIndex` está importado (`:18`) e usado logo acima para outbound (`:68`): a escolha é deliberada. **O `SET NX` no Redis é o único dedup.**
- **A5 (perda):** insert lança (blip DB/failover CNPG single-instance) → 5xx → Meta retenta → `isDuplicate=true` → conta `deduplicated` → **200 OK** → evento nunca persistido nem entregue.
- **A5b (sub-entrega):** `listActiveSubscriptions` (`:388`) e o loop `queue.add(...)` (`:402-410`) **NÃO** estão em try/catch (ao contrário do media-enqueue `:362-372` e `publishEvent` `:375-386`, que estão). Se qualquer um lançar após o insert commitado, `processSingle` lança → 5xx → dedup suprime o reprocessamento → deliveries nunca (re)enfileiram.
- **Adjudicação de severidade:** o `invariants-auditor` tentou rebaixar A5 a LOW-MED citando "Redis durável / single WABA / re-delivery normal tratada". **Rejeito o rebaixamento** — esses mitigantes não tocam o mecanismo de A5 (a falha é no **insert Postgres** *depois* da chave Redis reivindicada; nº de WABAs é irrelevante). Mantido **CRÍTICO**. Fix correto: re-drive idempotente de persist+enqueue no caminho de duplicata **ou** confirmar `SET NX` só pós-persist+enqueue (`uniqueIndex` em `meta_event_id` sozinho **não** fecha A5b). **~6h. Bloqueador #1.**

### CRÍT-2 · es-1 — secret do Meta App + tokens de tenant exportados a spans OTel (VIVO EM PROD)
Cadeia verificada ponta-a-ponta em primeira mão:
1. `k8s/deployment-api.yaml:53-54` `envFrom: configMapRef bevox-meta-api-config`.
2. `k8s/configmap.yaml:50` `OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel-collector.monitoring.svc.cluster.local:4318"`.
3. `src/index.ts:23` `await initTelemetry()`; `lib/telemetry.ts:71` `if (cfg.OTEL_EXPORTER_OTLP_ENDPOINT)` → `NodeSDK` com `getNodeAutoInstrumentations` (`:95-101`), **sem** SpanProcessor/scrub. `@opentelemetry/instrumentation-undici` grava `ATTR_URL_FULL` (URL com query) + `ATTR_URL_QUERY` sem redação de query-param.
4. Sinks (`metaGet` monta URL com esses params na query): `meta-client.ts:366` **`access_token=${META_APP_ID}|${META_APP_SECRET}`** (debug_token, na conexão OAuth), `:313-319` `exchangeCode` (`client_secret`+`code`), `access_token=<token de tenant>` em `:391/423/474/498/548/611` (discovery/phone/template/COEX — todo GET Graph).
5. O único scrubber (`redactStringSecrets`) roda só no `beforeSend` do Sentry (`telemetry.ts:179-208`); e nem casaria `client_secret` hex nem a forma `id|secret`.
- **Dado vazado:** `META_APP_SECRET` (app-wide, **compartilhado com o Bevox V1** por memória), `code` OAuth, e o `access_token` WABA de **cada tenant**, em claro (`http://`) ao collector → Tempo/Grafana.
- **Caveat honesto (gate de 5 min):** `k8s/observability/` contém só `servicemonitor/prometheusrule/grafana-dashboard.yaml` — **não há manifesto de otel-collector no repo** (deploy out-of-band no ns `monitoring`). O egress do app é **incondicional** com o endpoint setado; se os spans *aterrissam* depende do collector existir. **Verificar antes:** `kubectl -n monitoring get deploy otel-collector`. Se existe → vazando agora. Se não → passa a vazar no instante em que subir. Dado MA-007 (observabilidade estabelecida), tratar como **CRÍTICO**. Fix ~3-4h (SpanProcessor `onEnd` que apaga `url.full`/`url.query`/`http.url` p/ hosts Meta, **ou** mover secrets da query p/ POST body/header). Scope: só o processo **API** inicia OTel — os workers não, então `fb_exchange_token` do worker de refresh **não** é sink OTel.

### CRÍT-3 · MA-012 — postura LGPD "sub-processador interno" `Status: Proposta`
`$BEVOX_KNOWLEDGE_PATH/30_adr/bevox-meta-api/MA-012-…:3` (`Status: Proposta`), `:7` ("Bloqueia: go-live de produção"), `:200` ("não promover a Aceita sem o documento em mãos"). Critério de Aceita (§177-182): parecer de advogado externo + **RoPa OT-19** (exigida por ADR-020) + PRD §12 atualizado — **nada disso feito**. DSR endpoint `POST /admin/dsr` (PRD §12.4, MA-012 §6) explicitamente **diferido a "iteração 1.1"** e **não implementado**.
- **Impacto:** todo PII (conteúdo de mensagem retido cru em `inbound_events.payload_json` por design de forwarding — `inbound/service.ts:320` `redactSecrets` mantém content/`wa_id`/`profile.name`/E.164, 90d; guia consumer §3.6 confirma), tratado sob declaração unilateral sem parecer.
- **Nuance para o piloto:** README declara `bevox-backend` **coberto pelo MSA** existente — logo MA-012 bloqueia o **carimbo formal de go-live + onboarding de novos consumidores**, e a operação atual é uma **decisão jurídica** (não de engenharia) sobre se a cobertura MSA basta. **Engenharia não fecha; ~24h jurídico.** Porém os **pré-requisitos de engenharia** de MA-012 (audit síncrono/durável I8, DSR endpoint, retenção de audit/tokens) são código real e devem avançar — e hoje **os gaps I8/N8/es-1 minam a própria base legal declarada em MA-012 §4.**

> **Nenhum CRÍTICO refutado.** A5/MA-012 sobrevivem intactos desde 2026-06-02; **es-1 é ELEVADO** de ALTO-condicional a CRÍTICO-vivo por evidência de configmap.

---

## Parte C — Achados por severidade (cobrindo categorias a-l da missão)

### CRÍTICO (bloqueia piloto / vivo em prod)
Ver Parte B: **A5+A5b** (cat. a/h/i), **es-1** (cat. d/j — vivo), **MA-012** (cat. e — jurídico).

### ALTO (bloqueia GA; pilot-HIGH em blip de infra — decidir aceite)

1. **N1/F2 — `pool.on("error")` → `uncaughtException` sem handler → crash-loop de pod** (cat. h) · **NET-NEW sharpening + CONFIRMED [completeness + orq]**
   - `db/client.ts:51-53` `pool.on("error", (err) => process.emit("uncaughtException", err))`. **Nenhum** `process.on("uncaughtException")` no app (só `unhandledRejection` em `index.ts:38`). Em prod (Sentry set, `telemetry.ts:52`), a integração default `onUncaughtException` do `@sentry/node` v10 **termina o processo** → um drop de conexão idle (rotineiro em failover CNPG `instances:1`) **derruba o pod**. Em dev (sem DSN) o emit é **no-op** → erro engolido. O comentário "propagar ao shutdown handler" é **falso**. **~1h** (logar, não re-emitir). Compõe com A5 (o mesmo blip).

2. **N2/F1 — double-send do path async: mensagem WhatsApp entregue DUAS VEZES ao cliente** (cat. a/h/k) · **NET-NEW + CONFIRMED [completeness + orq]**
   - `messages/service.ts:147-222`: `sendMessage` recebe `idempotencyKey` mas só o passa como **valor de coluna** a `insertOutboundJob` (`:191`,`:206`) — **nunca** para short-circuit antes da chamada Meta (`:181-185`); o send precede o insert (`:203`). O worker chama direto (`outbound-dispatcher.ts:101-107`, key `async:${job_id}`), **bypassando o plugin de idempotência HTTP**. Com BullMQ `attempts:5` (`queues.ts:31`), um lost-ack (Meta aceita, 200 perdido → `META_UNAVAILABLE` → re-throw `:133`) ou SIGKILL após send-antes-do-`updateJobStatus` → **reenvio**. WhatsApp Cloud API **não** deduplica no servidor. Variante F1 (07-20): row `failed` da tentativa 1 colide com `sent` da tentativa 2 na key reusada. **~4-6h** (dedup pré-send / `biz_opaque_callback_data`).

3. **I2 — corrida de idempotência read-then-write → envio dobrado (sync)** (cat. a/h) · SURVIVES · **[orq]**
   - `plugins/idempotency.ts:98` `findIdempotencyRecord` e só em `onSend` (`:136`) `saveIdempotencyRecord`. **Sem reserva in-flight** → dois requests concorrentes com a mesma key ambos dão miss → ambos chamam Meta. Record salvo só em 2xx (`:127`); o unique `(app_id, idempotency_key)` (`operations.ts:68`) só pega o **2º persist**, após o 2º send já ter saído. **~4h.**

4. **N3 + N4 — ciclo de vida do job outbound sob shutdown/KMS** (cat. j/h) · **NET-NEW [completeness]**
   - **N3:** `lib/shutdown.ts:45` cap de 10s por hook; `worker.close()` espera in-flight sem bound; pior caso de 1 job (`sendMessage` 10s + `deliverCallback` 5s) ≈ &gt;15s &gt; 10s → hook abortado → job meio-drenado → BullMQ marca stalled → **redelivery/double-process** (compõe N2). `terminationGracePeriodSeconds:30` é folgado; o cap self-imposto de 10s é o problema. **~2h.**
   - **N4:** `outbound-dispatcher.ts:78-85` — `incrementAttempts`+`updateJobStatus("sending")`+`unsealOutboundJobSecrets` rodam **antes** do try (`:100`). Se unseal lança (blip KMS/WIF), o catch que setaria `failed` (`:127`) nunca roda → **DB row preso em `sending` para sempre**; `getMessage` mapeia `sending→"queued"` (`service.ts:317`) → consumer faz poll infinito. Uma outage KMS transitória prende **todo** job in-flight. **~2h.**

5. **Ausência total do fluxo `register` de phone number** (cat. a/g/h) · SURVIVES · **CONFIRMED [orq]**
   - `grep register|request_code|verify_code` em `phone-numbers/`+`wabas/` = **0**. Rotas são só GET-list e POST-profile. O número precisa de `POST /{phone_number_id}/register` antes do 1º envio. **Escala a CRÍTICO se o piloto onboardar número novo/migrado via ES puro.** **~6h.**

6. **es-1 vetor secundário + redação incompleta (LATENTES)** (cat. d/j) · SURVIVES com **CORREÇÃO** · **[secrets + orq]**
   - **CORREÇÃO ao corpus:** o "vetor VIVO de token no worker de refresh" (07-20 #16) é **LATENTE, não vivo** — o secrets-auditor não confirmou path onde um token chega a `err.message` (erros undici carregam msg fixa; 4xx via `mapMetaError` limpo). Continua gap **estrutural**: `serializeErrorRedacted` **não** é `serializers.err` no root logger nem nos 12 sinks `{err}` de worker (`logger.ts:64-94` sem `serializers`). **~1h** fecha todos.
   - `redact()` key-list casa lowercased-exato (`logger.ts:127-143`) — **não** cobre `accessToken`/`privateKeyPem`/`clientSecret`/`client_secret`/`app_secret`/`dek`/`system_user_access_token`. `redact.paths` do Fastify (`server.ts:54-73`) sem wildcard aninhado `*.`. `error.details` cru na response (`error-handler.ts:69`). `Sentry.captureException` extra não-scrubbed (`telemetry.ts:141`, N1-secrets). Todos **LATENTES** (nada loga hoje). **~2h.**

7. **SSRF outbound — 3 sinks sem bloqueio de faixa privada/link-local** (cat. g/h) · SURVIVES · **CONFIRMED [webhook-hmac]**
   - Sink 3 (pior) `outbound-dispatcher.ts:56` `deliverCallback` — `callback_url` é `z.url()` **sem https-only** (`messages/schemas.ts:55`) → aceita `http://169.254.169.254/...`. Sinks 1/2 https-only mas sem guard de IP. undici não segue redirect (sem `maxRedirections`), mas DNS-rebind aplica. NN-3 (hmac): verify-on-create devolve **oracle de resposta** (`webhooks/service.ts:70-71` ecoa `HTTP <status>`/`err.message` em `details.reason`). **Pilot: accept-with-note** (exige consumer malicioso/comprometido — o piloto é same-org, confiável). **GA: HIGH.** **~4h.**

8. **Integridade + durabilidade do audit (I8) + N8 (CLI admin não audita)** (cat. e) · SURVIVES + **NET-NEW** · **CONFIRMED [invariants + completeness + orq]**
   - (a) `X-Tenant-Id` **forjável** — `audit-log.ts:60-61` lê header cru → grava em `audit_logs.tenant_id` (enquanto `app_id` `:89` vem confiável do JWT); (b) durabilidade best-effort — `:82` `void logAudit` + `lib/audit.ts:45-50` catch que só `warn`; (c) **só audita 2xx-3xx** (`:50`) → mutações negadas/falhas **fora** da trilha; (d) `metadata.body` sempre vira `[REDACTED]` (`:93`+`logger.ts:138`) → trilha sem detalhe forense.
   - **N8 (NET-NEW):** o **CLI admin** (`scripts/admin-cli/index.ts`) chama o service layer **direto** (sem HTTP), e o audit é hook `onResponse` (`server.ts:134`); `apps/service.ts` **não** escreve audit. Logo criação de consumer-app, **rotação de private-key**, deactivate e dead-letter replay produzem **zero audit**. Por CLAUDE.md §11 o CLI/in-pod-exec **é** o path admin canônico de prod → **o path privilegiado primário não deixa trilha** (vs §7 audit imutável 5a). **Mina MA-012/ADR-019.** **~2-3h.**

9. **Contrato §3f — `POST /v1/messages` diverge fundamentalmente spec×código** (cat. b/f) · SURVIVES · **CONFIRMED [contract-guardian]**
   - `openapi.yaml:1202-1233` exige `from_phone_number_id` + chaves top-level por tipo, 8 tipos; código (`messages/schemas.ts:28-41`) exige `from` + **chave única `content`** discriminada, só `text|template|image`. **Um cliente gerado do spec dá 400 em todo send** (`content` requerido; 5 dos 8 tipos sem branch). **Ambos** os specs (repo + canon) são o outlier; código+guia concordam. Bloqueia onboarding-via-spec (GA), não o piloto. **~2h.**

10. **rlq-2 — 429 Meta não retentado; sem circuit breaker** (cat. k) · SURVIVES · **CONFIRMED [orq — leitura direta]**
    - `meta-client.ts:261` retenta só `status >= 500 || status === 0`. **429 cai fora** → `META_REJECTED` (terminal) → async morre sem retry. **Nenhum** `circuit|breaker|opossum` em `src/`. Buckets locais (`rate-limit-buckets`) não sincronizados à quota real da Meta, falham-fechado (500) em blip de Redis. **~3h.**

11. **tok-1 / tok-2 — Instagram quebrado** (cat. j) · SURVIVES · **CONFIRMED [orq]**
    - **tok-1** `messages/service.ts:166` `throw errors.internal("Instagram token resolution not yet implemented")` → todo send IG dá 500. **tok-2** `token-refresh.ts:12` WABA-only → tokens IG nunca renovados → expiram em ~60d (MA-008). IG é **fora de escopo V1** (PRD §6) — GA/roadmap.

12. **obs-1/2/3 — métricas declaradas e NUNCA emitidas → painéis/alertas cegos** (cat. k, MA-007) · SURVIVES · **CONFIRMED [orq — grep de call-sites]**
    - `metaRequestDuration` (`metrics.ts:42`), `tokenRefreshTotal` (`:116`), `queueSize` (`:54`) — **0 call-sites** de `.observe/.inc/.set`. As métricas-chave do PRD §13.3 (`meta_call_duration`, `token_refresh_total`, `dead_letter_total`, `delivery_attempts_total`, `outbound_messages_total`) **não existem ou não são emitidas** → os alertas do PRD §13.4 (refresh failures, dead-letter rate, Meta latency) são **cegos**. (Emitidos: `workerJobsTotal` 10×, `metaWebhookReceived/ProcessedTotal`.) **~2h.**

13. **NN-1 (hmac) — inbound HMAC + verify-token são um único secret GLOBAL, não per-Meta-app** (cat. i) · **NET-NEW · CONFIRMED [webhook-hmac]**
    - `verifySignature` lê um env `META_WEBHOOK_APP_SECRET` (`inbound/routes.ts:46,55`; `env.ts:69`); verify-token idem (`:91`). **Não há** coluna `meta_apps.app_secret` (grep = 0). Para o único Meta app do piloto ("Bevox Solutions"), funciona; **um 2º Meta app é bloqueador funcional** (webhooks 401 — Meta assina com secret diferente). Contradiz CLAUDE.md §1 "multi-app". **~1-2d** (modelo per-app + resolução de app antes do HMAC).

14. **lgpd-a15-dsr / lgpd-immutability / retenção incompleta** (cat. e) · SURVIVES · **[orq — canon]**
    - ADR-020 exige `dsr_requests` (5a) + triggers (DSR 30d grace, término 90d cascade) + worker de retenção com métrica `retention_rows_processed_total`. A meta-api **não tem** DSR endpoint/tabela; `audit_logs` **sem** REVOKE/RULE/TRIGGER de imutabilidade (`db/schema/audit.ts:8` "TODO operacional"); `cleanup` toca só `idempotency/inbound/outbound` (`cleanup/repository.ts`), **não** `audit_logs`/tokens superseded/mídia. **~jurídico+eng.**

### MÉDIO (degrada qualidade)

15. **N7 — `OAUTH_CALLBACK_BASE_URL` ausente de `requiredInProd` → boot verde, 500 no 1º onboard WABA/IG** (cat. g/h) · **NET-NEW [completeness + orq]**
    - `config/env.ts:73` `optionalString`, **omitido** de `requiredInProd` (`:183-193`); mas `buildWebhookCallbackUri`/`buildWabaRedirectUri`/`buildIgRedirectUri` lançam `errors.internal` se unset (`meta-client.ts:771-793`), e `subscribeWabaApp` depende dele (`wabas/service.ts:116`). Deploy sem a var **passa readyz** e **500 no 1º connect** — descoberto só no uso. **~0.5h.**

16. **Contrato — drift repo↔canonical OpenAPI (mesmo `1.2.0`) + renomes + handlers-fora-do-spec + skill** (cat. b/f) · **NET-NEW + SURVIVES · CONFIRMED [contract-guardian]**
    - **NET-NEW:** os **dois** `openapi.yaml` (repo + canon `20_architecture/bevox-meta-api/`) declaram `1.2.0` mas divergem em **~178 linhas semânticas** (bidirecional, nenhum é superset): repo-only `/wabas/connect/complete` (ES/COEX); canon-only `/v1/media/{media_key}`+`403`+`messaging_limit_tier`+comentário auto-admitindo drift de `ig/routes.ts`. `package.json:3` diz `0.1.0` (nem bate com o spec). §3b (`events/ack` exige `Idempotency-Key` que o spec omite — **correção:** o spec **declara** o body `event_ids`, ao contrário do afirmado em 07-20). 5 renomes (`id↔event_id`, `secret↔signing_secret`, `current_kid↔current_public_key_id`, `OutboundJob.id↔job_id`, `last_error↔error`). Phantom `/wabas/connect/callback` (spec) vs `/v1/oauth/waba/callback` (real). `delivery_mode` enum over-promised (código `z.literal("push")`; sse/polling **existem** como pull endpoints, nunca modos de subscription — **correção**). Handlers fora do spec repo: `/webhooks/meta`, `/v1/media/:key`, `/admin/apps/:id/deactivate`, `/metrics`. **Skill** `bevox-meta-api-consumer` propaga o phantom callback (NN-1 contract) e omite `deactivate`. **Direção do fix: spec no canon (ADR-005). ~1.5-2d convergência 5-superfícies; a shape de `/v1/messages` sozinha (~2h) tira o maior bloqueador GA.**

17. **N5 — `downloadMedia` buffa resposta inteira sem cap; `MEDIA_MAX_BYTES` é advisory** (cat. h/j) · **NET-NEW [completeness]**
    - `meta-client.ts:750` `Buffer.from(await res.body.arrayBuffer())` sem cap de bytes; o guard é por metadata (`media-download.ts:61` checa `meta.file_size` reportado pela Meta). CDN devolvendo mais que o declarado × `concurrency:10` × `limits.memory:512Mi` → **OOM do pod**. **~2h** (stream com contador de bytes que aborta).

18. **F6 — media-download usa token da PRIMEIRA WABA do tenant** (cat. j) · SURVIVES · corpus · **[orq]**
    - `MediaDownloadJob` carrega só `{app_id,tenant_id,media_id}` (`inbound/service.ts:366`, sem binding de WABA); o worker pega `wabas[0]`. Tenant multi-WABA (MA-004) → mídia da WABA #2 baixada com token da #1 → 401 → descartada → `GET /v1/media/:key` preso em 202. Benigno no piloto single-WABA. **~3h.**

19. **hmac-F4 + F5 — callback async sem anti-replay/opcionalmente sem assinatura + delivery SELECT-then-INSERT** (cat. i/a) · SURVIVES · **CONFIRMED [webhook-hmac]**
    - `outbound-dispatcher.ts:51` assina só o body (sem ts) e header `x-bevox-signature-256` — divergente do canônico `webhook-delivery.ts:71-76` (`t=,v1=`, header `x-bevox-signature`, re-assina no retry): **4 eixos de divergência** (esquema, ts, header-key, provenance do secret). `callback_url`/`callback_secret` opcionais e independentes (`messages/schemas.ts:55-56`, sem `.refine()`) → url sem secret = POST **não-assinado**. F5: `webhookDeliveries` (`operations.ts:144`) sem unique em `(subscription_id, inbound_event_id)`; replay com jobId não-determinístico → entrega dobrada. **~2h cada.**

20. **hmac-a8 — dedup Instagram DESLIGADO** (cat. i) · SURVIVES · **CONFIRMED [webhook-hmac]**
    - `extractMetaEventId` é IG-aware (`inbound/service.ts:161-179`) mas o call-site IG passa `value=undefined` (`:247`) → retorna `null` em `:144` → dedup IG nunca ocorre. Fix de 1 linha. Latente no piloto (WA-first). **~1h.**

21. **Tenancy defense-in-depth (I3)** (cat. a) · SURVIVES · **CONFIRMED [tenant-scope + invariants]**
    - Plugin `tenant-scope` **inexistente** (`patchContext` `request-context.ts:43`, 0 call-sites — o guia §5.5 + CLAUDE.md §4.3 prometem o oposto; `tenant_id` **não** é claim do JWT, vem 100% do header `X-Tenant-Id`). Cross-**app** eficaz (appId do JWT). Gaps: leitura cross-tenant intra-app `findOutboundJob` (`messages/repository.ts:48-55`, `/v1/jobs/:id` sem `tenant_id`); `findTenantById` vaza soft-deleted (`tenants/repository.ts:32`); tenant-a10 (`.limit(1)` sem `orderBy` na resolução por `meta_waba_id`); N1/N2 (tenant): `findInboundEventById`/`findSubscriptionById` sem scope (worker-only, **latentes**). **Pilot: nenhum externamente explorável** (single-tenant/WABA; padrão de referência a copiar: `media/service.ts:34-38` valida `X-Tenant-Id` contra WABA real). **Depende de fato externo:** se `bevox-backend` já provisiona ≥2 tenants, `findOutboundJob` vira defense-in-depth vivo (mas só acessível pelo consumer confiável). **~2h + reconciliação doc/ADR.**

22. **F4 — `phone_numbers.meta_phone_id` unique GLOBAL + upsert não re-parenta** (cat. a) · SURVIVES · **CONFIRMED [tenant-scope rateia ALTO]**
    - `bindings.ts:112` unique em `metaPhoneId` só; `phone-numbers/repository.ts:37-46` `onConflictDoUpdate({target: metaPhoneId})` não reescreve `wabaConnectionId`. Número portado app1→app2 corrompe/leaka o row do 1º dono. **STOP+ADR** (§8, migration). MÉDIO-piloto (consumer único), **ALTO-GA/multi-app**. **~3h + migration.**

23. **N6 / N9 / N11 — readyz sem media-store; webhook sem override de bodyLimit; Redis sem commandTimeout** · **NET-NEW [completeness]**
    - **N6:** `readiness()` (`lib/health.ts:109`) checa PG+Redis+KMS, **não** S3/MinIO → readyz verde com media quebrada. (Positivo: KMS faz roundtrip real, `kms-client.ts:170-191`.) **N9:** `/webhooks/meta` não override o `bodyLimit:1MB` (`server.ts:102`) apesar do comentário → batch Meta &gt;1MB = **413 pré-HMAC** → Meta retenta idêntico → drop. **N11:** `lib/redis.ts:22-24` `enableOfflineQueue:true` sem `commandTimeout` → comandos bufferam ilimitado em blip Redis. **~0.5-1h cada.**

24. **E.164 sem máscara em repouso + over-redaction do audit** (cat. e) · SURVIVES · **[secrets]**
    - `messages/service.ts:177/241` `redact(input.body)` mantém `to` (E.164 do destinatário) em `outbound_jobs.payload_json` (30d). Não retornado por API, não logado — **PII-at-rest only**. **~0.5h** (máscara `+55****1234`).

### BAIXO (higiene)

25. **NEW-lint-1** (`queues.ts:174` vivo + 4 snippets + artefato untracked) = `pnpm lint` exit 1 · SURVIVES · **~1h + remover o `.mjs`.**
26. **N10 — `@types/node@20` vs `engines.node>=22.19` + `@types/uuid@11` vs `uuid@14`** (cat. d) · **NET-NEW** · typecheck contra libtypes de Node 20; `@types/uuid` redundante. **~0.5h.** (Positivo: `uuid.ts:12` usa `v7` real.)
27. **N12 / N13 — cron singletons re-tick no rollout + overlap 2-pod; HPA só na API por CPU (workload é I/O-bound → under-scale); PDB ausente p/ worker-media/tok/cleanup** · **NET-NEW** · comentário "3am UTC" (`cleanup.ts:9`) falso (é boot+24h). **~2h.**
28. **F8 / F7-SSE / JWT-clamp** — `hub.verify_token` `===` não-constant-time (`inbound/routes.ts:91`); fan-out ilimitado de conexões Redis por SSE (`events/routes.ts`); `JWT_MAX_AGE_SECONDS` aceita `.max(900)` (`env.ts:78`) vs I5 ≤300 (default 300, compliant) · SURVIVES/NET-NEW menores.
29. **Doc-drift** — `docs/architecture/consumer-integration-guide-v1.md` e `docs/go-live-checklist.md` **ausentes do repo** (só no canon; MA-012 §Ref linka path inexistente); README "249 testes" vs 443; guia consumer "6 tentativas" vs código default 8 (`inbound/service.ts:397`); PRD §13.3 especifica label `tenant_id` em métrica (contradiz a rule `secrets-never-log.md`); MA-015/MA-016 `Status: Proposta` mas MA-015 **já em prod** (inversão de processo); MA-016 (analytics) **não-implementado** (grep=0; bloqueia sub-projeto Cleanup do bevox-direct, não o piloto). · SURVIVES/NET-NEW menores.

---

## Parte D — LEDGER DE DECISÃO (o entregável para a revisão humana)

Para cada item congelado, a **decisão** que amanhã precisa produzir. Colunas: **Fix** (esforço) · **Aceitar-para-piloto** (o que a nota de risco precisa dizer) · **Não-aceitável**.

| # | Item | Fix | Aceitar p/ piloto? | Risco residual se aceitar |
|---|------|-----|--------------------|---------------------------|
| CRÍT-2 | **es-1** (secret Meta App/tokens → OTel) | ~3-4h | **Só com o gate:** rodar `kubectl -n monitoring get deploy otel-collector`. Se **não** existe → aceitável desligar OTel (unset endpoint) até o fix. Se **existe** → **NÃO aceitável**: secret compartilhado com V1 vazando ao Tempo agora | Se collector up e não desligar: exposição contínua do `META_APP_SECRET` + tokens de tenant a quem lê Grafana/Tempo |
| CRÍT-1 | **A5+A5b** (perda inbound em blip) | ~6h | **Fraco.** Perda é silenciosa e sem reconciliação; produto de mensagens não deveria perder inbound do cliente. Aceitar só com RPO explícito + réplica CNPG **ou** monitor de gap de `meta_event_id` | Mensagem inbound do cliente perdida/não-entregue em cada failover de Postgres; invisível |
| CRÍT-3 | **MA-012** (jurídico) | eng-prereqs ~7h; jurídico ~24h | **Decisão jurídica, não de eng.** README: bevox-backend coberto por MSA → operação atual defensável; onboarding novo **NÃO** | Exposição regulatória residual; base legal minada por I8/N8/es-1 (fix desses é pré-req) |
| ALTO-1 | **N1/F2** (pool→crash-loop) | ~1h | **Aceitável com nota** (recuperável por restart k8s), mas ~1h fecha — **recomendo fix** | Crash-loop de pod em cada failover CNPG single-instance; janela de indisponibilidade |
| ALTO-2 | **N2/F1** (double-send async) | ~4-6h | **Aceitável com nota** se volume async baixo | Cliente final recebe a mesma mensagem 2× em rollout/lost-ack |
| ALTO-3 | **I2** (envio dobrado sync) | ~4h | **Aceitável p/ piloto** — consumer único com key server-minted raramente concorre; unique index limita a 1 dup | Envio duplicado sob concorrência de key idêntica |
| ALTO-4 | **N3+N4** (shutdown/KMS job lifecycle) | ~4h | **Aceitável com nota** | Redelivery em rollout; job preso em `sending` (poll infinito do consumer) em blip KMS |
| ALTO-5 | **register phone** | ~6h | **Só se o piloto NÃO onboardar número novo/migrado.** Confirmar com produto | 1º envio a número novo falha |
| ALTO-8 | **I8+N8** (audit) | ~5h | **Aceitável p/ piloto** (consumer confiável), **mas** é pré-req de MA-012 | Trilha de 5a incompleta/forjável; path admin sem trilha |
| ALTO-7 | **SSRF** | ~4h | **Aceitável** (consumer same-org confiável) | Pivot SSRF na rede k3s **se** o consumer for comprometido |
| ALTO-13 | **NN-1** (secret Meta global) | ~1-2d | **Aceitável** (1 Meta app) | 2º Meta app = webhooks 401 (bloqueador funcional) |
| ALTO-9/16 | **Contrato** (§3f + drift) | ~2h..2d | **Aceitável p/ piloto** (guia-first; bevox-backend não usa codegen) | Onboarding-via-spec (GA) 100% quebrado |
| gov | **lint vermelho + sem CI gate** | ~5h | **Aceitável tecnicamente, mas é a causa-raiz histórica** — recomendo fechar já | Regressão vermelha chega à imagem de prod sem rede |

**Mínimo defensável para o piloto continuar:** decidir **es-1** (gate de 5 min) + fechar **N1** (~1h) + decisão explícita de aceite-de-risco sobre **A5/A5b** (ou fix ~6h) + **N7** (~0.5h, evita 500 no próximo onboard). ~8-13h de engenharia + a decisão jurídica MA-012 (fora de eng) + o gate do collector.

---

## Parte E — Placar das 11 invariantes (CLAUDE.md §4/§5) — 6ª verificação

Leitura do `invariants-auditor` (primária) com adjudicação do orquestrador entre parênteses onde a *garantia* quebra (visão mais estrita para o piloto).

| Inv | Status | Evidência-âncora (HEAD e801d24) |
|---|---|---|
| **I1** UUIDv7 | **PASS** | `db/schema/_shared.ts:73`; `uuid.ts:12` `v7`; zero serial/uuidv4. |
| **I2** Idempotência | **PARTIAL** (orq: FAIL na garantia) | Header enforced no path consumer; mas corrida read-then-write sem reserva (`idempotency.ts:98`→`:136`) + Meta antes do insert (`messages/service.ts:181`) → envio dobrado sync + N2 async. Admin `POST /admin/apps` sem idempotência + `consumer_apps.name` sem unique. |
| **I3** app/tenant-scope | **PARTIAL** | Plugin inexistente; cross-app OK (JWT `iss`); tenant via header. Gaps de def-in-depth (Parte C #21). |
| **I4** tokens fora de log | **FAIL** (se OTel on) | Núcleo sólido (zeroize `token-resolver.ts:62`). FAIL por **es-1** (query→span OTel, VIVO). redact() key-list incompleta (latente). |
| **I5** JWT RS256+kid+TTL | **PASS** (WARN) | `auth-jwt-consumer.ts:93,96,162`. WARN: `env.ts:78` `.max(900)` (default 300). |
| **I6** PII redaction | **PASS** | `logger.ts:136` redige content/text/body; raw inbound nunca logado. |
| **I7** soft-delete | **PARTIAL** | Só `tenancy` tem `deletedAt`; `templates/repository.ts:90` hard `.delete()` (espelho da Meta — atenuante). |
| **I8** audit em mutação | **PARTIAL** (orq: FAIL na durabilidade) | Hook wired; mas tenant forjável, `void logAudit`+swallow, só 2xx-3xx, body `[REDACTED]`, **N8 CLI não audita**. |
| **I9** HMAC webhooks | **PASS** (orq: PARTIAL out) | Inbound constant-time antes do parse (`inbound/routes.ts:58,112`). Outbound: divergência de formato + anti-replay + condicional (#19); SSRF (#7). |
| **I10** multi-WABA | **PARTIAL** | `bindings.ts:57` unique `(tenant_id, meta_waba_id)`. Ressalva: resolução por `meta_waba_id` sem orderBy (tenant-a10) + F6/F4. |
| **I11** transações ≥2 escritas | **PASS** | Toda escrita multi-row em `db.transaction()` (validado em Postgres real por `token-resolver.test.ts` em 07-20). |

---

## Itens-de-fechamento ordenados por valor/esforço (top 10)

| # | Item | Esforço | Destrava |
|---|------|---------|----------|
| 1 | **es-1** — rodar o gate `kubectl -n monitoring get deploy otel-collector`; SpanProcessor que apaga `url.full`/`url.query` p/ hosts Meta (ou mover secrets p/ POST/header) | 5min + ~3-4h | Fecha egress VIVO do secret do Meta App (compartilhado com V1) + tokens ao Tempo |
| 2 | **A5 + A5b** — persist+enqueue idempotentemente re-dirigível (uniqueIndex `meta_event_id` **E** re-drive de deliveries no caminho de duplicata) | ~6h | Bloqueador #1: perda **e** sub-entrega de inbound em blip |
| 3 | **N1/F2** (pool→crash) — logar em vez de `process.emit`; + **N7** (`OAUTH_CALLBACK_BASE_URL` em `requiredInProd`) | ~1.5h | Para o crash-loop em failover **e** o 500 no próximo onboard |
| 4 | **Idempotência atômica (I2) + fim do double-send async (N2/F1)** — reserva `SET NX`/insert-pendente no sync + dedup pré-send + `onConflictDoUpdate` no worker | ~7h | Para envio dobrado sync **e** mensagem duplicada ao cliente no async |
| 5 | **Gate de CI** (`typecheck`+`lint`+`test` em PR) + **lint verde** (`queues.ts:174` + snippets + remover `.mjs`) | ~5h | Impede regressão vermelha na imagem de prod (causa-raiz histórica) |
| 6 | **Durabilidade+integridade do audit (I8) + N8 (CLI audita)** — audit síncrono na txn + validar `X-Tenant-Id` + auditar mutações admin no service | ~5h | Fecha trilha forjável/incompleta (pré-req de MA-012) |
| 7 | **serializeErrorRedacted nos loggers + N3/N4 (job lifecycle)** — `serializers.err` no root; status-writes dentro do try; drain hook 20s | ~4h | Fecha rede de secret em worker (latente) + job preso/redelivery |
| 8 | **SSRF outbound (3 sinks)** — allowlist de host / bloqueio de faixa privada + https-only no `callback_url` | ~4h | Fecha pivot SSRF na rede k3s |
| 9 | **rlq-2 + obs-1/2/3 + hmac-a8** — 429→`RATE_LIMITED` retryable; acender 3 métricas + as do PRD §13.3; dedup IG (1 linha) | ~7h | Para de dropar async em throttle; 4+ painéis/alertas deixam de ser cegos; dedup IG |
| 10 | **Reconciliar contrato** (canon `openapi.yaml`↔código↔guia↔skill: §3f, §3b, callback path, renomes, `delivery_mode`, versão) + **MA-012 + RoPa OT-19** | ~2d + jurídico | Desbloqueia onboarding-via-spec (GA) + go-live legal |

> **Mínimo defensável para o piloto:** #1 (gate+fix) + #3 (~1.5h) + decisão sobre #2 (fix ~6h ou aceite-de-risco de RPO) — ver Ledger. **GA** exige #4-#10 + IG (tok-1/2) + register-phone + E2E real contra Meta sandbox.

---

## Dependências cruzadas

- **MA-012, DSR, imutabilidade+durabilidade do audit (I8/N8), retenção** → advogado externo + RoPa **OT-19** (ADR-019/020). A parte de engenharia (audit síncrono, DSR endpoint/tabela, imutabilidade, cleanup de audit/tokens) é **pré-requisito registral** e hoje está aberta — **os gaps I8/N8/es-1/redação minam a base legal declarada em MA-012 §4** ("tudo já implementado").
- **es-1 / OTEL** → `k8s/configmap.yaml:50` já seta o endpoint; **landing** depende do `otel-collector` no ns `monitoring` (out-of-band, `kubectl -n monitoring get deploy otel-collector`). OTLP em `http://` (não-https) in-cluster.
- **Contrato (§3f, §3b, renomes, drift repo↔canon, skill)** → PRs em `bevox-knowledge` (SoT por ADR-005; §8 "Parar — PR"). Os **dois** `openapi.yaml` estão stale e divergentes; código+guia concordam. **Não mudar** `signing_secret`/`event_id`/formato HMAC `t=,v1=` do webhook-delivery sem coordenar com `bevox-backend`.
- **register de phone number, ES/COEX, IG, MA-015 override** → dependem do **Meta App compartilhado "Bevox Solutions"** + Meta App Review + smoke/e2e contra sandbox. Memória: o webhook a **nível de app** aponta pro V1/chat.example.com; a meta-api depende do **override por-WABA** (`subscribeWabaApp`, já wired) — que por sua vez depende de `OAUTH_CALLBACK_BASE_URL` (N7) + `META_WEBHOOK_VERIFY_TOKEN` corretos em prod + permissão do Meta app. NN-1: secret global → 2º Meta app quebra.
- **A5/A5b, N1, N2, N3, N4, durabilidade do audit, infra-4** → **compõem no mesmo gatilho** (blip de Postgres/Redis, rollout). A decisão de infra (aceitar single-node com RPO explícito **ou** adicionar réplica CNPG/Redis) é a de **maior alavancagem** — muda o *quando* de todos eles.
- **MA-016 (analytics)** → bloqueia sub-projeto **Cleanup** da migração **bevox-direct**, não o piloto atual. **MA-015** → já em prod, ADR a carimbar.

---

## Delta vs auditoria anterior (2026-07-20)

**Código:** BYTE-IDÊNTICO (só docs de auditoria desde `5516c2a`). Logo:

- **FIXED: 0.** Nada fechou por engenharia. Ground-truth idêntico (typecheck verde, lint vermelho 6 problemas, 443/443).
- **SURVIVES: ~todos.** 6ª equipe independente (6 agentes + orq): anchors CRÍTICO/ALTO resolvem na linha citada, **0 refutado, 0 drift**. Placar das 11 invariantes consistente com 07-20 (divergências de leitura PARTIAL↔FAIL registradas, não de fato).
- **ELEVAÇÃO material:** **es-1 sobe de ALTO-condicional a CRÍTICO-confirmado-vivo** — a condição que 07-04/17/19/20 deixaram aberta ("se OTEL setado em prod") está **fechada por evidência** (`configmap.yaml:50` + `deployment-api.yaml:53` + `telemetry.ts:71`), com o caveat honesto do gate do collector.
- **NET-NEW verificado:** **N1** (`pool.on error`→crash-loop de pod), **N2** (double-send async — mensagem 2× ao cliente), **N3** (drain 10s corta job &gt;15s), **N4** (job preso em `sending` em blip KMS), **N7** (`OAUTH_CALLBACK_BASE_URL` não fail-fast → 500 no onboard), **N8** (CLI admin não audita — path privilegiado sem trilha), **N5** (media buffer sem cap→OOM), **N6** (readyz sem media-store), **N9/N11** (bodyLimit webhook / Redis sem commandTimeout), **N10/N12/N13** (types skew / cron overlap / HPA-PDB gaps), **drift repo↔canonical OpenAPI** (178 linhas semânticas, mesmo `1.2.0`), **NN-1 hmac** (secret Meta global).
- **CORREÇÕES ao corpus: 3.** (a) "vetor VIVO de token no worker" (07-20 #16) → **LATENTE**; (b) `seed.ts console.log(private_key_pem)` → **production-guarded** (não-gap); (c) labels de métrica → **rule-compliant** (não-gap). + resolução MA-015 (mecanismo **wired**, rebaixa "bloqueia inbound").
- **Saldo:** o alvo não se moveu por 42 dias e 5 auditorias. O ganho líquido desta é **(1)** a **elevação de es-1 a CRÍTICO-vivo por evidência de manifesto** (o secret compartilhado com V1 está no caminho de egress hoje); **(2)** o **cluster net-new de ciclo-de-vida de job outbound** (N1-N4) que reposiciona a superfície worker/infra como mais frágil sob blip do que registrado; **(3)** **3 correções factuais** que apertam o corpus; e **(4)** o **Ledger de Decisão** — a tradução do corpus congelado em decisões acionáveis. **A tese de 07-20 se mantém e aperta: o gargalo é decisório; agora com um CRÍTICO vivo-em-prod (es-1) a mais.**

---

## Notas de método

**Calibração.** Como em 07-17/19/20, esta passada reconheceu o **código congelado**: re-descoberta do zero tem valor marginal ~nulo. O foco foi **(a)** ground-truth em primeira mão; **(b)** 6ª verificação independente dos anchors de maior severidade **com adjudicação de rebaixamentos** (rejeitei o downgrade de A5; elevei es-1); **(c)** net-new dirigido às superfícies sub-cobertas (workers/config/health/migration via completeness-critic); **(d)** síntese **decisória** (Ledger).

**Orquestração.** Fan-out via **Agent tool**, read-only, 6 agentes via `subagent_type` (`invariants-auditor`, `webhook-hmac-auditor`, `tenant-scope-auditor`, `secrets-redaction-auditor`, `contract-guardian`, `general-purpose` completeness-critic), cada um instruído a **re-derivar do CÓDIGO** (não do relatório anterior), retornar CONFIRMED/REFUTED/DRIFTED com `file:linha` atual, caçar net-new default-cético **e** propor rebaixamentos (aceite-de-risco para o piloto). Verificação adversarial dos candidatos de maior severidade (A5/A5b, es-1 wiring, MA-015 override, obs, migration) feita pelo **orquestrador via leitura direta** — não delegada.

**Leitura direta [orq]** (HEAD e801d24, Node v22.23.1): `inbound/service.ts`+`routes.ts` (A5/A5b/hmac/bodyLimit), `db/schema/operations.ts` (índices), `db/client.ts` (N1/F2), `integration/meta-client.ts` (es-1 sinks/subscribeWabaApp/buildWebhookCallbackUri/429), `wabas/service.ts` (MA-015 wiring), `lib/telemetry.ts`+`lib/metrics.ts` (es-1/obs — grep de call-sites), `config/env.ts` (N7/OTEL/JWT), `k8s/*` (configmap:50, deployment-api:53, job-migrate:48 infra-3, cnpg/redis/observability), a migration única (parity 16=16), o **guia consumer + os dois openapi canônicos** (drift), PRD §9/§12/§13/§15, MA-012, ADR-019/020, runtime-topology.

**Ground-truth [orq]:** `pnpm typecheck` → VERDE; `pnpm lint` → VERMELHO (exit 1, 6 problemas); `pnpm test` → **443/443 VERDE** (run limpo isolado, sem flake). Cobertura **não** re-medida (byte-idêntica).

**Limitações.** (a) `test:integration`/`test:e2e` **não** re-executados (código byte-idêntico; 07-20 rodou integração 9/9). (b) `repository.ts` segue **0% unit** — predicados de scoping (I3) verificados só por leitura estática. (c) **es-1 landing** não confirmado em runtime real (sem acesso a prod nesta sessão) — a cadeia de código+manifesto é prova estática forte; o gate `kubectl -n monitoring get deploy otel-collector` fecha a última milha. (d) O guia consumer e o `go-live-checklist.md` referenciados pela missão **não existem no repo** (só no canon) — usou-se a versão canônica. (e) ADRs MA-001..MA-014 vivem **no canon** (`$BEVOX_KNOWLEDGE_PATH`); só MA-015/016 estão em `docs/adr/` do repo (ambos `Proposta`).

**Restrição respeitada:** nenhum arquivo de produto foi modificado — este relatório é o único artefato produzido.
