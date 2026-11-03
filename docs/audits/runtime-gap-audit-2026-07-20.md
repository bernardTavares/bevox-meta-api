# Gap Analysis — bevox-meta-api — 2026-07-20

## Resumo executivo

Estado geral: **V1 em produção servindo `bevox-backend` (piloto MVP), código de produto BYTE-IDÊNTICO ao das auditorias 2026-07-04, 07-17 e 07-19.** HEAD é `d524810` (só docs de auditoria desde o baseline `5516c2a`); `git diff 5516c2a..HEAD -- src/ db/ k8s/ package.json pnpm-lock.yaml` = **vazio**; nenhuma linha de `src/`/`db/` mudou desde `dbe9fd6` (2026-06-09) — **freeze de 41 dias**. Esta é a **4ª auditoria consecutiva contra o mesmo alvo**. Consequência: **zero achados fecharam por engenharia**; o corpus (87 de 07-04 + net-new de 07-17/07-19) foi re-verificado por uma **5ª equipe independente** (5 auditores especializados do repo + leitura direta do orquestrador de TODOS os anchors CRÍTICO/ALTO) — **0 refutado, 0 drift de linha** — e sobrevive intacto. Os dois CRÍTICOS de piloto (A5/A5b, MA-012) continuam abertos.

**O valor distintivo desta passada** (o que 07-04/07-17/07-19 NÃO fizeram):
1. **Primeira execução dos testes de integração** (`pnpm test:integration`, **9/9 VERDE**, testcontainers Postgres+MinIO reais) — fecha parcialmente o **maior ponto cego residual** que TODAS as auditorias anteriores listaram como limitação: a camada `repository.ts` a 0% de cobertura *unit*. Verificado em infra real: (a) a query de seleção de token ativo **+ envelope encryption MA-008** (`resolveActiveWabaToken`, real Postgres, 4 cenários de ciclo de vida) e (b) o path de media storage IO (real MinIO) — **ambos PASSAM**.
2. **Verificação de 5ª passada, em primeira mão**, de cada anchor CRÍTICO/ALTO na linha atual: A5/A5b, F1, F2, idempotência (I2), integridade de audit (I8), es-1, SSRF, contrato §3f — **0 drift**.
3. **Net-new + correções ao corpus** (abaixo).

**Tese central (governança, não descoberta):** o alvo não se moveu por 41 dias e 4 auditorias. **Um A5/MA-012 conhecido e um `pnpm lint` VERMELHO estão congelados através de 4 auditorias em frente a um piloto vivo.** O gargalo é **decisório/de-processo, não de descoberta**. A revisão humana de amanhã deve produzir uma *decisão* (fix ou aceite explícito de risco), não mais achados.

**Principais riscos para piloto/GA:**
1. **Classe "perda/corrupção silenciosa em blip de Postgres/Redis"** — A5 (inbound perdido), A5b (inbound sub-entregue), durabilidade+integridade do audit (`void logAudit` + swallow; `X-Tenant-Id` forjável no log imutável de 5 anos), F2 (`pool.on("error")` → `process.emit("uncaughtException")` que engole-ou-derruba conforme ambiente). Todos **compõem com infra-4** (CNPG `instances:1` + Redis `replicas:1`, sem HA → o blip é *quando*, não *se*).
2. **"Primeiro envio real do piloto"** — corrida de idempotência read-then-write → envio dobrado (I2), F1 (retry async auto-envenenado → callback `failed` mentiroso), ausência total do fluxo `register` de phone number (1º envio a número novo/migrado falha), rlq-2 (429 Meta → `META_REJECTED` terminal, async perdido).
3. **MA-012 (jurídico)** — `Status: Proposta`, "Bloqueia go-live" — RoPa OT-19 nunca publicada. Não fecha por engenharia.
4. **Governança de qualidade sem rede** — `pnpm lint` = exit 1 (6 problemas idênticos aos de 07-19) e **sem gate de CI em PR**.

**Delta vs 2026-07-19:** **0 FIXED · corpus SURVIVES (5ª verificação, 0 refutado) · net-new material:** contrato **§3f** (o envelope de `POST /v1/messages` — hot path central — diverge fundamentalmente entre spec e código; um cliente gerado do `openapi.yaml` é 100% quebrado), **§3b** (`events/ack` exige `Idempotency-Key` que o spec omite), **hmac-F4** (callback async sem timestamp → sem anti-replay), **hmac-F7** (`callback_url` sem https-only). **1 correção ao corpus:** a métrica `webhook_signature_invalid_total` que a rule chama de "declarada mas não emitida" **É emitida** (como `metaWebhookReceivedTotal{outcome=invalid_signature}`) — o gap real é nome/label, não emissão. **+ 1 net-new de higiene de teste** (timeout flaky sob carga).

> **Nota de confiança.** Ground-truth executado pelo orquestrador (Node **v22.23.1**, HEAD `d524810`). Fan-out via **Agent tool** (não Workflow), read-only: **5 auditores especializados do repo** (`invariants-auditor`, `webhook-hmac-auditor`, `tenant-scope-auditor`, `secrets-redaction-auditor`, `contract-guardian`), cada um instruído a **re-derivar do CÓDIGO** (não do relatório anterior) e default-cético. O orquestrador leu **em primeira mão**: `inbound/service.ts`, `db/client.ts`, `db/schema/operations.ts`, `messages/service.ts`, `messages/schemas.ts`, `workers/outbound-dispatcher.ts`, `workers/token-refresh.ts`, `plugins/idempotency.ts`, `plugins/audit-log.ts`, `lib/audit.ts`, `lib/telemetry.ts`, `lib/metrics.ts`, `k8s/*`, os 2 testes de integração, o **guia consumer canônico** e os ADRs canônicos (MA-008/012, ADR-019/020/021). Nenhum arquivo de produto foi modificado.

---

## Parte A — Ground-truth (executado pelo orquestrador, Node v22.23.1, HEAD d524810)

| Verificação | Resultado 2026-07-20 | vs 2026-07-19 |
|---|---|---|
| `pnpm typecheck` | **VERDE** (exit 0) | igual |
| `pnpm lint` | **VERMELHO** (exit 1) — `src/lib/queues.ts:174` (`import()` type annotation) + 4 snippets em `skills/bevox-meta-api-consumer/snippets/` (`parserOptions.project`) + `.claude/tmp-gap-audit-workflow.mjs:194` (**artefato de auditoria untracked**) = **6 problemas** | **igual** |
| `pnpm test` (unit + coverage) | **443/443 VERDE** (run limpo, 45 arquivos). Numa 1ª run sob carga concorrente 1 teste deu timeout — passa isolado/limpo 8/8; ver td-flaky | igual (07-19 = 443/443) |
| **`pnpm test:integration`** | **9/9 VERDE** (2 arquivos: `media-flow` 5, `token-resolver` 4; testcontainers Postgres+MinIO) | **NUNCA executado antes** |
| Cobertura unit (medida esta passada) | **69.57% stmt / 61.5% branch / 60.88% func / 72.47% line** | **byte-idêntica** |

