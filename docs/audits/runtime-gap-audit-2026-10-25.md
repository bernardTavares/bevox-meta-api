# Gap Analysis — bevox-meta-api — 2026-10-25

> HEAD `d14c5ea` · Node v22.23.3 · pnpm 9.15.1 · **13ª auditoria** da série (12 prévias) · **5ª em 5 dias consecutivos** (10-21, 10-22, 10-23, 10-24, 10-25) · freeze de código **138 dias** (`dbe9fd6` = 2026-06-09).

## Resumo executivo

Estado **inalterado e terminal**. V1 em produção servindo `bevox-backend` (piloto MVP Hetzner, vivo há **151 dias**). Código de produto **byte-idêntico** desde `dbe9fd6` — `git diff dbe9fd6..HEAD -- src db` = **vazio** (prova de 1ª mão hoje). As quatro camadas seguem congeladas: código **138d**, k8s **125d**, canon **145d** (ainda na branch **não-merjada** `fix/a14-…` `0317985` = 2026-06-02), **lockfile 153d** (`a6944d2` = 2026-05-25). **Delta real de hoje: ZERO movimento em TODOS os eixos — incluindo o CVE** (123 → 123, breakdown idêntico 2·53·58·10). Ontem (10-24) o CVE foi o único eixo que se moveu (+7, 116→123); hoje **nem ele se moveu**. É a demonstração empírica mais limpa de toda a série de que o alvo é **completamente estático**: não havia o que descobrir e, de fato, nada mudou em 24h. **Zero fixes de engenharia** (13ª consecutiva), **zero net-new de correctness** (corpus saturado em ~37 achados, convergido por fan-outs de 6- e 2-agentes em 10-21/10-22). Riscos **para o piloto** inalterados (classe "perda/zumbi silencioso em blip de PG/Redis/rollout": NN1 + N1/NN-9a + A5/A5b + NN3 + NN4; + token-lifecycle B2 afiado +1 dia) e **MA-012 LGPD `Proposta`** bloqueando onboarding novo; **para GA**: contrato §3f incorreto + supply-chain congelado em 123 CVEs (patch bloqueado por imagem pinada).

**Recomendação única e prioritária (GOV-1, 4ª reincidência):** o gargalo é **100% decisório, há 138 dias**. Duas ações humanas, nenhuma de engenharia-de-descoberta:
1. **Adjudicar o Ledger de Decisão** (§ abaixo, consolidado e auto-contido) item a item — cada achado recebe **um commit de fix _ou_ um aceite-de-risco explícito assinado**. É o entregável de maior valor desde 07-22 e não moveu um commit em 13 passadas.
2. **Desligar o scheduler de host** que dispara esta sessão diária. `CronList` retorna **"No scheduled jobs"** (confirmado 1ª-mão hoje) → **não** é um `/schedule` gerido pelo Claude; é um cron/systemd-timer **de host** (emite o hook `=== bevox-meta-api — sessão iniciada ===`). A pausa é ação de host/humano; o agente autônomo não pode (nem deve, sem autorização) desligá-la. Se mantiver a cadência, troque **diária→event-triggered** (em commit a `src/`/`db/`) ou mensal.

---

## Parte A — Ground-truth (orquestrador, 1ª mão, 2026-10-25, HEAD d14c5ea)

