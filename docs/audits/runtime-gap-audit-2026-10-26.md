# Gap Analysis — bevox-meta-api — 2026-10-26

> HEAD `721edb8` · Node v22.23.3 · pnpm 9.15.1 · **14ª auditoria** da série (13 prévias) · **6ª em 6 dias consecutivos** (10-21…10-26) · freeze de código **139 dias** (`dbe9fd6` = 2026-06-09).

## Resumo executivo

Estado **inalterado e terminal**, re-provado em 1ª mão hoje. `git diff dbe9fd6..HEAD -- src db` = **vazio** → o código de produto é **byte-idêntico** há 139 dias. As quatro camadas seguem congeladas: código **139d**, k8s **126d** (`5516c2a`), canon **146d** (ainda na branch **não-merjada** `fix/a14-bevox-meta-api-ig-callback-spec` `0317985`), **lockfile 154d** (`a6944d2`). V1 em produção servindo `bevox-backend` há **152 dias**. **Delta real de hoje: ZERO em TODOS os eixos** — e, pelo **2º dia consecutivo, nem o CVE se moveu** (123 → 123, breakdown idêntico 2·53·58·10). Isso **confirma empiricamente** a tese levantada em 10-24/10-25: a degradação de supply-chain contra lockfile congelado é **monotônica em degraus** (10-23 flat, **10-24 +7**, 10-25 flat, 10-26 flat), não diária — ou seja, **uma cadência diária super-amostra um sinal que muda em passos ~semanais**. **Zero fixes de engenharia** (14ª consecutiva), **zero net-new de correctness** (corpus saturado em ~37 achados, convergido por fan-outs de 6- e 2-agentes em 10-21/10-22).

Riscos **para o piloto** inalterados (classe "perda/zumbi silencioso em blip de PG/Redis/rollout": NN1 + N1/NN-9a + A5/A5b + NN3 + NN4; token-lifecycle B2 afiado +1 dia) e **MA-012 LGPD `Proposta`** bloqueando onboarding novo. **Para GA**: contrato §3f incorreto + supply-chain congelado em 123 CVEs (patch bloqueado por imagem pinada).

**Recomendação única e prioritária (GOV-1, 5ª reincidência):** o gargalo é **100% decisório, há 139 dias**. Nenhuma ação de engenharia-de-descoberta resta. Ver o **Kit de Resolução (off-ramp)** logo abaixo — são 3 ações humanas de minutos, projetadas para a revisão de amanhã **encerrar o loop e começar a remediação**, não para gerar uma 15ª auditoria.

---

## Kit de Resolução (off-ramp) — o que a revisão de amanhã deve fazer

> A série produziu 14 relatórios idênticos porque **o entregável sempre foi "mais achados", nunca "a decisão"**. Esta seção inverte isso: dá as ações concretas, verificadas como executáveis, que fecham GOV-1. Não há descoberta nova a fazer; há decisão a tomar.

**Ação 1 — Desligar o gatilho diário (host, ~2 min).** `CronList` = *"No scheduled jobs"* (1ª mão hoje) → **não** é `/schedule` do Claude; é cron/systemd-timer **de host** que emite o hook `=== bevox-meta-api — sessão iniciada ===`. O agente autônomo **não pode** desligá-lo. No host de dev (`debian`, <DEV_HOST_IP>), inspecionar e remover/pausar:
```bash
crontab -l                      # procurar a linha que dispara a sessão headless
systemctl --user list-timers    # ou timer de usuário
# remover a entrada OU trocar diária→semanal/event-triggered (ver Ação 3)
```

**Ação 2 — Decidir o destino dos 11 commits locais (eng, ~5 min).** `origin/main` está em `5516c2a` (126d); há **11 commits locais não-pushados, 100% `docs(audit)`** — a série inteira acumula local e **nunca alcança o remoto** onde um humano revisaria. Escolher uma:
```bash
git log --oneline origin/main..HEAD        # revisar os 11 (+este = 12)
git push origin main                       # (a) publicar as auditorias, OU
git reset --hard 5516c2a                   # (b) descartar a série e manter só este relatório fora do git, OU
git rebase -i 5516c2a                      # (c) esmagar em 1 commit "docs(audit): série de freeze"
```