- `git diff --name-only 5516c2a..HEAD` = só `docs/audits/*`. Working tree: 4 untracked não-produto (`.claude/tmp-gap-audit-workflow.mjs` = o 6º erro de lint; `docs/superpowers/specs/...`; `scripts/check-meta-app.mjs`; `scripts/provision-bevox-direct-consumer.js`).
- **Sinais de cobertura persistentes (o "onde não se olha"):** `repository.ts` de **TODOS** os 12 módulos segue **0% unit**. Esta passada **exercitou dois desses paths em infra real** pela 1ª vez (token-resolver + media). O resto continua verificado só por leitura estática.

**Pontos sólidos re-confirmados em primeira mão (não-achados):** I1 UUIDv7 (`db/schema/_shared.ts`); I5 JWT RS256+kid+TTL≤300s; I6 conteúdo de mensagem redigido (`logger.ts`); **HMAC inbound constant-time ANTES do `JSON.parse`** (validação `inbound/routes.ts:112`, parse `:121` — A4 anti-DoS sólido); **MA-008 envelope encryption round-trip validado em Postgres real** (`token-resolver.test.ts`, KEK/DEK + AAD `{tenant_id,app_id,waba_id}`); I11 transações no persist (`wabas/repository.ts` em `db.transaction()`); **envelope de erro canônico Bevox em todo path** (`{error:{code,message,details?,request_id}}` — enum idêntico ao spec, **sem RFC7807**, `contract-guardian` PASS).

---

## Parte B — Os 2 CRÍTICOS (bloqueiam piloto) — lidos em primeira mão, HEAD d524810

**A5 — dedup `SET NX` reivindica a chave ANTES de persistir o `InboundEvent`; `meta_event_id` sem `uniqueIndex`; sem `del()` compensatório → perda silenciosa e permanente de inbound em qualquer blip de Postgres** · SURVIVES · **[orq — leitura direta]**
- Ev.: `inbound/service.ts:298` chama `isDuplicate()` (SET NX EX 24h, def. `:184-194`) **antes** de `insertInboundEvent()` em `:324`. Nenhum `del()` no arquivo. `db/schema/operations.ts:98` usa `index("inbound_events_meta_event_id_idx")` — **não-único** — enquanto `uniqueIndex` está importado (`:18`) e usado logo acima para outbound (`:68`, `outbound_jobs_app_idempotency_uniq`): a escolha é deliberada. Logo o `SET NX` no Redis é o **único** dedup.
- Falha: insert lança (blip DB/pool/failover CNPG single-instance) → 5xx → Meta retenta → `isDuplicate=true` → conta `deduplicated` → **200 OK** → evento nunca persistido nem entregue. **~4h** (fix ingênuo) — **insuficiente sozinho, ver A5b.**

**A5b (ALTO, aprofunda A5) — enqueue não-atômico após o `SET NX`: mesmo com insert bem-sucedido, um blip nos passos seguintes deixa o evento persistido mas PERMANENTEMENTE sem entrega** · SURVIVES · **CONFIRMED em primeira mão + webhook-hmac-auditor (F1)**
- Ev.: em `inbound/service.ts`, os efeitos best-effort **estão** guardados em try/catch — `disconnectWabaByMetaWabaId` (`:347-358`), media-enqueue (`:363-372`), `publishEvent` (`:375-386`). Mas `listActiveSubscriptions(...)` (`:388`) e o loop `queue.add(...)` (`:402-410`) **NÃO estão**. Se qualquer um lançar (blip Redis/BullMQ/Postgres), `processSingle` lança → 5xx → Meta retenta → o `SET NX` de `:298` faz `isDuplicate=true` → **200 OK** → as deliveries daquele evento nunca (re)enfileiram. O `jobId` idempotente `${sub.id}:${event.id}` (`:409`) nunca tem chance porque o dedup suprime o reprocessamento.
- **Prova que `uniqueIndex` em `meta_event_id` sozinho NÃO fecha o A5** — resolve "insert falha", não "enqueue falha após insert commitado". Fix correto: re-dirigir idempotentemente persist+enqueue no caminho de duplicata, **ou** confirmar o `SET NX` só após persist+enqueue completos. **Esforço combinado A5+A5b: ~6h. Bloqueador #1 do piloto.**

**MA-012 — postura LGPD "sub-processador interno" `Status: Proposta` → bloqueia onboarding/produção** · SURVIVES · jurídico · **[orq — leitura do canon]**
- Ev.: `$BEVOX_KNOWLEDGE_PATH/30_adr/bevox-meta-api/MA-012-…:3` (`Status: Proposta`), `:7` ("Bloqueia: go-live de produção"), `:134` ("declaração unilateral. Bloqueia go-live"), `:200` ("não promover a Aceita sem o documento em mãos"). RoPa **OT-19** (exigida por ADR-020) nunca publicada.
- Impacto: todo PII (conteúdo de mensagem retido cru em `inbound_events.payload_json` por design de forwarding — o guia consumer §3.6 confirma que `data.messages[0]` com body/caption é encaminhado; E.164; mídia) tratado sob declaração unilateral sem parecer externo. README atenua (bevox-backend coberto por MSA) mas não fecha a lacuna registral. **~24h jurídico. Engenharia não fecha.**

> **Nenhum CRÍTICO novo.** A5/MA-012 sobrevivem intactos desde 2026-06-02.

---

## Parte C — Achados por severidade (cobrindo categorias a-l da missão)

### CRÍTICO (bloqueia piloto)
Ver Parte B: **A5+A5b** (categoria i/h/a — webhook inbound), **MA-012** (categoria e — LGPD).

### ALTO (bloqueia GA, não bloqueia piloto; alguns escalam a CRÍTICO conforme o piloto)

1. **Corrida de idempotência read-then-write → envio dobrado** (I2, categoria a/h) · SURVIVES · **[orq]**
   - Ev.: `plugins/idempotency.ts:98` faz `findIdempotencyRecord` e só em `onSend` (`:136`) `saveIdempotencyRecord`. **Sem reserva in-flight** (sem `SET NX`/insert pendente) entre `:98` e `:136` → dois requests concorrentes com a mesma key ambos dão miss → ambos chamam Meta → **envio dobrado**. Record salvo só em 2xx (`:127`) → send que a Meta recebeu-mas-errou não é cacheado → retry re-envia. Save-failure engolido (`:147`). **~4h.**