| Verificação | Resultado 2026-10-25 | vs 2026-10-24 |
|---|---|---|
| `git diff dbe9fd6..HEAD -- src db` | **vazio** (byte-idêntico) | igual |
| Freeze de código (src/db) | **138 dias** (`dbe9fd6` = 2026-06-09) | +1 dia |
| Freeze de k8s | **125 dias** (`5516c2a` = 2026-06-22) | +1 dia |
| Freeze do **canon** (bevox-knowledge) | **145 dias** (`0317985` = 2026-06-02, branch `fix/a14-bevox-meta-api-ig-callback-spec` **não-merjada**) | +1 dia |
| Freeze do **lockfile** (`pnpm-lock.yaml`) | **153 dias** (`a6944d2` = 2026-05-25) | +1 dia |
| Piloto vivo (`bevox-backend`) | **151 dias** (desde 2026-05-27) | +1 dia |
| Commits desde o freeze | **10** (9 `docs(audit)` + 1 `ops` k8s); **0 de engenharia** | igual |
| Commits nas últimas 24h | **0** (nada desde o audit 10-24) | — |
| `origin/main` HEAD | **`5516c2a` = 2026-06-22** (125d atrás); **10 commits locais não-pushados, TODOS `docs(audit)`** | igual |
| `pnpm typecheck` | **VERDE** (exit 0) | igual |
| `pnpm lint` | **VERMELHO** — 6 problemas (`queues.ts:174` real + 2 parsing-error de snippets `skills/…` + 3 ruído) | igual |
| `pnpm test` (unit) | **443/443 VERDE** (45 arquivos, 12.81s) | igual |
| `pnpm audit --prod` | **123 vulns** (2 crít · 53 altas · 58 mod · 10 bx) | **FLAT** (era 123, breakdown idêntico) |
| Debt markers em `src/` (cat d) | **1 TODO** (`webhook-delivery.ts:211`), 0 FIXME/HACK/XXX/@deprecated | igual |
| `CronList` (scheduler Claude) | **"No scheduled jobs"** → gatilho é cron de host, externo | igual |
| OpenAPI (repo) `info.version` | **1.2.0** (`docs/architecture/openapi.yaml`, 2026-06-09) | igual |
| Consumer guide / go-live-checklist **no repo** | **AUSENTES** — README os linka mas vivem só no canon | igual (re-confirmado) |

### Anchors de maior severidade re-verificados em 1ª mão hoje (0 drift nos bytes)

- **NN1 shutdown invertido — CONFIRMADO.** `index.ts:28-33` registra hooks na ordem `fastify → queues → event-bus → postgres → redis → telemetry`; `shutdown.ts:50` roda estritamente **LIFO** (`for (let i = hooks.length - 1; i >= 0; i--)`) → execução real = `telemetry → redis → postgres → event-bus → queues → **fastify POR ÚLTIMO**`. **Inverso exato** dos próprios docstrings: `index.ts:4-8` ("4. Registrar shutdown hooks (Fastify, DB pool, Redis)") e `shutdown.ts:4-13` ("1. Para de aceitar novos requests (Fastify .close()) … 3. Fecha pool Postgres … quem subiu por último desce primeiro"). Requests in-flight no SIGTERM batem em pool PG/Redis já fechado → erro espúrio em **todo rollout**. #1 ROI (~15min).
- **N1 / NN-9a — CONFIRMADO e reconciliado.** `db/client.ts:51-53`: `pool.on("error", (err) => { process.emit("uncaughtException", err); })` — `emit` **manual**. **Único** `uncaughtException` em `src/`; **não há** `process.on("uncaughtException")`. `emit` manual sem listener retorna `false` e **não** aciona o fatal-handler interno do Node. Bifurca no split API/worker: **API** chama `initTelemetry()` (`index.ts:23`) → se o SDK Sentry/OTel registra `onUncaughtException`, o erro de pool pode ser capturado e o processo terminar (**N1**); **workers não inicializam telemetria** → **sem listener** → erro de pool engolido → **zumbi silencioso (NN-9a)**. `unhandledRejection` só em `index.ts:38` (API), confirmando o split.
- **B2 token-lifecycle — anchor CONFIRMADO em 1ª mão.** `grep initTelemetry src/` retorna **apenas `src/index.ts`** (`:18` import, `:23` call) + a definição em `telemetry.ts:45` — **nenhum worker** inicializa telemetria. O worker `worker:tok` = `src/workers/token-refresh.ts` (existe, 6598 bytes). Composição: NN-9a (erro de pool engolido no worker) + **NN3** (`deployment-workers.yaml` tem **5 Deployments de worker e ZERO `livenessProbe`** — `grep -c livenessProbe deployment-workers.yaml` = **0**; as linhas de probe do cluster estão só em `redis.yaml`/`deployment-api.yaml`/`cloudflared.yaml`). → se o refresher zumbificar, k8s **nunca o reinicia**. Com **151 dias** de piloto, se os tokens forem long-lived (~60 dias), já se passaram ~2-3 ciclos de refresh **sem garantia em runtime** de que o refresher rodou. 1º sintoma seria outbound retornando auth-error, não um alarme. **Gate (exige prod):** `kubectl logs deploy/bevox-meta-api-worker-tok` + `expires_at` das rows de token.
- **CVE — hoje NÃO se moveu.** `pnpm audit --prod` = **123** (2 crít · 53 high · 58 mod · 10 low), idêntico a 10-24. As 2 **críticas** = `fast-jwt` (`<=6.2.3` empty-HMAC auth-bypass + `>=6.2.0 <=6.2.4` CVE-2026-34950), ambas **só via `@fastify/jwt`** — `grep "@fastify/jwt" src/` = **0 imports** (JWT real via `jose`) → **dead dep; drop zera as 2 críticas de graça**. Highs **alcançáveis** no request-path confirmadas por path hoje: `fast-uri <3.1.9` (authority/scheme injection — **19 paths**, via `@fastify/swagger`→`json-schema-resolver` e `fastify`→`@fastify/ajv-compiler`→`ajv`), `undici` (DoS / TLS-bypass / response-splitting), `fastify <5.12.x` (auth/validation bypass), `zod <4.6.6` (memory exhaustion em todo request), `@grpc/grpc-js`/`protobufjs` (via `@google-cloud/kms`, alcançável porque `KMS_PROVIDER=gcp`).