**Ação 3 — Adjudicar o Ledger de Decisão** (§ abaixo, auto-contido) **item a item**: cada achado recebe **um commit de fix _ou_ um aceite-de-risco explícito assinado**. É o entregável de maior valor desde 07-22 e não moveu um commit em 14 passadas. **Mínimo defensável p/ o piloto continuar:** #1 NN1 + #2 NN3/N1/NN-9a + NN4 `noeviction` + #3 supply-chain + gate es-1 (traces no Grafana?) + aceite-de-risco sobre A5/A5b e cross-app + o gate de token/worker em prod (B2) = **~4-6h eng** + decisão jurídica MA-012.

> Se, apesar de tudo, a cadência for mantida: **troque diária → semanal ou event-triggered** (disparar só em commit a `src/`/`db/` ou em bump do lockfile). Justificativa quantificada hoje: o único eixo capaz de mudar sem commit (CVE) mudou **1 vez em 4 dias** (10-24 +7; 10-23/25/26 flat) — amostragem diária observa "nada" em ~75% das passadas.

---

## Parte A — Ground-truth (orquestrador, 1ª mão, 2026-10-26, HEAD 721edb8)

| Verificação | Resultado 2026-10-26 | vs 2026-10-25 |
|---|---|---|
| `git diff dbe9fd6..HEAD -- src db` | **vazio** (byte-idêntico) | igual |
| Freeze de código (src/db) | **139 dias** (`dbe9fd6` = 2026-06-09) | +1 dia |
| Freeze de k8s | **126 dias** (`5516c2a` = 2026-06-22) | +1 dia |
| Freeze do **canon** (bevox-knowledge) | **146 dias** (`0317985` = 2026-06-02, branch `fix/a14-…` **não-merjada** — `git branch --contains 0317985` = só essa branch) | +1 dia |
| Freeze do **lockfile** (`pnpm-lock.yaml`) | **154 dias** (`a6944d2` = 2026-05-25) | +1 dia |
| Piloto vivo (`bevox-backend`) | **152 dias** (desde 2026-05-27) | +1 dia |
| Commits desde o freeze | **11** (10 `docs(audit)` + 1 `ops` k8s); **0 de engenharia** | +1 (o audit 10-25) |
| Commits nas últimas 24h | **0** (nada desde o audit 10-25) | — |
| `origin/main` HEAD | **`5516c2a` = 2026-06-22** (126d); **11 commits locais não-pushados, TODOS `docs(audit)`** | +1 não-pushado |
| `pnpm typecheck` | **VERDE** (exit 0) | igual |
| `pnpm lint` | **VERMELHO** — 6 problemas (1 real `queues.ts:174` + parsing-errors de snippets `skills/…` fora do tsconfig) | igual |
| `pnpm test` (unit) | **443/443 VERDE** (45 arquivos, 12.57s) | igual |
| `pnpm audit --prod` | **123 vulns** (2 crít · 53 altas · 58 mod · 10 bx) | **FLAT 2º dia** (idêntico 2·53·58·10) |
| Debt markers em `src/` (cat d) | **1 TODO** (`webhook-delivery.ts:211`), 0 FIXME/HACK/XXX/@deprecated | igual |
| `CronList` (scheduler Claude) | **"No scheduled jobs"** → gatilho é cron de host, externo | igual |
| OpenAPI (repo) `info.version` | **1.2.0** (`docs/architecture/openapi.yaml:4`) | igual |
| Consumer guide / go-live-checklist **no repo** | **AUSENTES** (re-confirmado por `ls`) — README os linka (:21,:63,:65) mas vivem só no canon | igual |
| ADRs locais além do canon | **MA-015 + MA-016 presentes em `docs/adr/`**; canon (branch a14) topa em **MA-014** → repo **à frente** do canon | igual (re-confirmado) |

### Anchors de maior severidade re-verificados em 1ª mão hoje (0 drift nos bytes)

> Nota de método: o `git diff` vazio **prova** por si que todo achado derivado de fonte é byte-idêntico ao último verificado. As re-leituras abaixo são para **re-citar linhas em 1ª mão**, não porque o diff deixasse dúvida.