2. **F1 — retry da fila async auto-envenenado: o row `failed` (tentativa 1) colide com o `sent` (tentativa 2) na idempotency-key `async:<job_id>` reusada → mensagem ENTREGUE reportada como `failed`, callback `failed`, consumer reenvia** (categoria a/h/k) · SURVIVES · **CONFIRMED [orq leitura direta]**
   - Ev.: `outbound-dispatcher.ts:105` usa `idempotencyKey: async:${payload.job_id}` (estável entre retries). Em `messages/service.ts`, o catch (`:186-201`) insere row `failed` com essa key **e re-lança**; o sucesso (`:203-214`) insere `sent` com a mesma key. Unique `(app_id, idempotency_key)` (`operations.ts:68`); `insertOutboundJob` sem `onConflict`. Timeout após Meta receber → tentativa 1 grava `failed` → tentativa 2 reenvia (envio dobrado) + tenta `sent` → **violação de unique FORA do try de `sendMessage`** → dispatcher captura em `:121` → `INTERNAL` **não-retryable** (`:123-131`) → grava `failed` + callback `failed` (`:138-148`). Variante: 2ª falha na Meta também colide no `failed` → morre `INTERNAL` antes das tentativas 3-5 → **retry async quebrado após a 1ª falha transitória.** **~3h.**

3. **es-1 — secret/token na query string das chamadas Meta → spans OTel exportados sem scrubber** (I4, categoria d/j) · SURVIVES · **CONFIRMED [orq + secrets-redaction-auditor, que classifica como CRÍTICO]**
   - Ev.: `lib/telemetry.ts:95-101` só tem scrubber no path **Sentry** (`beforeSend: scrubSentryEvent`, `:65`,`:166`). NÃO há span-processor/atributo scrub para a auto-instrumentation OTel (`@opentelemetry/auto-instrumentations-node`) → spans de HTTP client (undici) exportam a URL **completa com query** em claro ao OTLP/Tempo. Sinks vivos precisos (só o processo **API** inicia OTel): `meta-client.ts:313-319` `exchangeCode` (`client_secret`+`code`), `:364-367` `debug_token` (`input_token`=token do usuário + `access_token`=`APP_ID|APP_SECRET`), + `access_token=` na query em `:391/:423/:474/:498/:548/:611`. Agrava: `redactStringSecrets` casa `EAA…`/`eyJ…`/Bearer mas **não** `client_secret` hex → mesmo um `responseHook` de scrub não bastaria; melhor **apagar** `url.full`/`url.query` para hosts Meta. OTLP endpoint não é forçado a `https://` em prod (`config/env.ts`). **Divergência de severidade honesta:** o secrets-auditor rateia CRÍTICO (egress de app-secret ao backend de telemetria); mantido aqui como ALTO condicionado a OTel estar wired em prod (MA-007) — **se `OTEL_EXPORTER_OTLP_ENDPOINT` estiver setado em prod, tratar como CRÍTICO**. **~3h** (SpanProcessor `onEnd` que apaga `url.full`/`url.query`/`http.url` p/ Meta).

4. **Ausência total do fluxo `register` de phone number** (categoria a/g/h) · SURVIVES · **CONFIRMED [orq]**
   - Ev.: `grep register|request_code|verify_code` em `phone-numbers/`+`wabas/` = **0**. Rotas de `phone-numbers/routes.ts` são só GET-list (`:12`) e POST-profile (`:25`). O número precisa de `POST /{phone_number_id}/register` na Cloud API antes do 1º envio; a meta-api não expõe isso. **Escala a CRÍTICO se o piloto onboardar número novo/migrado via Embedded Signup puro.** **~6h.**

5. **hmac-a8 — dedup Instagram DESLIGADO em produção** (I9, categoria i) · SURVIVES · **CONFIRMED [orq + webhook-hmac-auditor]**
   - Ev.: a função pura `extractMetaEventId` **é** IG-aware (`inbound/service.ts:161-179`), MAS o call-site IG passa `value=undefined` (`:247`) → `extractMetaEventId(field=undefined, value=undefined)` retorna `null` em `:145` antes da lógica IG → dedup IG nunca ocorre → re-deliveries da Meta entram duplicadas. Fix de 1 linha (passar `{messaging}` como `value`). **~1h.**

6. **SSRF outbound — 3 sinks sem bloqueio de faixa privada/link-local** (I9, categoria g/h) · SURVIVES · **CONFIRMED [webhook-hmac-auditor]**
   - Ev.: nenhum guard de IP privado/rebinding em `src/`. Sink 1 `webhooks/service.ts:63/110` (verify na criação; https por schema). Sink 2 `webhook-delivery.ts:90` (só `startsWith("https://")` em `:138`). **Sink 3 (pior)** `outbound-dispatcher.ts:56` `deliverCallback` — `callback_url` é `z.url()` **sem https-only** (`messages/schemas.ts:55`) → aceita `http://169.254.169.254/...`, URL controlada pelo consumer, disparada de dentro do pod k3s. **~4h.**

7. **Integridade + durabilidade da trilha de audit** (I8, categoria e) · SURVIVES · **CONFIRMED [orq]**
   - Ev.: (a) **`X-Tenant-Id` forjável** — `audit-log.ts:60-61` lê o header cru → `:88` grava em `audit_logs.tenant_id` (enquanto `app_id` `:89` vem confiável de `req.auth`) → atribuição errada no log "imutável" de 5 anos; (b) **durabilidade best-effort** — `audit-log.ts:82` `void logAudit` (fire-and-forget no `onResponse`) + `lib/audit.ts:45-50` catch que só faz `warn` e engole → blip de DB perde a entrada, request segue 2xx; (c) o próprio docstring admite (`audit.ts:8-11`) "audit é best-effort... integridade total só com transação". Isto **mina diretamente a base legal do ADR-019/020** (audit_events = obrigação legal art. 37, retenção 5 anos executável). **~3h.**

8. **F2 — `pool.on("error")` do Postgres é footgun: engole falha de failover nos workers, DERRUBA a API-com-Sentry sem drain** (categoria h) · SURVIVES · **CONFIRMED [orq]**
   - Ev.: `db/client.ts:51-53` `pool.on("error", (err) => { process.emit("uncaughtException", err); })`. Sem listener `uncaughtException` no app (só `unhandledRejection` em `index.ts`) → `process.emit` é **no-op** sem Sentry; com Sentry (prod, `initTelemetry`) a integração `onUncaughtException` **termina o processo sem drain**. O comentário "propagar ao shutdown handler" (`:49-50`) é **falso**. Failover CNPG single-instance é rotineiro (infra-4). **~2h.**

9. **Contrato §3f — `POST /v1/messages` (hot path central) diverge fundamentalmente spec×código** (categoria b/f) · **NET-NEW · CONFIRMED [contract-guardian]**
   - Ev.: `openapi.yaml:1208-1233` exige `from_phone_number_id` + chaves top-level por tipo (`text:{body}`, `template`, `media`, `interactive`) em 8 tipos; o código (`messages/schemas.ts:28-45`) exige `from` + **chave única `content`** discriminada por `type`, só `text|template|image`. **Um cliente gerado do spec falha 100% no endpoint primário.** Direção: **código+guia consumer concordam** (guia §3.2 mostra `{channel,to,type,...}`), **`openapi.yaml` é o outlier stale**. Bloqueia onboarding-via-spec (GA), não o piloto (bevox-backend usa a shape do código). **~2h doc-sync + decisão.**