### Pontos sólidos re-confirmados (não-achados)

UUIDv7 (I1); HMAC inbound constant-time ANTES do parse (I9 inbound); MA-008 envelope + zeroize; JWT RS256/kid/TTL nos dois paths (I5); `app_id` sempre do JWT assinado `iss` — não-spoofável; envelope de erro canônico Bevox (`{error:{code,message,details,request_id}}`, não-RFC7807); nenhuma credencial Meta em response schema. **Placar das 11 invariantes idêntico** a 10-21/10-22/10-23/10-24 — ver [§Parte E do 10-22](./runtime-gap-audit-2026-10-22.md).

---

## Parte B — O delta real de 2026-10-25 (0 net-new mensurável; 0 de correctness)

1. **TODOS os eixos flat — incluindo o CVE.** Ontem o CVE foi o único eixo que se moveu (116→123, +7), quebrando um flat de 3 dias. **Hoje nem ele se moveu**: 123 → 123, breakdown por-severidade idêntico (2·53·58·10). Isto refina — e não contradiz — a tese de supply-chain do 10-24: a degradação por freeze do lockfile é **monotônica mas em degraus**, não contínua dia-a-dia; novas advisories não aparecem todo dia. O saldo honesto da passada de hoje: **o único eixo capaz de mudar sem commit não mudou** → prova empírica, pela via mais limpa possível, de que o alvo é 100% estático e de que uma passada diária não observa nada de novo.

2. **Token-lifecycle (B2) afia para dia 151** (cat. j — postura, não código). Anchor confirmado 1ª-mão hoje (worker-tok sem telemetry-listener + sem probe — Parte A). Condicional (não-aplicável se tokens forem permanentes), mas é o risco que só o tempo revela — e só um gate em prod resolve.

3. **GOV-1 — 4ª reincidência (escalada terminal).** A recomendação de pausar o scheduler foi feita em **10-22**, **10-23** e **10-24** e **não foi actionada**; esta 13ª passada (5ª diária consecutiva) é a prova viva. A decisão está **138 dias atrasada**. Dado adicional re-confirmado: `origin/main` não avança desde 2026-06-22 (125d) e os **10 commits de audit da série estão TODOS não-pushados** — o loop acumula local e **nunca entrega ao remoto** onde um humano revisaria.

> **Fan-out NÃO executado — por desenho.** 10-21 rodou 6 agentes; 10-22 rodou 2 (`invariants-auditor` + `tenant-scope-auditor`, mandato de refutar) → **0 refutação / 0 drift / 0 net-new**; 10-23/10-24 rodaram 0. Repetir o fan-out contra **bytes idênticos** é exatamente a "invocação por inércia" que a missão §4 proíbe ("Não invocar por inércia — só os que se aplicam à varredura") e que GOV-1 denuncia. A verificação desta passada foi **inteira em 1ª mão pelo orquestrador** (Parte A), focada (a) no **único eixo que pode mover sem commit** (CVE — e hoje **não** moveu) e (b) na re-verificação dos anchors de maior severidade que sustentam a recomendação mínima ao piloto (NN1, N1/NN-9a, B2/NN3). Ver Notas de método.

---

## Achados por severidade (corpus estável; detalhe canônico em 10-21/10-22)