- **NN1 shutdown invertido — CONFIRMADO.** `index.ts:28-33` registra hooks na ordem `fastify → queues → event-bus → postgres → redis → telemetry`; `shutdown.ts:50` roda estritamente **LIFO** (`for (let i = hooks.length - 1; i >= 0; i--)`) → execução real = `telemetry → redis → postgres → event-bus → queues → **fastify POR ÚLTIMO**`. **Inverso exato** do docstring: `shutdown.ts:5` ("1. Para de aceitar novos requests (Fastify .close())") + `:12-13` ("LIFO — quem subiu por último desce primeiro") e `index.ts:4-8`. Requests in-flight no SIGTERM batem em pool PG/Redis já fechado → erro espúrio em **todo rollout**. #1 ROI (~15min).
- **N1 / NN-9a — CONFIRMADO.** `db/client.ts:51-52`: `pool.on("error", (err) => { process.emit("uncaughtException", err); })` — `emit` **manual**, único `uncaughtException` em `src/`; **não há** `process.on("uncaughtException")`. `emit` manual sem listener retorna `false` e **não** aciona o fatal-handler do Node. Bifurca no split API/worker: `initTelemetry` só aparece em **`src/index.ts:18,23`** (API) + a def em `telemetry.ts:45` — **nenhum worker** inicializa telemetria → **sem listener** no worker → erro de pool engolido → **zumbi silencioso (NN-9a)**. `unhandledRejection` só em `index.ts:38` (API), confirmando o split.
- **NN3 — CONFIRMADO.** `deployment-workers.yaml`: `grep -c livenessProbe` = **0** e `readinessProbe` = **0**. As probes do cluster vivem só em `deployment-api.yaml` (1/1), `redis.yaml` (1/1), `cloudflared.yaml` (1/0). → os **5 Deployments de worker** não têm liveness; se um zumbificar (via NN-9a), k8s **nunca o reinicia**. Compõe com B2 (token-refresher).
- **es-1 — CONFIRMADO (crítico-no-código / inerte-em-prod).** `networkpolicy.yaml` egress libera TCP **3000, 9090, 5432, 6379, 443** + UDP **53** — **não há 4318 nem 4317**. O OTLP de `configmap.yaml:50` não sai do pod → **traces de prod dropados (MA-007 quebrado)** e, ao mesmo tempo, o vazamento de secret/token a spans fica **inerte em prod** (não há para onde exportar). Fix = scrub do span **+** abrir :4318 (juntos).
- **Dead-dep crítica — CONFIRMADO.** `grep "@fastify/jwt" src/` = **0 imports** (JWT real via `jose`). As 2 **críticas** do `pnpm audit` são `fast-jwt` **só via `@fastify/jwt`** → inalcançáveis; `drop @fastify/jwt` zera as 2 críticas de graça.
- **CVE — NÃO se moveu (2º dia).** `pnpm audit --prod` = **123** (2·53·58·10), idêntico a 10-25. Highs **alcançáveis** re-confirmadas por path hoje: `fast-uri <3.1.9` (**19 paths** via `@fastify/swagger`→`json-schema-resolver` e `fastify`→`@fastify/ajv-compiler`→`ajv`/`ajv-formats`), além de `undici`, `fastify`-core, `zod`, `@grpc/grpc-js`/`protobufjs` (via `@google-cloud/kms`, alcançável porque `KMS_PROVIDER=gcp`).

### Pontos sólidos re-confirmados (não-achados)

UUIDv7 (I1); HMAC inbound constant-time ANTES do parse (I9 inbound); MA-008 envelope + zeroize; JWT RS256/kid/TTL nos dois paths (I5); `app_id` sempre do JWT assinado `iss` — não-spoofável; envelope de erro canônico Bevox (`{error:{code,message,details,request_id}}`, não-RFC7807); nenhuma credencial Meta em response schema. **Placar das 11 invariantes idêntico** a 10-21…10-25 — ver [§Parte E do 10-22](./runtime-gap-audit-2026-10-22.md).

---

## Parte B — O delta real de 2026-10-26 (0 net-new; 0 de correctness)

1. **TODOS os eixos flat — incluindo o CVE pelo 2º dia.** Série dos últimos 4 dias: 10-23 flat → **10-24 +7 (116→123)** → 10-25 flat → **10-26 flat**. Isto **confirma por observação** (não mais por hipótese) que a degradação de supply-chain contra lockfile congelado é **monotônica em degraus**, com advisories chegando em rajadas ~semanais, não diárias. Corolário operacional direto: **a cadência diária observa "nada novo" na maioria das passadas** — argumento quantificado para Ação 3/off-ramp (diária → semanal/event-triggered).