10. **rlq-2 — 429 Meta não é retentado; sem circuit breaker** (categoria k) · SURVIVES · **CONFIRMED [orq]**
    - Ev.: `meta-client.ts:261` retenta só `status >= 500 || status === 0`. **429 cai fora** → mapeado a `META_REJECTED` (terminal) → no async, job morre sem retry. **Nenhum circuit breaker em `src/`** (grep `circuit|breaker|opossum` = 0). O rate-limit de 3 camadas (`rate-limit-buckets.ts`) é bucket **local**, não sincronizado à quota real da Meta, e falha-fechado (500) em blip de Redis. **~3h** (429→`RATE_LIMITED` retryable + `Retry-After`).

11. **tok-1 / tok-2 — Instagram quebrado** (categoria j) · SURVIVES · **CONFIRMED [orq]**
    - Ev.: **tok-1** `messages/service.ts:166` `throw errors.internal("Instagram token resolution not yet implemented")` → todo send IG dá 500. **tok-2** `token-refresh.ts:12` "V1: apenas WABA"; imports WABA-only → **tokens IG nunca renovados** → expiram em ~60d (MA-008 §11) → IG quebra silenciosamente. **~roadmap IG.**

12. **obs-1/2/3 — 3 métricas declaradas e NUNCA emitidas → painéis/alertas cegos** (categoria k, MA-007) · SURVIVES · **CONFIRMED [orq — grep de call-sites]**
    - Ev.: `metaRequestDuration` (`metrics.ts:42`), `tokenRefreshTotal` (`:116`), `queueSize` (`:54`) — **0 call-sites** de `.observe()`/`.inc()`/`.set()` fora de metrics.ts. Latência Meta, sucesso/falha de refresh e profundidade de fila são invisíveis. (Nota: `workerJobsTotal` **é** usado, 10 call-sites; `metaWebhookReceived/ProcessedTotal` **são** emitidos — ver correção F9 na Parte E.) **~2h.**

13. **lgpd-a15-dsr / lgpd-immutability** (categoria e) · SURVIVES · **[orq — canon]**
    - Ev.: ADR-020 exige entidade `dsr_requests` (retenção 5a) + triggers de deleção (DSR 30d grace, término de contrato 90d cascade). A meta-api **não tem** endpoint/tabela DSR (`listMediaKeys()` sem caller). `audit_logs` **sem** REVOKE/RULE/TRIGGER de imutabilidade (`audit.ts` admite "TODO operacional") vs exigência de accountability. **~jurídico+eng.**

14. **coex-1 — WABA compartilhável entre tenants sem unicidade global** (categoria a) · SURVIVES · corpus. **cov-3 — sem gate de CI** (só `build-image.yml` em push:main; `pnpm lint` vermelho chega à imagem de prod) · SURVIVES · **[orq] ~4h.**

### MÉDIO (degrada qualidade)

15. **Cobertura do helper `redact()` diverge da rule `secrets-never-log.md`: chaves camelCase/compostas não cobertas + `redact.paths` do Fastify sem wildcard aninhado** (I4/I6, categoria d) · SURVIVES · **CONFIRMED [orq + secrets-redaction-auditor]**
    - Ev.: `lib/logger.ts:127-143` (`REDACT_KEY_NAMES`/`SECRET_KEY_NAMES`) casa chave por match exato lowercased — cobre `access_token`/`secret` mas **não** `accessToken`, `privateKeyPem`, `clientSecret`, `hmacSecret`, `appSecret`, `dek`, `kms_key_material`, nem os compostos `client_secret`/`app_secret`/`system_user_access_token`/`long_lived_token` que a rule enumera (`client_secret` não é substring de `secret`). O código usa as formas camelCase pervasivamente (`token.accessToken` em `messages/service.ts:183`). **NET-NEW (secrets):** o `redact.paths` do logger **Fastify** (`bootstrap/server.ts:54-73`) usa paths top-level (`access_token`), **sem** `*.access_token` aninhado que o root logger tem → secret aninhado (`{conn:{access_token}}`) num `req.log`/`app.log` vaza. **Latente** (nada loga hoje), mas a rede não cobre o que a rule manda. Fix: match por regex/substring + wildcards aninhados + unificar os dois configs de redact. **~2h.**

16. **`serializeErrorRedacted` não fiado como `serializers.err` no root logger nem nos workers → vetor VIVO de token no worker de refresh** (I4, categoria d/j) · SURVIVES · **[orq + secrets]**
    - Ev.: o scrubber de token em `err.message`/`stack`/`cause` só está no `error-handler.ts`; o root `lib/logger.ts` e os workers não têm `serializers.err`. `token-refresh.ts` `logger().error({ err })` envolve `exchangeLongLivedToken` que põe `fb_exchange_token=<token>` na URL (`meta-client.ts`) → erro undici que ecoe a URL vaza o token de refresh em claro. Mesmo gap em `outbound-dispatcher.ts:172`, `webhook-delivery.ts`, `cleanup.ts`, `media-download.ts`. Fix único: fiar `serializeErrorRedacted` nos dois loggers. **~1h.**

17. **hmac-F4 — callback async sem timestamp no string-to-sign → sem anti-replay; e sem assinatura se secret omitido** (I9) · **NET-NEW · CONFIRMED [webhook-hmac-auditor + invariants-auditor NN2]**
    - Ev.: `outbound-dispatcher.ts:51` assina só o `body` (`createHmac(...).update(body)`) e envia `x-bevox-signature-256: sha256=<hex>` (`:52`) — divergente do webhook-delivery canônico `t=<ts>,v1=<hex>` (`webhook-delivery.ts:71-76,94`, que **tem** ts e re-assina no retry) E **sem timestamp** → replayable. Além disso `callback_url` e `callback_secret` são opcionais **e independentes** em `messages/schemas.ts:55-56` (sem `.refine()` acoplando os dois) → um consumer que registra `callback_url` sem `callback_secret` recebe POST **não-assinado** (`:50` `if (secret)`), violando I9 "sem HMAC = drop" (mitigado: opt-out do consumer, só metadata de status). **~2h** (unificar formato `t=,v1=` + `.refine()` exigindo secret quando há url, ou documentar opt-out).

18. **F5 — `findOrCreateDelivery` SELECT-then-INSERT sem unique index → entrega dobrada no replay** (I11, categoria a) · SURVIVES · corpus
    - Ev.: `webhooks/repository.ts` SELECT depois INSERT sem txn; `webhookDeliveries` (`operations.ts:144`) só tem `index()` (`:163`,`:167`), **sem unique** em `(subscription_id, inbound_event_id)`. `replayDeadLetters` enfileira com jobId não-determinístico `replay:${r.id}:${Date.now()}` → dois replays do mesmo `(sub,event)` → BullMQ não deduplica → consumer recebe 2×. **~2h.**