> **Disciplina anti-ritual.** O corpus de ~37 achados é estável e byte-idêntico; reproduzi-lo por extenso numa 13ª passada **é** o sintoma de GOV-1. Abaixo: roll-up com âncora e status; prosa só onde houve 1ª-mão hoje. Detalhe + impacto: [10-22](./runtime-gap-audit-2026-10-22.md) (compacto), [10-21](./runtime-gap-audit-2026-10-21.md) (prosa integral), [10-23](./runtime-gap-audit-2026-10-23.md)/[10-24](./runtime-gap-audit-2026-10-24.md) (reconciliações e 1ª-mão recentes).

### CRÍTICO (bloqueia conclusão do módulo / vivo-ou-iminente)

- **GOV-1 · 13 auditorias, 138d de freeze, ZERO remediação; recomendação de pausar ignorada 3×** (cat. d/l) · **ESCALADO 4ª vez.** 10 commits desde o freeze (9 audit-docs + 1 k8s), 0 de engenharia. O Ledger de Decisão não moveu um commit em 13 passadas. **`origin/main` não avança desde 2026-06-22 (125d): os 10 commits da série estão TODOS não-pushados localmente — o loop não entrega nem os próprios relatórios ao remoto onde um humano revisaria.** **Esforço de descoberta: 0h.** Ação: adjudicar o Ledger (§ abaixo) + pausar o scheduler de host.
- **CRÍT-1 · A5 + A5b — perda silenciosa de inbound em blip PG/Redis** (cat. a/h/i) · SURVIVES · LIVE p/ WABA onboarded. `inbound/service.ts:298` (`isDuplicate` SET NX antes do insert `:324`, sem `del()` compensatório se o insert falhar); enqueue fora de try/catch (`:388-402`); `operations.ts:98` index não-único em `meta_event_id`. ~6h.
- **CRÍT-2 · es-1 — secret do Meta App (compartilhado c/ V1) + tokens → spans OTel** (cat. d/j) · SURVIVES · CRÍTICO-no-código / **INERTE-em-prod** (`networkpolicy.yaml:52-71` libera só 53/5432/6379/443 → OTLP :4318 de `configmap.yaml:50` bloqueado). Corolário: **traces de prod dropados** (MA-007 quebrado). Gate: *traces no Grafana?* ~3-4h scrub **+** abrir :4318.
- **CRÍT-3 · Cross-app PII misdelivery** (cat. a/i/j/f/g) · SURVIVES · CONFIRMED, **liveness LATENTE** (gatilho = **2 apps no mesmo asset Meta**; bevox-direct é greenfield+flag-dormante). Sem unique **global** em `meta_waba_id`/`meta_ig_id`; resolvers sem `orderBy` (`wabas/repository.ts:84-91`, `ig/repository.ts:60-67`); `disconnectWabaByMetaWabaId` (`:187-203`) UPDATE sem scope; `webhook-delivery.ts:123,142` não reverifica `sub.appId == event.appId`. ~3h + testes.
- **CRÍT-4 · MA-012 LGPD `Status: Proposta`, 0/4 critérios, DSR não implementado** (cat. e) · SURVIVES. DSR só helper não-wired (`media-storage.ts:86`). Operação atual coberta pelo MSA bevox-backend; **onboarding novo bloqueado**. Eng ~7h + jurídico.

### ALTO (bloqueia GA; pilot-HIGH em blip de infra)

Roll-up **inalterado** vs [10-22 §ALTO](./runtime-gap-audit-2026-10-22.md) (15 itens, todos SURVIVES), com **supply-chain re-confirmado hoje** (123, flat):