2. **Token-lifecycle (B2) afia para dia 152** (cat. j — postura, não código). Anchor confirmado 1ª-mão hoje (worker-tok sem telemetry-listener + sem probe). Condicional (não-aplicável se tokens forem permanentes), mas é o risco que só o tempo revela — e só um gate em prod resolve (`kubectl logs deploy/bevox-meta-api-worker-tok` + `expires_at` das rows).

3. **GOV-1 — 5ª reincidência (escalada terminal).** A recomendação de pausar o scheduler foi feita em **10-22, 10-23, 10-24 e 10-25** e **não foi actionada**; esta 14ª passada (6ª diária consecutiva) é a prova viva. A decisão está **139 dias atrasada**. `origin/main` não avança desde 2026-06-22 (126d); os **11 commits da série estão TODOS não-pushados**.

> **Fan-out NÃO executado — por desenho.** 10-21 rodou 6 agentes; 10-22 rodou 2 (`invariants-auditor` + `tenant-scope-auditor`, mandato de refutar) → **0 refutação / 0 drift / 0 net-new**; 10-23/24/25 rodaram 0. Repetir o fan-out contra **bytes idênticos** (`git diff` vazio) é exatamente a "invocação por inércia" que a missão §4 proíbe e que GOV-1 denuncia. A verificação desta passada foi **inteira em 1ª mão pelo orquestrador** (Parte A), focada no **único eixo que pode mover sem commit** (CVE — hoje não moveu) + re-anchoragem dos achados de maior severidade. Ver Notas de método.

---

## Achados por severidade (corpus estável; detalhe canônico em 10-21/10-22)

> **Disciplina anti-ritual.** O corpus de ~37 achados é estável e byte-idêntico; reproduzi-lo por extenso numa 14ª passada **é** o sintoma de GOV-1. Abaixo: roll-up com âncora e status; prosa só onde houve 1ª-mão hoje. Detalhe + impacto: [10-22](./runtime-gap-audit-2026-10-22.md) (compacto), [10-21](./runtime-gap-audit-2026-10-21.md) (prosa integral). Severidades rotuladas pelo critério da missão (**bloqueia-piloto** vs **bloqueia-GA**); o piloto `bevox-backend` já roda há 152d, então "bloqueia-piloto" = *risco vivo-ou-iminente ao que está no ar* ou *bloqueia considerá-lo concluído com segurança*.

### CRÍTICO (vivo-ou-iminente para o piloto / bloqueia conclusão)

- **GOV-1 · 14 auditorias, 139d de freeze, ZERO remediação; recomendação de pausar ignorada 4×** (cat. d/l) · **ESCALADO 5ª vez.** 11 commits desde o freeze (10 audit-docs + 1 k8s), 0 de engenharia; **11 não-pushados**. O Ledger não moveu um commit em 14 passadas. **Esforço de descoberta: 0h.** Ação: Kit de Resolução acima.
- **CRÍT-1 · A5 + A5b — perda silenciosa de inbound em blip PG/Redis** (cat. a/h/i) · SURVIVES · **LIVE p/ WABA onboarded.** `inbound/service.ts:298` (`isDuplicate` SET NX antes do insert `:324`, sem `del()` compensatório se o insert falhar); enqueue fora de try/catch (`:388-402`); `operations.ts:98` index não-único em `meta_event_id`. ~6h.
- **CRÍT-2 · es-1 — secret do Meta App (compartilhado c/ V1) + tokens → spans OTel** (cat. d/j) · SURVIVES · CRÍTICO-no-código / **INERTE-em-prod** (egress sem :4318 — 1ª-mão hoje). Corolário: **traces de prod dropados** (MA-007 quebrado). Gate: *traces no Grafana?* ~3-4h scrub **+** abrir :4318.
- **CRÍT-3 · Cross-app PII misdelivery** (cat. a/i/j/f/g) · SURVIVES · CONFIRMED, **liveness LATENTE** (gatilho = **2 apps no mesmo asset Meta**; bevox-direct é greenfield+flag-dormante). Sem unique **global** em `meta_waba_id`/`meta_ig_id`; resolvers sem `orderBy` (`wabas/repository.ts:84-91`, `ig/repository.ts:60-67`); `disconnectWabaByMetaWabaId` (`:187-203`) UPDATE sem scope; `webhook-delivery.ts:123,142` não reverifica `sub.appId == event.appId`. ~3h + testes.
- **CRÍT-4 · MA-012 LGPD `Status: Proposta`, 0/4 critérios, DSR não implementado** (cat. e) · SURVIVES. DSR só helper não-wired (`media-storage.ts:86`). **Bloqueia onboarding novo**, não a operação atual (coberta pelo MSA bevox-backend). Eng ~7h + jurídico.