19. **F6 — media-download usa o token da PRIMEIRA WABA do tenant** (I10, categoria j) · SURVIVES · corpus
    - Ev.: `MediaDownloadJob` carrega só `{app_id,tenant_id,media_id}` (`inbound/service.ts:366`, sem binding de WABA); o worker pega `wabas[0]` (`media-download.ts`). Tenant multi-WABA (MA-004) → mídia da WABA #2 baixada com token da WABA #1 → 401 → após 4 tentativas descartada → `GET /v1/media/:key` preso em 202 (o guia §3.6 promete 202="retry"). Benigno no piloto single-WABA. **~3h.**

20. **Contrato §3b — `events/ack` exige `Idempotency-Key` (I2) que o spec omite; devolve `200 {acked,requested}` vs `204` no-body** (categoria b/f) · **NET-NEW · CONFIRMED [contract-guardian]**
    - Ev.: `events/routes.ts:190` `requireIdempotency()` → sem o header, 400 (`idempotency.ts:90-95`); `openapi.yaml:760-778` não declara o parâmetro nem o body → **cliente spec-conforme rejeitado 400**. Direção: código+guia (§3.4c mostra a key) corretos; spec stale. **~1h.**

21. **Tenancy defense-in-depth — família de UPDATE/SELECT sem `app_id`, + leitura cross-tenant intra-app** (I3, categoria a) · SURVIVES · **CONFIRMED [tenant-scope-auditor + invariants-auditor + orq]**
    - Ev. (corpus re-anchorado): `markWabaDisconnected`/`reconnectWaba` (`wabas/repository.ts:255-266`), `reconnectIg` (`ig/repository.ts:81`), `disconnectWabaByMetaWabaId` (`:187-203`), `find*ByTenantAndMetaId` (`wabas:96-106`,`ig:69-79`) — UPDATE/SELECT sem `app_id` embora a coluna exista; tenant-a10 (resolução inbound por `meta_waba_id` com `.limit(1)` **sem `orderBy`** → em colisão `(tenant_id, meta_waba_id)`, evento inbound com conteúdo atribuído/entregue a tenant arbitrário). **NET-NEW (tenant #9): leitura cross-tenant DENTRO do app** — `findOutboundJob` (`messages/repository.ts:48-55`) filtra só `app_id`, não `tenant_id`; `GET /v1/messages/:id` e `/v1/jobs/:id` retornam status/`provider_message_id`/`last_error` de outro tenant do mesmo app por UUIDv7 (isolamento tenant não é fronteira, só app é). **NET-NEW (tenant #8): `getTenant` vaza tenant soft-deleted** — `findTenantById` (`tenants/repository.ts:32`) não filtra `deleted_at` (ao contrário de `findTenantByExternalId:49`). **Benigno hoje** (callers usam id server-minted/preciso; modelo "app dono de todos os seus tenants"), MÉDIO por defense-in-depth. O plugin `tenant-scope` que o guia consumer promete (§5.5) e CLAUDE.md §4.3 afirmam **não existe** (`patchContext` 0 call-sites, `request-context.ts:43`) — I3 é PARTIAL, não a garantia absoluta anunciada ao consumer. **~2h + reconciliação de doc/ADR.**

22. **F4 — `phone_numbers.meta_phone_id` unique GLOBAL (sem `app_id`) + upsert não re-parenta → corrupção/leak cross-app + tenant B não envia** (I3/I10) · SURVIVES · **CONFIRMED [tenant-scope-auditor rateia ALTO]**
    - Ev.: `bindings.ts:112` unique em `metaPhoneId` sozinho; `phone-numbers/repository.ts:37-46` `onConflictDoUpdate({target: metaPhoneId})` atualiza display/quality mas **não reescreve `wabaConnectionId`**. Número portado app1/tenantA → re-onboardado app2/tenantB: o upsert de B (que valida corretamente `findWabaConnectionById(app2,tenantB,wabaB)`) bate no row de A via ON CONFLICT, sobrescreve `display_phone_number`/`verified_name` de A com valores de B, mantém `waba_connection_id=wabaA`, e o `.returning()` entrega a B um row cujo `waba_connection_id` pertence a **app-1/tenant-A** → leak cross-app de `waba_connection_id`+`verified_name` + corrupção do row de A + tenant B "no phone_numbers synced". **Divergência de severidade honesta:** o tenant-scope-auditor rateia **ALTO** (é o único da família de scoping disparável por sequência **operacional realista** — porte de número — não por input forjado); mantido MÉDIO **para o piloto** (consumer único → sem colisão cross-app; colisão cross-tenant intra-app é rara), mas **ALTO para GA/multi-app**. Fix: unique `(waba_connection_id, meta_phone_id)` ou incluir `waba_connection_id` no SET. **~3h.**

23. **Superfície ES/COEX + contrato residual + over-redaction do audit + E.164 sem máscara** (categorias b/f/e) · SURVIVES · corpus
    - es-2/3/4/5, coex-2/3/4, inv-es-1/2, tok-4/5, obs-4; **cg residual**: phantom `wabas/connect/callback` (`openapi.yaml:237`) vs real `/v1/oauth/waba/callback` (`wabas/routes.ts:68`); handlers fora do spec (`/webhooks/meta`, `/v1/media/:key`, `/admin/apps/:id/deactivate`, `/metrics`); renomes `id`↔`event_id`, `secret`↔`signing_secret`, `current_kid`↔`current_public_key_id`, `OutboundJob.id`↔`job_id`/`last_error`↔`error`; `delivery_mode` enum `[push,sse,polling]` over-promised (código só `push`); `phone_id` tipado `uuid` no spec mas é meta id string. `info.version 1.2.0` não descreve o runtime. Over-redaction: `audit-log.ts:93` `body` inteiro → redact() pode virar `[REDACTED]` (perde valor forense). E.164 sem máscara em `outbound_jobs.payload_json` (`messages/service.ts:177`, 30d).

24. **Robustez inbound + infra + cleanup LGPD** (categorias g/h/e) · SURVIVES · corpus
    - `/webhooks/meta` sem rate-limit/allowlist; `bodyLimit 1MB` → 413 pré-HMAC no history-sync COEX; **infra-2** (tag mutável `deployment-api.yaml:49` `:dbe9fd6` + `imagePullPolicy: Never`), **infra-3** (`job-migrate.yaml:48` org+tag divergentes `ghcr.io/bevox/…migrator-5706afe` vs runtime `bernardTavares/…dbe9fd6` — **falha de migrate no go-live com `pullPolicy: Never` se a imagem exata não estiver importada**), **infra-4** (CNPG `instances:1` + Redis `replicas:1`), **infra-6/7**; hmac-desub (`disconnectWaba` sem `DELETE /subscribed_apps`); cleanup não toca `audit_logs`/tokens superseded/mídia (lgpd-a21/a22/media).

### BAIXO (higiene)

25. **NEW-lint-1** (`queues.ts:174` **vivo**) + 4 snippets + artefato untracked = `pnpm lint` exit 1 · SURVIVES · **[orq] ~1h.**
26. **hmac-F7 / F8** — `callback_url` sem https-only (`messages/schemas.ts:55`); `hub.verify_token` compara com `===` não constant-time (`inbound/routes.ts:91`) · F7 NET-NEW / F8 SURVIVES · **[webhook-hmac-auditor].**
27. **F7-SSE / F8-JWT** (corpus) — fan-out ilimitado de conexões Redis por SSE (`events/routes.ts:89`); `JWT_MAX_AGE_SECONDS` aceita 900s sem clamp em prod (`config/env.ts:78`, contra I5 ≤300s) · SURVIVES.
28. **td-flaky (NET-NEW)** — `extract-meta-event-id-ig.test.ts` usa `await import()` dentro de cada `it()` com timeout default 5s; sob carga concorrente (coverage + integração + agentes) o import a frio excede 5s → timeout. Isolado passa 8/8 em 763ms. **Não é regressão de código; é fragilidade de teste** (compõe com cov-3: um CI carregado vira flaky). **~0.5h** (elevar timeout / import estático no topo).
29. **Doc-drift + dev-tool** — `.nvmrc` ausente (CLAUDE.md §3 o declara); OTEL endpoint não-https em prod; `console.error` cru no fatal de bootstrap (`index.ts:48`) + `app.log.error({err})` sem `serializers.err` no `unhandledRejection` (`index.ts:40`); `error.details` cru na response (`error-handler.ts:62-74`, sem redação defensiva — secrets-3); **td-2** (`consumer-integration-guide-v1.md` e `go-live-checklist.md` ausentes do repo — só no canon `20_architecture/bevox-meta-api/`); **td-1** (README "249 testes" vs 443); guia consumer "6 tentativas" vs código default 8 (`inbound/service.ts:397`); dev-only `scripts/seed.ts:56` faz `console.log(private_key_pem)` (ferramenta de seed local, **fora** do runtime do serviço — informacional). · SURVIVES/NET-NEW menores.

---

## Parte D — Placar das 11 invariantes (CLAUDE.md §4/§5) — 5ª verificação, 0 drift

| Inv | Status | Evidência-âncora (linha atual, HEAD d524810) |
|---|---|---|
| **I1** UUIDv7 | **PASS** | `db/schema/_shared.ts`; zero `serial`/uuidv4/`gen_random_uuid`. |
| **I2** Idempotência | **FAIL** (invariants-auditor: PARTIAL) | (a) rotas admin sem `Idempotency-Key` — e **estruturalmente não podem** (plugin exige `req.auth`, `idempotency.ts:82-85`); `consumer_apps.name` **sem unique** (`identity.ts:24`) → double-POST `/admin/apps` cria apps homônimos duplicados; (b) corrida read-then-write sem reserva (`idempotency.ts:98`→`:136`); Meta antes do insert (`messages/service.ts:183`) → envio dobrado sync + F1 async. Consumer path **exige** o header (enforced) — daí a leitura PARTIAL do invariants-auditor; mantido FAIL pela quebra da *garantia* (corrida) + admin. |
| **I3** app/tenant-scope | **PARTIAL** (invariants-auditor: PASS-frágil) | Plugin `tenant-scope` **inexistente** (`patchContext` 0 call-sites; guia §5.5 + CLAUDE.md §4.3 prometem o oposto). Cross-**app** eficaz (appId do JWT explícito). Gaps em inbound/worker + leitura cross-tenant intra-app (Parte C #21/#22). |
| **I4** tokens fora de log | **FAIL** (invariants-auditor: PASS-core + def-in-depth) | Núcleo sólido (token decrypt-and-discard + zeroize). FAIL por es-1 (query→span OTel sem scrubber, `telemetry.ts:95-101`, 3 sinks Meta); vetor worker (#16); redact() key-list incompleta (#15). |
| **I5** JWT RS256+kid+TTL | **PASS** (WARN) | `auth-jwt-consumer.ts`. WARN: cache chave 300s/app 60s sem deny-list jti; `JWT_MAX_AGE` aceita 900s. |
| **I6** PII redaction | **PASS** | `logger.ts` redige `content`/`text`/`body`. |
| **I7** soft-delete | **PARTIAL** | Só `tenancy` tem `deletedAt`; `templates/repository.ts` faz `.delete()` hard (espelho da Meta — nuance atenuante). |
| **I8** audit em mutação | **FAIL** (invariants-auditor: PASS-best-effort) | (a) callback GET OAuth não auditado; (b) durabilidade best-effort (`void logAudit`+swallow `audit.ts:45-50`); (c) tenant forjável (Parte C #7); (d) **só audita 2xx-3xx** (`audit-log.ts:50`) → mutações **negadas/falhas não entram na trilha** (cega para tentativa de abuso). |
| **I9** HMAC webhooks | **PARTIAL** | Inbound PASS constant-time antes do parse (`inbound/routes.ts:112`→`:121`). Callback outbound divergente + sem anti-replay + condicional (#17); SSRF (#6). |
| **I10** multi-WABA | **PASS** | `bindings.ts` FK tenant+app, unique `(tenant_id, meta_waba_id)`. Ressalva operacional: F6/F4 (token/phone da WABA errada). |
| **I11** transações ≥2 escritas | **PASS** | `wabas/repository.ts` persist em `db.transaction()` (validado em Postgres real por `token-resolver.test.ts`). Ressalva: F5 (delivery SELECT-then-INSERT sem txn/unique). |

---

## Parte E — Corpus sobrevivente + correções (5ª verificação, 0 refutado)

Detalhe integral em [`runtime-gap-audit-2026-07-04.md`](./runtime-gap-audit-2026-07-04.md), [`-07-17.md`](./runtime-gap-audit-2026-07-17.md), [`-07-19.md`](./runtime-gap-audit-2026-07-19.md). O corpus (87 de 07-04 + net-new de 07-17/07-19) **sobrevive** — anchors CRÍTICO/ALTO re-conferidos na linha atual, 0 drift.

**Correção ao corpus/rule (NET-NEW desta passada):**
- **F9 — a métrica `webhook_signature_invalid_total` NÃO é "declarada mas nunca emitida"** (como afirmam `.claude/rules/meta-api-webhooks.md` e a observação A6 de 2026-06-02). Falha de assinatura **É** observável em runtime, emitida como `metaWebhookReceivedTotal{outcome=invalid_signature|missing_signature}` (`inbound/routes.ts:109,113`; def `metrics.ts:88`). O gap real é **nome não-canônico + ausência de label `provider`** (não dá para separar WhatsApp de Instagram) — não "não emite". Corrigir a rule e a expectativa de alerta. **[webhook-hmac-auditor + orq — grep de call-sites].**

**Resultado do fan-out (5 auditores independentes, re-derivando do código):** `invariants-auditor` (placar 11-inv, 9 PASS/2 PARTIAL, + NN1-NN10), `webhook-hmac-auditor` (HMAC in/out + SSRF, 9 findings), `tenant-scope-auditor` (13 repositories + 5 workers + services, 10 findings + 6 superfícies limpas), `secrets-redaction-auditor` (loggers/serializers/telemetry/workers, C3/H4/M4 + 8 negativos), `contract-guardian` (openapi × código, drift completo). **Convergência: 0 anchor refutado, 0 drift de linha; toda divergência foi de *severidade/leitura*, não de fato.** Duas divergências de severidade honestas registradas: es-1 (secrets rateia CRÍTICO; aqui ALTO condicionado a OTel-em-prod, Parte C #3) e phone_numbers global-unique (tenant-scope rateia ALTO; aqui MÉDIO-piloto/ALTO-GA, Parte C #22). Nenhum auditor encontrou CRÍTICO novo nem vazamento **vivo** consumer-forjável — os gaps de scoping são Meta-webhook-gated ou within-app-by-model; os de secret são LATENTES (rede ausente) exceto es-1 (VIVO se OTel wired).

**Não-achados valiosos (evidência negativa, re-confirmada):**
- **I11 sólido**: toda escrita multi-row usa `db.transaction()` — validado agora também em Postgres **real** (rotação de token em `token-resolver.test.ts` cenário 3).
- **MA-008 sólido**: envelope KEK/DEK + AAD `{tenant_id,app_id,waba_id}` faz round-trip correto em Postgres real (4 cenários: ativo vs expirado vs superseded, sem-ativo→`META_UNAVAILABLE`, rotação, `createdAt DESC`).
- **Media storage**: putMedia→headMedia→presign→GET + `processMediaDownload` gravam bytes reais em MinIO sem erro (`media-flow.test.ts`).
- **Envelope de erro canônico** em todo path (sem RFC7807); enum idêntico ao spec.
- `db/schema/*.js`+`.js.map` versionados → **NÃO-GAP** (gitignored `.gitignore:17-18`; `git ls-files` vazio; runtime via `tsx` lê `.ts`).
- **Categoria (d) — dívida marcada baixíssima:** `grep TODO|FIXME|HACK|XXX|@deprecated` em `src/`+`db/` = **2 ocorrências**, zero `FIXME/HACK/XXX/@deprecated`: `db/schema/audit.ts:8` ("NEGAR UPDATE/DELETE via grants — TODO operacional" = lgpd-immutability #13) e o net-new menor `webhook-delivery.ts:211` ("TODO: emitir evento `webhook.dead_letter` próprio" — dead-letter sem evento dedicado; ~1h, BAIXO). O débito real é **estrutural/de-decisão** (A5/MA-012/contrato), não marcado em comentário.

---

## Itens-de-fechamento ordenados por valor/esforço (top 10)

| # | Item | Esforço | Destrava |
|---|------|---------|----------|
| 1 | **A5 + A5b** — persist+enqueue idempotentemente re-dirigível: `uniqueIndex` em `meta_event_id` **E** re-drive de deliveries no caminho de duplicata (ou confirmar `SET NX` só pós-persist+enqueue) | ~6h | **Bloqueador #1 do piloto**: fecha perda **e** under-delivery de inbound em blip |
| 2 | **Gate de CI** (`typecheck`+`lint`+`test` em PR/push) + **lint verde** (`queues.ts:174` + snippets + remover `.claude/tmp-gap-audit-workflow.mjs`) — cov-3/NEW-lint-1 | ~5h | Impede red/regressão na imagem de prod (causa-raiz histórica) |
| 3 | **Idempotência atômica (I2) + fim do row `failed`-envenena-key async (F1)** — reserva `SET NX`/insert-pendente no sync + `onConflictDoUpdate`/UPDATE do row `queued` no worker (não novo insert) | ~7h | Para envio dobrado sync + status/callback `failed` mentiroso no async |
| 4 | **es-1 + vetor worker (#16)** — tirar secret/code/token da query (POST body/header) + dropar `url.full`/`url.query` dos spans + fiar `serializeErrorRedacted` como `serializers.err` nos dois loggers | ~4h | Fecha vazamento de `client_secret`/token ao Tempo **e** aos logs de worker |
| 5 | **Fluxo `register` de phone number** para onboarding ES | ~6h | Desbloqueia o 1º envio no piloto p/ número novo/migrado |
| 6 | **Resiliência a blip de DB: durabilidade+integridade do audit (I8) + handler de erro do pool (F2)** — audit síncrono na txn + validar `X-Tenant-Id` + allowlist no `metadata.body` + trocar `process.emit` por log+métrica+readiness-drain | ~7h | Fecha perda/atribuição-errada da trilha (LGPD/ANPD) **e** o swallow-ou-crash de failover |
| 7 | **SSRF outbound (3 sinks)** — allowlist de host / bloqueio de faixas privadas+link-local + `https`-only no `callback_url` | ~4h | Fecha pivot SSRF na rede interna k3s a partir de URL do consumer |
| 8 | **hmac-a8** (1 linha: passar `{messaging}` no call-site IG) + **rlq-2** (429→`RATE_LIMITED` retryable + `Retry-After`) + **acender obs-1/2/3** + corrigir label/nome de `webhook_signature_invalid` (F9) | ~7h | Dedup IG real; para de dropar async em throttle; 4 painéis/alertas deixam de ser cegos |
| 9 | **Reconciliar contrato** (`openapi.yaml`↔código↔guia↔skill): **§3f** (envelope de `/v1/messages`), §3b (`events/ack`), callback path WABA, `event_id`/`signing_secret`/`current_public_key_id`, `delivery_mode` | ~6h | Desbloqueia onboarding de novo consumer via spec (GA); alinha os 3 contratos forkados |
| 10 | **Carimbar MA-012 + RoPa OT-19 + DSR/imutabilidade de audit** | jurídico ~24h+eng | Bloqueio legal de onboarding/GA |

> **Mínimo defensável para o piloto:** #1–#6 (~35h eng) + aceitar formalmente RPO/RTO de infra-4 (ou adicionar réplica CNPG/Redis), **fora** de MA-012 (jurídico). **GA** exige #7–#10 + IG (tok-1/2) + tenant-scope/tenant-a10 + E2E real contra Meta sandbox.

---

## Dependências cruzadas

- **MA-012, lgpd-a15-dsr, lgpd-immutability, durabilidade+integridade do audit** → advogado externo + RoPa **OT-19** (canon; ADR-019/020). Não-código para a parte jurídica; a parte de engenharia (audit síncrono, DSR endpoint/tabela, imutabilidade) é pré-requisito registral.
- **Contrato (§3f, §3b, cg residual, callback path, renomes, skill)** → PRs em `bevox-knowledge` (SoT por ADR-005; CLAUDE.md §8 "Parar — PR"). O `openapi.yaml` do repo é o **outlier stale**; reconciliar com o código E o guia (que já concordam). A `skill bevox-meta-api-consumer` é um **3º contrato** a alinhar. **Não mudar** `signing_secret`/`event_id`/formato HMAC `t=,v1=` do webhook-delivery sem coordenar com `bevox-backend` (usa via guia).
- **es-1 / OTEL https** → dependem de `OTEL_EXPORTER_OTLP_ENDPOINT` de prod (MA-007 Grafana Tempo).
- **register de phone number, ES/COEX, IG** → dependem do app compartilhado "Bevox Solutions" + Meta App Review + smoke/e2e contra Meta sandbox. (Memória: o webhook a nível de app aponta pro V1/chat.example.com, não pra meta-api — impacto no ES.)
- **A5/A5b, F1, F2, durabilidade do audit, infra-4** → **compõem**: a decisão de infra (aceitar single-node com RPO explícito ou adicionar réplica CNPG/Redis) muda o *quando* dos blips que esses itens exploram. É a decisão de maior alavancagem.
- **Reconciliação de I3** → o guia consumer (§5.5) e CLAUDE.md §4.3/MA-003 prometem `tenant-scope` plugin que não existe; ADR-021 canoniza `organizationId` como tenant (código usa `tenant_id`/`external_id`). Editar docs para o modelo real ("appId-via-JWT + tenant-via-header-validado-por-service") **ou** implementar o plugin. Propor ADR.

---

## Delta vs auditoria anterior (2026-07-19)

**Código:** BYTE-IDÊNTICO (só docs de auditoria desde `5516c2a`). Logo:

- **FIXED: 0.** Nada fechou por engenharia. Ground-truth idêntico (typecheck verde, lint vermelho 6 problemas, 443 testes, cobertura estável).
- **SURVIVES: ~todos.** 5ª equipe independente (5 auditores + orq): anchors CRÍTICO/ALTO resolvem na linha citada, **0 refutado, 0 drift**. Placar das 11 invariantes idêntico ao 07-19.
- **NET-NEW verificado:** **contrato §3f** (envelope de `POST /v1/messages` diverge fundamentalmente — hot path central, spec inutilizável para codegen; ausente das listas de contrato das 3 auditorias anteriores), **§3b** (`events/ack` idempotência vs spec), **hmac-F4** (callback async sem anti-replay), **hmac-F7** (`callback_url` sem https-only), **td-flaky** (timeout de teste sob carga).
- **CORREÇÃO ao corpus: 1 (F9)** — `webhook_signature_invalid_total` **É emitida** (nome/label divergentes), contra a afirmação "declarada mas nunca emitida" da rule/A6. Primeira correção factual desde que 07-17 corrigiu 2 itens do 07-04.
- **NOVA EVIDÊNCIA POSITIVA (inédita nas 4 auditorias):** `pnpm test:integration` **9/9 VERDE** em infra real — MA-008 envelope + query de token + media IO **validados contra Postgres/MinIO reais**, fechando parcialmente o ponto cego "repository.ts 0%" que todas as anteriores só puderam ler estaticamente.

**Saldo:** o alvo não se moveu por 41 dias e 4 auditorias. O ganho líquido desta sobre a anterior é **(1)** a **primeira verificação em infra real** de dois paths 0%-unit-cov (token/MA-008 + media) — ambos passam; **(2)** o net-new de contrato **§3f** que reposiciona o `openapi.yaml` como muito mais stale do que registrado (o hot path central é inutilizável para codegen); **(3)** a **correção F9** ao corpus/rule; e **(4)** o reforço do sinal de governança: **A5/MA-012 + lint vermelho congelados através de 4 auditorias em frente a um piloto vivo — o gargalo é decisório, não de descoberta.**

---

## Notas de método

**Calibração.** Como em 07-17/07-19, esta auditoria reconheceu o **código congelado**: re-descoberta do zero tem valor marginal ~nulo quando o alvo é idêntico e já foi coberto por 3 passadas. O foco foi **(a)** ground-truth em primeira mão **incluindo os testes de integração nunca antes rodados**; **(b)** 5ª verificação independente dos anchors de maior severidade; **(c)** net-new dirigido a contrato/observabilidade/audit-integrity; **(d)** síntese decisória (o piloto precisa de decisão, não de mais achados).

**Orquestração.** Fan-out via **Agent tool**, read-only, 5 auditores especializados do repo via `subagent_type` (`invariants-auditor`, `webhook-hmac-auditor`, `tenant-scope-auditor`, `secrets-redaction-auditor`, `contract-guardian`), cada um instruído a **re-derivar do CÓDIGO** (não do relatório anterior), retornar CONFIRMED/REFUTED/DRIFTED com `file:linha` atual, e caçar net-new default-cético. Verificação adversarial dos candidatos net-new (§3f, F1, F2, A5b, idempotência, audit-integrity, es-1) feita pelo **orquestrador via leitura direta do código** — não delegada.

**Leitura direta [orq]** (HEAD d524810, Node v22.23.1): `inbound/service.ts` (A5+A5b+hmac-a8), `db/client.ts` (F2), `db/schema/operations.ts` (índices A5/F1/F5), `messages/service.ts`+`schemas.ts` (F1/tok-1/§3f), `workers/outbound-dispatcher.ts` (F1/HMAC/SSRF), `workers/token-refresh.ts` (tok-2), `plugins/idempotency.ts` (I2), `plugins/audit-log.ts`+`lib/audit.ts` (I8), `lib/telemetry.ts` (es-1), `lib/metrics.ts` (obs-1/2/3 via grep de call-sites), `k8s/*` (infra-2/3/4/7), os 2 testes de integração, o **guia consumer canônico** (`$BEVOX_KNOWLEDGE_PATH/20_architecture/bevox-meta-api/consumer-integration-guide-v1.md`), e ADRs canônicos (MA-008/012, ADR-019/020/021, PRD).

**Ground-truth [orq]:** `pnpm typecheck` → VERDE; `pnpm lint` → VERMELHO (exit 1; 6 problemas); `vitest run --coverage` → **443/443 VERDE** (run limpo; cobertura **69.57%/61.5%/60.88%/72.47%**, byte-idêntica ao 07-19 — medida esta passada); numa 1ª run sob carga concorrente (integração + 5 agentes) 1 teste deu timeout de import a frio (`extract-meta-event-id-ig.test.ts`, `await import()` com timeout default 5s), passa limpo em 763ms → td-flaky; **`vitest run --config vitest.integration.config.ts` → 9/9 VERDE** (testcontainers Postgres+MinIO — 1ª execução em qualquer auditoria).

**Limitações.** (a) `test:e2e` (stack HTTP completa + Meta sandbox) segue scaffolding, não executado (cov-4). (b) A camada `repository.ts` tem **0% unit**; dois paths (token/MA-008 + media) agora cobertos por **integração real**, mas os predicados de scoping (I3) dos demais repositories seguem verificados só por leitura estática. (c) ADRs MA-001..MA-014 vivem **no canon** (`$BEVOX_KNOWLEDGE_PATH`); só MA-015/016 estão em `docs/adr/` do repo — rastreabilidade in-repo depende do canon. (d) O guia consumer e o `go-live-checklist.md` referenciados pela missão **não existem no repo** (td-2) — usou-se a versão canônica.

**Restrição respeitada:** nenhum arquivo de produto foi modificado — este relatório é o único artefato produzido.