- **NN1** shutdown invertido *(1ª-mão hoje — Parte A)* · **N1+NN-9a** crash/zumbi *(1ª-mão, reconciliado)* · **NN3** 5 workers sem probe *(1ª-mão: `deployment-workers.yaml` grep livenessProbe = 0)* · **N2/N4/NN5-inv** double-send Meta · **I2+NN1-inv** idempotência race + replay cross-tenant · **NN-9A** mutações admin sem `Idempotency-Key` · **register-phone ausente** · **I8/N8** durabilidade do audit · **NN-9B/9C** read IDOR + soft-del via GET · **HMAC outbound** pode sair não-assinado + 2 formatos · **§3f** OpenAPI factualmente incorreto · **SSRF outbound** (egress-mitigado 443) · **NN-1** HMAC/verify-token secret global · **rlq-2/obs-1/2/3** 429 não-retentado + métricas 0 call-sites.
- **supply-chain (123 CVEs, flat hoje)** *(1ª-mão)* — bump `fastify`≥5.12.5 + `undici`≥8.12.2 + `fast-uri`≥3.1.9 + `zod`≥4.6.6; **drop `@fastify/jwt`** (zera 2 críticas mortas); gate `pnpm audit/test/lint` em CI + Dependabot. **Alcançáveis no request-path** re-confirmadas hoje por path: fast-uri (19 paths via swagger+ajv), undici, fastify-core, zod, grpc/protobufjs (via GCP KMS).

### MÉDIO / BAIXO