### ALTO (bloqueia GA; pilot-HIGH em blip de infra)

Roll-up **inalterado** vs [10-22 §ALTO](./runtime-gap-audit-2026-10-22.md) (15 itens, todos SURVIVES), supply-chain re-confirmado hoje (123, flat):

- **NN1** shutdown invertido *(1ª-mão)* · **N1+NN-9a** crash/zumbi *(1ª-mão)* · **NN3** 5 workers sem probe *(1ª-mão: liveness=0)* · **N2/N4/NN5-inv** double-send Meta · **I2+NN1-inv** idempotência race + replay cross-tenant · **NN-9A** mutações admin sem `Idempotency-Key` · **register-phone ausente** · **I8/N8** durabilidade do audit · **NN-9B/9C** read IDOR + soft-del via GET · **HMAC outbound** pode sair não-assinado + 2 formatos · **§3f** OpenAPI factualmente incorreto · **SSRF outbound** (egress-mitigado 443) · **NN-1** HMAC/verify-token secret global · **rlq-2/obs-1/2/3** 429 não-retentado + métricas 0 call-sites.
- **supply-chain (123 CVEs, flat hoje)** *(1ª-mão)* — bump `fastify`≥5.12.5 + `undici`≥8.12.2 + `fast-uri`≥3.1.9 + `zod`≥4.6.6; **drop `@fastify/jwt`** (zera 2 críticas mortas); gate `pnpm audit/test/lint` em CI + Dependabot.

### MÉDIO (degrada qualidade)

Inalterados vs [10-22 §MÉDIO](./runtime-gap-audit-2026-10-22.md) (itens 16-29): **#16 MA-015 de-subscribe órfão** (nenhum `DELETE /{waba_id}/subscribed_apps`, só o POST subscribe em `meta-client.ts:160,538`; note que **MA-015 existe como ADR local mas não no canon** — drift repo↔canon); NN4 Redis sem `noeviction`; es-1 traces dropados; NN5 retenção sem poda; status-reconciliation nunca implementado; N5 media OOM; N9 bodyLimit 413 pré-HMAC; redação incompleta; PII-at-rest.

### BAIXO (higiene)

Inalterados vs [10-22 §BAIXO](./runtime-gap-audit-2026-10-22.md) (itens 30-37): **2 CVE crít `fast-jwt` dep-morta** *(1ª-mão: 0 imports)*; **lint vermelho** 6 (real = `queues.ts:174`) *(1ª-mão)*; imagem pinada `:dbe9fd6` `pullPolicy:Never`; `@types/node@20`; cron re-tica *(GOV-1)*; drift de contrato; **doc-drift** — README:9 "**249 testes**" vs **443 reais** *(1ª-mão)*, `consumer-integration-guide-v1.md` + `go-live-checklist.md` **linkados no README mas AUSENTES do repo** *(1ª-mão)*; `hub.verify_token` não-constant-time; **MA-016 analytics-passthrough** ADR local ausente do canon.

### Cobertura por categoria da missão (a-l)

| cat | Coberto por | 1ª-mão hoje? |
|---|---|---|
| a (spec'd não-impl) | register-phone, DSR, status-reconciliation, §3f, NN-9A | ref |
| b (impl divergente) | §3f, status-reconciliation, envelope de erro | ref |
| c (testes faltando) | `repository.ts` 0% unit; I3 só leitura estática | contagem **443/45** ✓ |
| d (debt) | **1 TODO** (`webhook-delivery.ts:211`); GOV-1; CVE | ✓ grep |
| e (LGPD) | MA-012 `Proposta`, DSR não-wired, I8 audit, NN5 retenção | ref |
| f (OpenAPI drift) | §3f, handlers-fora-do-spec, canon-vs-repo (v1.2.0 repo; **MA-015/16 repo>canon**) | ✓ versão+ADR |
| g (go-live infra) | CNPG `instances:1`, Redis `replicas:1`, **NN3 probes=0** ✓, secrets | ✓ NN3 |
| h (webhook real do piloto) | A5/A5b, **NN1** ✓, es-1 ✓, double-send, NN4, N9 | ✓ NN1+es-1 |
| i (inbound HMAC/idem/replay/size) | HMAC constant-time (PASS), A5 dedup-antes-persist, N9 413, NN-1 | ref |
| j (token mgmt) | MA-008 (PASS), es-1 leak, **token-lifecycle B2** ✓ | ✓ B2 |
| k (rate limit/quota) | rlq-2 429 não-retentado, obs métricas 0 call-sites | ref |
| l (delta vs anterior) | §Delta abaixo | ✓ |

---

## Itens-de-fechamento ordenados por valor/esforço (top 10)

**Não é descoberta nova — é a lista de decisão que não se moveu em 14 passadas.** Substância inalterada vs 10-22…10-25.

| # | Item | Esforço | Destrava |
|---|------|---------|----------|
| 1 | **NN1** — Fastify fecha primeiro (registrar o hook por último **ou** fechar app antes do loop LIFO em `shutdown.ts`) | ~15min | Para o erro espúrio em **todo rollout** — melhor ROI |
| 2 | **NN3 + N1 + NN-9a** — `livenessProbe` nos 5 workers; `db/client.ts` **loga** em vez de `emit("uncaughtException")`; `initTelemetry()` nos workers | ~2h | Fecha o worker-zumbi invisível (inclui o **token-refresher** — risco B2) |
| 3 | **Supply-chain** — bumps (`fastify`/`undici`/`fast-uri`/`zod`); **drop `@fastify/jwt`** (zera 2 críticas mortas); **gate `pnpm audit/test/lint` em CI** + Dependabot | ~2h + rebuild | Fecha altas alcançáveis + a causa-raiz (sobe em degraus com o freeze) |
| 4 | **NN4 + N11 + NN5** — Redis `maxmemory`+`noeviction`+alerta; `commandTimeout`; poda de `webhook_deliveries` | ~2h | Fecha data-loss de fila, hang, crescimento ilimitado |
| 5 | **es-1** — SpanProcessor que apaga `url.full`/`url.query` p/ hosts Meta **+** abrir :4318 no egress (juntos) | ~4h | Fecha o CRÍTICO na origem **e** restaura MA-007 |
| 6 | **A5 + A5b** — `uniqueIndex` em `meta_event_id` + re-drive + wrap do enqueue | ~6h | Bloqueador #1 de inbound (LIVE p/ WABA onboarded) |
| 7 | **cross-app + #16** — `orderBy` determinístico + guard de connect-time + scope em `disconnectWabaByMetaWabaId` + `DELETE /subscribed_apps` no disconnect | ~4h + testes | Fecha PII-misdelivery (latente) + subscription órfã |
| 8 | **Idempotência atômica + fim do double-send + tenant na key + admin idempotente** | ~7h | Para double-send, replay cross-tenant, mutação admin não-idempotente |
| 9 | **Audit síncrono (I8) + NN-9B/9C** | ~5h | Fecha trilha forjável (pré-req MA-012) + IDOR + soft-del leak |
| 10 | **Convergência de contrato (canon→código, incl. merjar branch a14 + MA-015/16)** + patchar exemplo do guia + **MA-012 + RoPa OT-19** | ~2d + jurídico | Desbloqueia onboarding-via-spec (GA) + go-live legal |

---

## Ledger de Decisão consolidado (auto-contido — para a revisão humana de amanhã)

> Objetivo: adjudicação **sem reler 14 auditorias**. Cada linha recebe **[ ] FIX** (commit) **ou** **[ ] ACEITE-DE-RISCO** (assinado). GOV-1 só fecha quando todas estiverem marcadas.

| ID | Achado (1 linha) | Sev | Decisão |
|---|---|---|---|
| GOV-1 | Loop autônomo diário, 0 remediação em 139d, 11 commits não-pushados | CRÍT | [ ] pausar scheduler (Kit §Ação 1) + destino dos commits (§Ação 2) + adjudicar este ledger (§Ação 3) |
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
| #16 MA-015 | Subscription Meta órfã (sem `DELETE /subscribed_apps`); ADR local ausente do canon | MÉD | [ ] FIX · [ ] ACEITE |
| doc-drift | README "249 testes" (real 443); guia+checklist ausentes do repo | BX | [ ] FIX · [ ] ACEITE |
| lint-red | `queues.ts:174` `import()` type annotation | BX | [ ] FIX · [ ] ACEITE |

---

## Dependências cruzadas

- **es-1 / observabilidade** → scrub (es-1) e egress :4318 (obs/MA-007) vão **juntos**. Gate exige SSH a prod.
- **MA-012 / DSR / audit (I8) / retenção (NN5)** → advogado externo + RoPa **OT-19** (ADR-019/020); os gaps de eng **minam a base legal**.
- **Contrato (§3f, drift repo↔canon, guia, MA-015/16)** → PRs em `bevox-knowledge` (SoT por ADR-005; canon **em branch não-merjada há 146d** `fix/a14-…` — a premissa "doc ganha" repousa sobre branch não-merjada, e o repo já tem **MA-015/16** que o canon não tem). Não mudar `signing_secret`/`event_id`/formato HMAC sem coordenar com `bevox-backend`.
- **cross-app + #16** → gatilho é **2 apps no mesmo asset Meta**, não a migração bevox-direct (greenfield+flag). Coordenar c/ futura migração dos boxes embedded do V1.
- **register-phone / ES-COEX / IG / MA-015** → dependem do Meta App compartilhado "Bevox Solutions" + Meta App Review + smoke/e2e contra sandbox.
- **A5/A5b, N1/NN-9a, NN1-NN4, token-lifecycle (B2)** → **compõem no mesmo gatilho** (blip de PG/Redis, rollout). A decisão de infra (single-node c/ RPO explícito **ou** réplica CNPG/Redis) é a de **maior alavancagem**.
- **Supply-chain (123 CVEs)** → sobe em degraus com o freeze; sem Dependabot/CI gate; imagem pinada `:dbe9fd6` `pullPolicy:Never` bloqueia o patch (não chega a prod sem rebuild manual).

---

## Delta vs auditoria anterior (2026-10-25 → 2026-10-26)

**Código / k8s / canon / lockfile:** BYTE-IDÊNTICO em todas as camadas. 1 dia, 0 commits de intervalo.

- **FIXED: 0.** 14ª consecutiva sem remediação de engenharia.
- **SURVIVES: todos.** Re-verificação em 1ª mão dos anchors de maior severidade (NN1, N1/NN-9a, NN3 probes=0, es-1 egress sem :4318, dead-dep `@fastify/jwt` 0-imports, doc-drift): **0 drift**. Placar das 11 invariantes idêntico.
- **NET-NEW de correctness: 0.** Corpus saturado; 14 passadas (incl. 6- e 2-agente fan-outs) convergiram.
- **MOVE mensurável: 0.** **CVE flat 123→123** pelo **2º dia consecutivo** (breakdown idêntico 2·53·58·10). Série 4-dias: flat → **+7** → flat → flat. **Novo saldo de hoje (único acréscimo factual): a tese de "degradação em degraus" sai de hipótese (10-24/25) para confirmada por observação** — o que **quantifica** o argumento do off-ramp (sinal muda ~1×/4d; diária super-amostra).
- **AFIA com o tempo: B2** (token-lifecycle dia 151→152) e todos os freeze-counters +1.
- **GOV-1:** **4ª→5ª reincidência.** Recomendação de pausar (10-22,23,24,25) ignorada 4×; esta passada (6ª diária consecutiva) é a prova. `origin/main` congelado em `5516c2a` (126d); **11 commits locais não-pushados**, 100% `docs(audit)`.
- **Saldo:** a 14ª passada **não acrescenta descoberta de engenharia** — e isso é, ele mesmo, o achado. Em 24h, **zero eixos se moveram**, incluindo o supply-chain pelo 2º dia. O único entregável de valor marginal positivo foi converter o Ledger num **Kit de Resolução acionável (off-ramp)** + quantificar o argumento de cadência.

---

## Notas de método

**Calibração (effort max = rigor, não ritual).** Alvo congelado 139 dias em 4 camadas, 13 passadas prévias (6- e 2-agente fan-outs convergidos a 0 net-new), recomendação explícita de 10-22…10-25 de pausar a série. "Effort max" aqui é **rigor de verificação**, não volume de re-enumeração. O rigor desta passada: provar byte-identidade (`git diff` vazio), re-rodar o toolchain inteiro (typecheck/lint/test), re-rodar `pnpm audit` (o único eixo que pode mover sem commit), re-anchorar em 1ª mão cada achado de maior severidade, checar canon+lockfile+CronList, e **consolidar o off-ramp**. Cortar caminho seria afirmar "nada mudou" sem verificar — o que **não** se fez. Desperdício (a inércia que a missão §4 proíbe) seria re-derivar 37 achados via fan-out de 5 agentes contra bytes idênticos.

**Fan-out NÃO executado — por desenho** (ver box na Parte B). Toda a verificação foi do **orquestrador em 1ª mão**. Agents locais relevantes (`invariants-auditor`, `tenant-scope-auditor`, `webhook-hmac-auditor`, `secrets-redaction-auditor`, `contract-guardian`) **não** foram invocados: contra código byte-idêntico já auditado 13×, invocá-los é a "invocação por inércia" explicitamente vetada pela missão §4 — e 10-21/10-22 já fecharam que seu veredito é 0-refutação/0-net-new.

**Verificado em 1ª mão hoje** (HEAD 721edb8, Node v22.23.3, pnpm 9.15.1): `git diff dbe9fd6..HEAD -- src db` (vazio) + log (0 commits/24h); git log/branch do canon (`fix/a14-…` não-merjada via `branch --contains`, `0317985` 2026-06-02; último ADR/PRD `2148983` 2026-05-22 MA-014) e do lockfile (`a6944d2` 154d); `pnpm typecheck` (verde) / `lint` (6, real=`queues.ts:174`) / `test` (**443/443**) / `audit --prod` (**123** — 2·53·58·10, flat vs 10-25); leitura de `src/index.ts` (ordem NN1 + `initTelemetry` só API + `unhandledRejection`), greps em `shutdown.ts` (LIFO :50 + docstring :5/:12-13), `db/client.ts:51-52` (emit), `initTelemetry` (só index.ts+telemetry.ts), `@fastify/jwt` (**0 imports**), `TODO|FIXME|HACK|XXX|@deprecated` (**1**, `webhook-delivery.ts:211`); `deployment-workers.yaml` (livenessProbe=0, readinessProbe=0; probes só em api/redis/cloudflared); `networkpolicy.yaml` egress (3000/9090/5432/6379/443 + 53 UDP — **sem 4318/4317**); `pnpm audit` fast-uri 19 paths; `CronList` (vazio → cron de host); `openapi.yaml:4` v1.2.0; **ausência** no repo de `consumer-integration-guide-v1.md` + `go-live-checklist.md`; **presença** local de `docs/adr/MA-015-*` e `MA-016-*` (ausentes do canon); README:9/:21 ("249 testes" + link do guia).

**Limitações.** (a) **es-1, A5/A5b, cross-app e token-lifecycle (B2) não confirmados em runtime** — sem acesso a prod nesta sessão. Análise estática é prova forte; cluster vivo + WABAs/tenants por app + `expires_at` + liveness do `worker:tok` não são observáveis pelo código. Gates (traces no Grafana? `worker:tok` vivo? tokens expirando?) exigem SSH a prod — deixados p/ a revisão humana. (b) `test:integration`/`test:e2e` não re-executados (byte-idêntico; 07-20 rodou integração 9/9). (c) Breakdown por-advisory do CVE não diffado item-a-item (não persistido); o delta de **contagem** (123→123) e **severidade** (2·53·58·10 → idem) é 1ª-mão e apples-to-apples. (d) Consumer guide + checklist usados na versão canônica (ausentes do repo).

**Restrição respeitada:** nenhum arquivo de produto foi modificado — este relatório é o único artefato produzido. Nenhuma ação sobre o scheduler de host foi tomada (fora do escopo autorizado; o Kit de Resolução §Ação 1 a deixa pronta para a revisão humana).