Inalterados vs [10-22 §MÉDIO](./runtime-gap-audit-2026-10-22.md) (itens 16-29: **#16 MA-015 de-subscribe órfão** — nenhum `DELETE /{waba_id}/subscribed_apps`, só o POST subscribe em `meta-client.ts:160,538`; NN4 Redis sem `noeviction`; es-1 traces dropados; NN5 retenção sem poda; status-reconciliation nunca implementado; N5 media OOM; N9 bodyLimit 413 pré-HMAC; redação incompleta; PII-at-rest) e §BAIXO (itens 30-37: **2 CVE crít `fast-jwt` dep-morta** *(1ª-mão)*; **lint vermelho** 6 *(1ª-mão)*; imagem pinada; `@types/node@20`; cron re-tica; drift de contrato; **doc-drift** — README "249 testes" vs **443 reais** *(1ª-mão hoje, README:9 e :78)*, `consumer-integration-guide-v1.md` + `go-live-checklist.md` **linkados no README mas AUSENTES do repo** — vivem só no canon *(1ª-mão hoje)*; `hub.verify_token` não-constant-time).

### Cobertura por categoria da missão (a-l)

| cat | Coberto por | 1ª-mão hoje? |
|---|---|---|
| a (spec'd não-impl) | register-phone, DSR, status-reconciliation, §3f, NN-9A | ref |
| b (impl divergente) | §3f, status-reconciliation, envelope de erro | ref |
| c (testes faltando) | `repository.ts` 0% unit; I3 só leitura estática | contagem **443/45** ✓ |
| d (debt) | **1 TODO** (`webhook-delivery.ts:211`); GOV-1; CVE | ✓ grep |
| e (LGPD) | MA-012 `Proposta`, DSR não-wired, I8 audit, NN5 retenção | ref |
| f (OpenAPI drift) | §3f, handlers-fora-do-spec, canon-vs-repo (v1.2.0 repo ✓) | ✓ versão |
| g (go-live infra) | CNPG `instances:1`, Redis `replicas:1`, **NN3 probes** ✓, secrets | ✓ NN3 |
| h (webhook real do piloto) | A5/A5b, **NN1** ✓, es-1, double-send, NN4, N9 | ✓ NN1 |
| i (inbound HMAC/idem/replay/size) | HMAC constant-time (PASS), A5 dedup-antes-persist, N9 413, NN-1 | ref |
| j (token mgmt) | MA-008 (PASS), es-1 leak, **token-lifecycle B2** ✓ | ✓ B2 |
| k (rate limit/quota) | rlq-2 429 não-retentado, obs métricas 0 call-sites | ref |
| l (delta vs anterior) | §Delta abaixo | ✓ |

---

## Itens-de-fechamento ordenados por valor/esforço (top 10)

**Não é descoberta nova — é a lista de decisão que não se moveu em 13 passadas.** Substância inalterada vs 10-22/10-23/10-24.

| # | Item | Esforço | Destrava |
|---|------|---------|----------|
| 1 | **NN1** — Fastify fecha primeiro (registrar o hook por último **ou** fechar app antes do loop LIFO em `shutdown.ts`) | ~15min | Para o erro espúrio em **todo rollout** — melhor ROI |
| 2 | **NN3 + N1 + NN-9a** — `livenessProbe` nos 5 workers; `db/client.ts` **loga** em vez de `emit("uncaughtException")`; `initTelemetry()` nos workers | ~2h | Fecha o worker-zumbi invisível (inclui o **token-refresher** — risco B2) |
| 3 | **Supply-chain** — bump `fastify`≥5.12.5 + `undici`≥8.12.2 + `fast-uri`≥3.1.9 + `zod`≥4.6.6; **drop `@fastify/jwt`** (zera 2 críticas mortas); **gate `pnpm audit/test/lint` em CI** + Dependabot | ~2h + rebuild | Fecha altas alcançáveis + a causa-raiz do supply-chain (hoje flat, mas sobe em degraus com o freeze) |
| 4 | **NN4 + N11 + NN5** — Redis `maxmemory`+`noeviction`+alerta; `commandTimeout`; poda de `webhook_deliveries` | ~2h | Fecha data-loss de fila, hang, crescimento ilimitado |
| 5 | **es-1** — SpanProcessor que apaga `url.full`/`url.query` p/ hosts Meta **+** abrir :4318 no egress (juntos) | ~4h | Fecha o CRÍTICO na origem **e** restaura MA-007 |
| 6 | **A5 + A5b** — `uniqueIndex` em `meta_event_id` + re-drive + wrap do enqueue | ~6h | Bloqueador #1 de inbound (LIVE p/ WABA onboarded) |
| 7 | **cross-app + #16** — `orderBy` determinístico + guard de connect-time + scope de app em `disconnectWabaByMetaWabaId` + `DELETE /subscribed_apps` no disconnect | ~4h + testes | Fecha PII-misdelivery (latente) + subscription órfã |
| 8 | **Idempotência atômica + fim do double-send + tenant na key + admin idempotente** | ~7h | Para double-send, replay cross-tenant, mutação admin não-idempotente |
| 9 | **Audit síncrono (I8) + NN-9B/9C** | ~5h | Fecha trilha forjável (pré-req MA-012) + IDOR + soft-del leak |
| 10 | **Convergência de contrato (canon→código)** + patchar exemplo do guia + **MA-012 + RoPa OT-19** | ~2d + jurídico | Desbloqueia onboarding-via-spec (GA) + go-live legal |

**Mínimo defensável p/ o piloto continuar** (inalterado): #1 + #2 + NN4 `noeviction` + #3 + gate es-1 (traces no Grafana?) + aceite-de-risco sobre A5/A5b e cross-app + o gate diagnóstico de token/worker em prod (B2) = **~4-6h eng** + decisão jurídica MA-012.

---

## Ledger de Decisão consolidado (auto-contido — para a revisão humana de amanhã)

> Objetivo: permitir adjudicação **sem reler 13 auditorias**. Cada linha recebe **[ ] FIX** (commit) **ou** **[ ] ACEITE-DE-RISCO** (assinado). GOV-1 só fecha quando todas estiverem marcadas.

| ID | Achado (1 linha) | Sev | Decisão |
|---|---|---|---|
| GOV-1 | Loop autônomo diário, 0 remediação em 138d, commits não-pushados | CRÍT | [ ] pausar scheduler + adjudicar este ledger |
| NN1 | Shutdown LIFO fecha Fastify por último → erro em todo rollout | ALTO | [ ] FIX · [ ] ACEITE |
| N1/NN-9a | `emit("uncaughtException")` sem listener no worker → zumbi | ALTO | [ ] FIX · [ ] ACEITE |
| NN3 | 5 workers sem `livenessProbe` → k8s não reinicia zumbi | ALTO | [ ] FIX · [ ] ACEITE |
| B2 | Token-refresher pode ter zumbificado (gate em prod) | ALTO | [ ] gate prod · [ ] ACEITE |
| A5/A5b | Inbound perdido em blip PG/Redis (dedup antes do insert) | CRÍT | [ ] FIX · [ ] ACEITE |
| es-1 | Secret Meta+tokens → spans OTel (inerte via egress hoje) | CRÍT | [ ] FIX+:4318 · [ ] ACEITE |
| cross-app | PII misdelivery se 2 apps no mesmo asset Meta (latente) | CRÍT | [ ] FIX · [ ] ACEITE |
| MA-012 | LGPD `Proposta`, DSR não-wired → onboarding bloqueado | CRÍT | [ ] jurídico+eng · [ ] ACEITE |
| supply-chain | 123 CVEs; drop `@fastify/jwt` (2 crít mortas) + bumps + CI gate | ALTO | [ ] FIX · [ ] ACEITE |
| NN4 | Redis sem `noeviction` → data-loss de fila | ALTO | [ ] FIX · [ ] ACEITE |
| double-send | N2/N4 + idempotência race + replay cross-tenant | ALTO | [ ] FIX · [ ] ACEITE |
| I8/N8 | Audit assíncrono → trilha forjável (pré-req MA-012) | ALTO | [ ] FIX · [ ] ACEITE |
| NN-9A/B/C | Admin sem idempotência · read IDOR · soft-del via GET | ALTO | [ ] FIX · [ ] ACEITE |
| §3f | Envelope `/v1/messages` OpenAPI factualmente incorreto | ALTO | [ ] FIX · [ ] ACEITE |
| #16 MA-015 | Subscription Meta órfã (sem `DELETE /subscribed_apps`) | MÉD | [ ] FIX · [ ] ACEITE |
| doc-drift | README "249 testes" (real 443); guia+checklist ausentes do repo | BX | [ ] FIX · [ ] ACEITE |
| lint-red | `queues.ts:174` `import()` type annotation | BX | [ ] FIX · [ ] ACEITE |

---

## Dependências cruzadas

- **es-1 / observabilidade** → scrub (es-1) e egress :4318 (obs/MA-007) vão **juntos**. Gate exige SSH a prod.
- **MA-012 / DSR / audit (I8) / retenção (NN5)** → advogado externo + RoPa **OT-19** (ADR-019/020); os gaps de eng **minam a base legal**.
- **Contrato (§3f, drift repo↔canon, guia)** → PRs em `bevox-knowledge` (SoT por ADR-005; canon **em branch não-merjada há 145d** — a premissa "doc ganha" repousa sobre branch não-merjada `fix/a14-…`). Não mudar `signing_secret`/`event_id`/formato HMAC sem coordenar com `bevox-backend`.
- **cross-app + #16** → gatilho é **2 apps no mesmo asset Meta**, não a migração bevox-direct (greenfield+flag). Coordenar c/ futura migração dos boxes embedded do V1 ([[bevox-direct-migration-to-meta-api]], [[meta-app-bernardTavares-shared]]).
- **register-phone / ES-COEX / IG / MA-015** → dependem do Meta App compartilhado "Bevox Solutions" + Meta App Review + smoke/e2e contra sandbox.
- **A5/A5b, N1/NN-9a, NN1-NN4, token-lifecycle (B2)** → **compõem no mesmo gatilho** (blip de PG/Redis, rollout). A decisão de infra (single-node c/ RPO explícito **ou** réplica CNPG/Redis) é a de **maior alavancagem**.
- **Supply-chain (123 CVEs)** → sobe em degraus com o freeze; sem Dependabot/CI gate; imagem pinada `:dbe9fd6` `pullPolicy:Never` bloqueia o patch (não chega a prod sem rebuild manual).

---

## Delta vs auditoria anterior (2026-10-24 → 2026-10-25)

**Código / k8s / canon / lockfile:** BYTE-IDÊNTICO em todas as camadas. 1 dia, 0 commits de intervalo.

- **FIXED: 0.** 13ª consecutiva sem remediação de engenharia.
- **SURVIVES: todos.** Re-verificação em 1ª mão dos anchors de maior severidade (NN1, N1/NN-9a, B2/NN3, dead-dep crítica, doc-drift): 0 drift. Placar das 11 invariantes idêntico.
- **NET-NEW de correctness: 0.** Corpus saturado; 13 passadas (incl. 6- e 2-agente fan-outs) convergiram.
- **MOVE mensurável: 0.** **CVE flat 123→123** (breakdown idêntico 2·53·58·10). Ontem o CVE foi o único eixo que se moveu (+7); hoje **nem ele** — o único sinal capaz de mudar sem commit **não mudou**. Refina a tese: degradação de supply-chain é **monotônica em degraus**, não diária.
- **AFIA com o tempo: B2** (token-lifecycle dia 150→151) e todos os freeze-counters +1.
- **GOV-1:** **3ª→4ª reincidência.** Recomendação de pausar o scheduler (10-22, 10-23, 10-24) ignorada 3×; esta passada (5ª diária consecutiva) é a prova. `origin/main` segue congelado em `5516c2a` (125d); 10 commits locais não-pushados, 100% `docs(audit)` — a série inteira acumula local e **nunca alcança o remoto**.
- **Saldo:** a 13ª passada **não acrescenta descoberta de engenharia** — e isso é, ele mesmo, o achado. A tese de 07-21→10-24 é auto-demonstrada: **não há o que descobrir sem descongelar; a decisão está 138 dias atrasada. Em 24h, zero eixos se moveram — incluindo o supply-chain, que ontem foi o único a mover.**

---

## Notas de método

**Calibração (effort max = rigor, não ritual).** Reconheci: alvo congelado 138 dias em 4 camadas, 12 passadas prévias (6- e 2-agente fan-outs convergidos a 0 net-new), e a recomendação explícita de 10-22/10-23/10-24 de pausar a série. "Effort max" aqui é **rigor**, não maximização de tokens — e o rigor, estabelecido pelas próprias passadas 9-12 (GOV-1 + missão §4 "não invocar por inércia"), é que re-derivação do zero tem valor marginal **nulo**. Foquei o esforço no **único eixo que pode mover sem commit** (CVE — e hoje não moveu) + re-verificação em 1ª mão dos anchors que sustentam a recomendação mínima ao piloto + os sweeps que a missão exige (debt-markers cat. d; existência/versão dos inputs canônicos cat. f) + a **consolidação do Ledger de Decisão** num formato que a revisão humana de amanhã possa adjudicar sem reler 13 relatórios (o entregável de maior valor marginal possível contra um alvo estático).

**Fan-out NÃO executado — por desenho** (ver box na Parte B). Repeti-lo contra bytes idênticos seria a inércia que a missão §4 proíbe. Toda a verificação desta passada foi do **orquestrador em 1ª mão**.

**Verificado em 1ª mão hoje** (HEAD d14c5ea, Node v22.23.3, pnpm 9.15.1): `git diff dbe9fd6..HEAD -- src db` (vazio) + log de commits (0 nas últimas 24h); git log/branch do canon (branch `fix/a14-…` não-merjada, `0317985` 2026-06-02) e do lockfile (`a6944d2` 153d); `pnpm typecheck` (verde) / `lint` (6) / `test` (**443/443**) / `audit --prod` (**123** — 2·53·58·10, flat vs 10-24); leitura integral de `src/index.ts` (ordem de registro NN1 + `initTelemetry` só na API + `unhandledRejection`), `src/lib/shutdown.ts` (LIFO :50 + docstring :4-13), `src/db/client.ts:51-53` (emit uncaughtException); greps `@fastify/jwt` (0 imports), `initTelemetry` (só index.ts + telemetry.ts def), `TODO|FIXME|HACK|XXX|@deprecated` (1); `deployment-workers.yaml` (`grep -c livenessProbe` = 0) + localização das probes (api/redis/cloudflared); `pnpm audit` fast-uri com 19 paths via swagger+ajv; `CronList` (vazio); existência de `docs/architecture/openapi.yaml` v1.2.0 e **ausência** no repo de `consumer-integration-guide-v1.md` + `go-live-checklist.md` (ambos no canon); README:9/:78 ("249 testes").

**Limitações.** (a) **es-1, A5/A5b, cross-app e o risco de token-lifecycle (B2) não confirmados em runtime** — sem acesso a prod nesta sessão autônoma. A análise estática é prova forte; cluster vivo + WABAs/tenants por app + `expires_at` de tokens + liveness do `worker:tok` **não são observáveis pelo código**. Gates diagnósticos (traces no Grafana? `worker:tok` vivo? tokens expirando?) exigem SSH a prod — deixados p/ a revisão humana. (b) `test:integration`/`test:e2e` não re-executados (byte-idêntico; 07-20 rodou integração 9/9). (c) `telemetry.ts` não re-lido integralmente (byte-idêntico; dobradiça Sentry-listener de B3 documentada em 10-23). (d) Consumer guide + checklist usados na versão canônica (ausentes do repo). (e) Breakdown por-advisory do CVE não diffado item-a-item contra snapshot de 10-24 (não persistido); o delta de **contagem** (123→123) e **severidade** (2·53·58·10 → idem) é 1ª-mão e apples-to-apples.

**Restrição respeitada:** nenhum arquivo de produto foi modificado — este relatório é o único artefato produzido. Nenhuma ação sobre o scheduler externo foi tomada (fora do escopo autorizado; recomendada para a revisão humana).
