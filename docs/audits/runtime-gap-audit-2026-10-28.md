# Gap Analysis — bevox-meta-api — 2026-10-28

> HEAD `5987426` · Node v22.23.3 · pnpm 9.15.1 · **16ª auditoria** da série (15 prévias) · **8ª em 8 dias consecutivos** (10-21…10-28) · freeze de código **141 dias** (`dbe9fd6` = 2026-06-09). Verificação inteira em 1ª mão hoje (toolchain + infra + git + canon + CVE).

---

## ⚠️ AÇÃO REQUERIDA (revisão humana de amanhã) — inalterada, 7ª vez

**O único eixo que se moveu em 24h foi o contador de CVE (+5). Código, k8s, canon e lockfile: byte-idênticos. Não há descoberta de engenharia pendente há 141 dias. O gargalo é 100% decisório.**

1. **PARAR o gatilho diário** — é ação de *host* (cron do nó `debian`; `CronList` do agente = **vazio** ⇒ não é `/schedule` do Claude; o agente **não consegue** desligar). Confirmado empiricamente: o off-ramp foi entregue em 10-26, pré-adjudicado em 10-27, e **esta 8ª sessão disparou mesmo assim**. O canal revisão→ação não está conectado ao loop.
2. **Adjudicar o Ledger PRÉ-ADJUDICADO** (§ abaixo, reproduzido self-contained de 10-27 + 1 ajuste CVE). 18 linhas, cada uma com recomendação de engenharia; o humano **aprova/sobrepõe + assina**. ~20 min.
3. **Decidir o destino dos 13 commits locais** (100% `docs(audit)`, 0 de engenharia; 128d sem alcançar `origin/main`). Após o commit desta auditoria: **14**.

**Se você só tiver 2 minutos amanhã (Decisão Mínima Viável):** execute a **Ação 1** (parar o cron) e aprove o **Bloco A** (pure-win, ~3.5h de eng, zero risco). Isso encerra o desperdício do loop e limpa a dívida barata. Tudo o mais pode esperar a próxima janela de engenharia sem risco incremental ao piloto que já roda há 154 dias.

---

## Resumo executivo

Estado **inalterado e terminal**, re-provado em 1ª mão hoje. `git diff dbe9fd6..HEAD -- src/ db/` = **vazio** → código de produto **byte-idêntico há 141 dias**. Quatro camadas congeladas: código **141d** (`dbe9fd6`), `origin/main`/k8s **128d** (`5516c2a`), **canon 148d** (branch **não-merjada** `fix/a14-bevox-meta-api-ig-callback-spec`, topo em **MA-014**; repo tem MA-015/016 que o canon **não** tem), **lockfile 156d** (`a6944d2`). V1 em produção servindo `bevox-backend` há **154 dias**.

**Delta real de hoje: um único eixo moveu.** `pnpm audit --prod` subiu **123 → 128 (+5)** após **3 dias flat** — breakdown **2·56·60·10** (era 2·53·58·10; **high +3, moderate +2, crítico e low inalterados**). As 2 críticas seguem sendo `fast-jwt` via `@fastify/jwt`, que tem **0 imports em `src/`** (path morto — re-verificado hoje). O crescimento foi **inteiramente nas bandas alcançáveis** (high/moderate), não em ruído. Série de 8 dias: `116 flat(3d) → +7 (10-24) → 123 flat(3d) → +5 (10-28)`. Isso **re-confirma e quantifica** a tese de degradação de supply-chain em degraus (~a cada 3-4 dias), não diária.

**Zero fixes de engenharia** (16ª passada consecutiva), **zero net-new de correctness** (corpus saturado em ~37 achados, convergido pelos fan-outs de 10-21/10-22). Toolchain 1ª-mão hoje: `typecheck` **verde**, `test` **443/443 verde** (45 arquivos), `lint` **vermelho** (6; único real em `src/` = `queues.ts:174`), **1 TODO real** (`webhook-delivery.ts:211`).

Riscos **para o piloto** inalterados (classe "perda/zumbi silencioso em blip de PG/Redis/rollout": NN1 + N1/NN-9a + A5/A5b + NN3 + NN4; token-lifecycle B2 afia +1d = 154) e **MA-012 LGPD `Proposta`** bloqueando onboarding novo. **Para GA**: contrato §3f incorreto + supply-chain crescendo (**128**) sob lockfile+imagem pinados.

---

## Kit de Resolução (off-ramp) — inalterado desde 10-26, re-afirmado

> **Fato empírico de hoje:** o off-ramp foi projetado para encerrar o loop. 10-26 o entregou; 10-27 pré-adjudicou o Ledger; **10-28 disparou assim mesmo**. A dificuldade não é a decisão (pronta em 3 comandos há 6 dias) — é que **a execução depende de um humano com acesso ao host**, e esse canal não fechou. Nenhuma ação sobre o scheduler de host foi tomada por esta sessão (fora do escopo autorizado).

**Ação 1 — Desligar o gatilho diário (host, ~2 min).** O agente **não pode** (`CronList` vazio ⇒ gatilho externo). No host de dev (`debian`, <DEV_HOST_IP>):
```bash
crontab -l                      # achar a linha que dispara a sessão headless
systemctl --user list-timers    # ou timer de usuário
# remover a entrada OU trocar diária → semanal/event-triggered (ver Nota de cadência)
```

**Ação 2 — Destino dos 13 commits locais (eng, ~5 min).** `origin/main` em `5516c2a` (128d); **13 commits não-pushados, 100% `docs(audit)`**:
```bash
git log --oneline origin/main..HEAD    # revisar os 13
git push origin main                   # (a) publicar as auditorias, OU
git reset --hard 5516c2a               # (b) descartar a série, OU
git rebase -i 5516c2a                  # (c) esmagar em 1 commit "docs(audit): série de freeze 07-04…10-28"
```

**Ação 3 — Adjudicar o Ledger PRÉ-ADJUDICADO** (§ abaixo). Não é "decidir do zero": é "revisar a recomendação". Mínimo defensável p/ o piloto seguir no ar: aprovar o **Bloco A (pure-win, ~3.5h)** + os **2 gates de prod** (es-1 traces, B2 token/worker) + aceites-de-risco assinados sobre A5/A5b, cross-app e MA-012.

> **Nota de cadência (re-quantificada hoje):** o único eixo capaz de mover sem commit é o CVE, e ele moveu **2× em 8 dias** (10-24 +7, 10-28 +5) — passos a cada ~3-4 dias. Uma cadência **diária** observa "nada novo" em **6 de 8 passadas (75%)**. Mesmo concedendo ao loop um propósito legítimo de *watch* de supply-chain, a amostragem correta é **semanal ou event-triggered** (disparar só em commit a `src/`/`db/` ou bump de `pnpm-lock.yaml`), não diária — hoje a diária **super-amostra o único sinal vivo por ~3-4×**.

---

## Ledger de Decisão PRÉ-ADJUDICADO (centro acionável desta auditoria)

> **Como usar:** cada linha traz a recomendação de engenharia. Marque **[x] APROVA** (vira commit/ação) **ou** **[ ] SOBREPÕE →** (decisão alternativa + assinatura). GOV-1 só fecha quando **todas** estão resolvidas. Detalhe canônico + impacto por item: [10-22](./runtime-gap-audit-2026-10-22.md) (compacto) / [10-21](./runtime-gap-audit-2026-10-21.md) (prosa). Severidade pelo critério da missão (piloto roda há 154d ⇒ "bloqueia-piloto" = risco vivo-ou-iminente ao que está no ar). Evidências re-ancoradas em 1ª mão hoje onde marcado **(1ª-mão 10-28)**.

### Bloco A — FIX agora / "pure-win" (sem risco, barato; fazer esta semana independente do resto) — ~3.5h total

| ID | Achado (evidência) | Sev | Recomendação | Esf |
|---|---|---|---|---|
| **NN1** | Shutdown LIFO fecha Fastify **por último**. **(1ª-mão 10-28)** `index.ts:28-33` registra `fastify→queues→event-bus→postgres→redis→telemetry`; `shutdown.ts:50` roda LIFO ⇒ execução real `telemetry→redis→postgres→event-bus→queues→fastify`. Docstring `index.ts:4-8` e `shutdown.ts:3-13` dizem "Fastify primeiro" — **contradição direta**. Requests in-flight no SIGTERM batem em pool já fechado → 500 espúrio em **todo rollout**. | ALTO | **FIX.** Registrar o hook `fastify` **por último** (ou fechar o app antes do loop LIFO). Melhor ROI da auditoria. | ~15min |
| **N1/NN-9a** | **(1ª-mão 10-28)** `db/client.ts:52` faz `process.emit("uncaughtException")` manual; **0** `process.on("uncaughtException")` em todo `src/`; `initTelemetry()` só em `index.ts:23` (API) — **nenhum worker importa `initTelemetry`** (token-refresh.ts importa event-bus/crypto/errors/logger/metrics/redis/shutdown/worker-metrics-server/meta-client, **não** telemetry). Erro de pool em worker é **engolido** → worker-zumbi. | ALTO | **FIX.** Trocar o `emit` por log estruturado + exit explícito; chamar `initTelemetry()` nos workers. | ~1h |
| **NN3** | **(1ª-mão 10-28)** `deployment-workers.yaml`: os **5** Deployments de worker expõem `containerPort: 9090` e o `/healthz` existe (`worker-metrics-server.ts:74-78`), mas **nenhum** define `livenessProbe`/`readinessProbe` (api tem). k8s **não reinicia** um zumbi (via N1/NN-9a). | ALTO | **FIX.** Adicionar `livenessProbe` (GET `/healthz` :9090) aos 5 Deployments. | ~1h |
| **NN4** | Redis sem `maxmemory-policy noeviction` → sob pressão de memória, BullMQ perde jobs **silenciosamente**. | ALTO | **FIX.** `noeviction` + alerta de `used_memory`. | ~30min |
| **doc-drift** | **(1ª-mão 10-28)** `README.md:9,78` diz "**249 testes**" (real **443**); `:21,:63,:65` linkam `consumer-integration-guide-v1.md` + `go-live-checklist.md` **ausentes do repo** (`find`=0; vivem só no canon). Além disso `docs/adr/` tem só MA-015/016/README — MA-001..MA-014 foram movidos p/ canon (`docs/adr/README.md` o diz), mas README§Estrutura:60 e CLAUDE.md §2 ainda descrevem "MA-001..MA-008, MA-012" como estando em `docs/adr/`. | BX | **FIX.** Corrigir a contagem + resolver os links mortos (adicionar os 2 docs ao repo OU apontar ao canon) + alinhar a descrição de `docs/adr/`. | ~30min |
| **lint-red** | **(1ª-mão 10-28)** `src/lib/queues.ts:174:19` `import()` type annotation proibida (`@typescript-eslint/consistent-type-imports`). Único erro real; 4 dos outros 5 são snippets de skill fora do tsconfig; 1 é o arquivo **untracked** `.claude/tmp-gap-audit-workflow.mjs` (lixo de sessão anterior — não commitar). | BX | **FIX.** `import type` em `queues.ts`; remover o `.mjs` órfão. | ~5min |

### Bloco B — Gates de prod (settle barato via SSH; podem rebaixar o risco sem código)

| ID | Achado | Sev | Recomendação | Esf |
|---|---|---|---|---|
| **B2** | Token-refresher (`worker-tok`, **singleton** `replicas:1`) pode ter zumbificado há 154d (compõe N1/NN-9a + NN3). **Não observável pelo código.** Se tokens Meta forem de vida finita e o worker estiver morto, as chamadas Meta do piloto quebram ao expirar. | ALTO | **GATE.** `kubectl logs deploy/bevox-meta-api-worker-tok` + checar `expires_at` das rows. Tokens long-lived/permanentes → **ACEITE** (risco não-aplicável). | ~15min |
| **es-1** | **(1ª-mão 10-28)** `configmap.yaml:50` aponta OTLP p/ `otel-collector.monitoring.svc.cluster.local:4318`, mas `networkpolicy.yaml` egress libera só UDP53 + TCP 5432/6379/443 — **não** 4318/4317. ⇒ traces de prod são **dropados no egress** (MA-007 quebrado). Efeito colateral benigno: o risco histórico "spans carregam secret do Meta App compartilhado c/ V1" fica **inerte** enquanto o egress bloqueia (traces nunca saem do pod). | CRÍT | **GATE + FIX-pré-GA.** Gate: *há traces no Grafana?* Se não (esperado) → observabilidade cega. Fix (pré-GA): abrir :4318 **e** scrub de span **juntos** (abrir sem scrub reativa o leak). | ~4h |

### Bloco C — FIX pré-GA (bloqueia GA; LIVE/latente conforme gatilho)

| ID | Achado | Sev | Recomendação | Esf |
|---|---|---|---|---|
| **A5/A5b** | `inbound/service.ts:298` `isDuplicate` (SET NX) **antes** do insert `:324` sem `del()` compensatório; enqueue fora de try/catch `:388-402`; `operations.ts:98` index **não-único** em `meta_event_id`. Perda silenciosa de inbound em blip PG/Redis. **LIVE p/ WABA onboarded.** | CRÍT | **FIX.** `uniqueIndex` em `meta_event_id` + re-drive + wrap do enqueue. | ~6h |
| **cross-app** | Sem unique **global** em `meta_waba_id`/`meta_ig_id`; resolvers sem `orderBy` (`wabas/repository.ts:84-91`, `ig/repository.ts:60-67`); `disconnectWabaByMetaWabaId:187-203` UPDATE sem scope; `webhook-delivery.ts:123,142` não reverifica `sub.appId==event.appId`. PII misdelivery. **Latente** (gatilho = 2 apps no mesmo asset Meta; bevox-direct é greenfield+flag). | CRÍT | **ACEITE-com-guard agora + FIX antes do 2º app.** `orderBy` determinístico + guard de connect-time antes de qualquer 2º app compartilhar asset Meta. | ~3h |
| **MA-012** | **(1ª-mão 10-28)** LGPD `Status: Proposta` no canon (confirmado), 0/4 critérios; DSR só helper não-wired (`media-storage.ts:86`). **Bloqueia onboarding novo**, não a operação atual (coberta pelo MSA bevox-backend). | CRÍT | **ESCALAR p/ jurídico agora** (carimbo) + wire DSR em paralelo (eng). | ~7h + jurídico |
| **supply-chain** | **(1ª-mão 10-28)** `pnpm audit --prod`=**128** (2·56·60·10; +5 vs 10-27). 2 críticas = `fast-jwt` via `@fastify/jwt` (**0 imports** ⇒ path morto). Highs alcançáveis: `fast-uri` (GHSA-333x-w4r6-6crp), `undici`, `fastify`-core, `zod`, `@grpc/grpc-js`+`protobufjs` (via `@google-cloud/kms`, alcançável pq `KMS_PROVIDER=gcp`). O +5 de hoje é todo em high/moderate. | ALTO | **FIX.** `drop @fastify/jwt` (zera as 2 críticas mortas de graça) + bump `fastify`/`undici`/`fast-uri`/`zod` + **gate `pnpm audit --prod` em CI** + Dependabot (causa-raiz: sem gate, cresce em degraus com o freeze). | ~2h + rebuild |
| **double-send** | N2/N4 double-send Meta + idempotência race (I2) + replay cross-tenant (key sem tenant). | ALTO | **FIX.** Idempotência atômica + `tenant_id` na key. | ~7h |
| **I8/N8** | Audit assíncrono (plugin `audit-log.ts`) → trilha forjável/perdível. Pré-req de MA-012. | ALTO | **FIX.** Write de audit síncrono/transacional com a mutação. | ~3h |
| **NN-9A/B/C** | Mutações admin sem `Idempotency-Key`; read IDOR; soft-delete via GET. | ALTO | **FIX.** Idempotência no admin + authz nos reads + hardening de método. | ~3h |
| **§3f** | Envelope de `/v1/messages` no OpenAPI **factualmente incorreto** vs código. Consumer-facing. | ALTO | **FIX** (doc, na branch do canon). Corrigir o envelope p/ bater com o código. | ~1h |

### Bloco D — MÉDIO/BAIXO (higiene; agrupar num PR)

| ID | Achado | Sev | Recomendação | Esf |
|---|---|---|---|---|
| **#16 MA-015** | Nenhum `DELETE /{waba_id}/subscribed_apps` no disconnect (só o POST subscribe em `meta-client.ts:160,538`) → subscription Meta **órfã**. MA-015/016 existem como ADR **local** mas **ausentes do canon** (confirmado: canon topa em MA-014). | MÉD | **FIX** + merjar MA-015/016 ao canon. | ~2h |
| outros | NN5 retenção sem poda; status-reconciliation nunca impl.; N5 media OOM; N9 bodyLimit 413 pré-HMAC; redação incompleta; PII-at-rest; `hub.verify_token` não-constant-time; `@types/node@20`; imagem pinada `:dbe9fd6 pullPolicy:Never`. | MÉD/BX | Ver [10-22 §MÉDIO/§BAIXO](./runtime-gap-audit-2026-10-22.md). Agrupar. | — |

---

## Parte A — Ground-truth (orquestrador, 1ª mão, 2026-10-28, HEAD 5987426)

| Verificação | Resultado 2026-10-28 | vs 2026-10-27 |
|---|---|---|
| `git diff dbe9fd6..HEAD -- src/ db/` | **vazio** (byte-idêntico) | igual |
| Freeze de código (src/db) | **141 dias** (`dbe9fd6` = 2026-06-09; último commit a `src/`) | +1 dia |
| Freeze de `origin/main`/k8s | **128 dias** (`5516c2a` = 2026-06-22) | +1 dia |
| Freeze do **canon** | **148 dias** (`0317985` = 2026-06-02; branch `fix/a14-bevox-meta-api-ig-callback-spec` **não-merjada**; topo = **MA-014**) | +1 dia |
| Freeze do **lockfile** | **156 dias** (`a6944d2` = 2026-05-25) | +1 dia |
| Piloto vivo (`bevox-backend`) | **154 dias** (desde 2026-05-27) | +1 dia |
| Commits ahead de `origin/main` | **13**, **100% `docs(audit)`**, **0 de engenharia** | +1 (o audit 10-27) |
| Commits nas últimas 24h | **0** (nada desde o audit 10-27) | — |
| `pnpm typecheck` | **VERDE** (exit 0) | igual |
| `pnpm lint` | **VERMELHO** — 6 (único real `src/`: `queues.ts:174`; 4 = snippets fora do tsconfig; 1 = `.mjs` untracked órfão) | igual |
| `pnpm test` (unit) | **443/443 VERDE** (45 arquivos, ~17s) | igual |
| `pnpm audit --prod` | **128** (**2·56·60·10**) | **+5** (high +3, mod +2; crít/low flat) |
| Debt markers em `src/` | **1 TODO** real (`webhook-delivery.ts:211`); 0 FIXME/HACK/XXX/@deprecated | igual |
| OpenAPI (repo) `info.version` | **1.2.0** (`openapi.yaml:4`); ~30 paths | igual |
| Consumer guide / go-live-checklist **no repo** | **AUSENTES** (vivem só no canon; linkados no README) | igual |
| ADRs locais vs canon | `docs/adr/` = **MA-015 + MA-016** + README; canon topa em MA-014 → **repo à frente, canon sem MA-015/16** | igual |

### Anchors de maior severidade re-verificados em 1ª mão hoje (0 drift)

> O `git diff` vazio **prova** que todo achado derivado de `src/`/`db/` é byte-idêntico; as re-leituras abaixo re-citam linhas/infra em 1ª mão.

- **NN1** — `index.ts:28-33` ordem de registro + docstring `:4-8` ("Fastify primeiro") contradita pelo LIFO `shutdown.ts:50`. **CONFIRMADO.**
- **N1/NN-9a** — `db/client.ts:52` emit manual; 0 `process.on("uncaughtException")`; workers sem `initTelemetry`. **CONFIRMADO.**
- **NN3** — `deployment-workers.yaml` liveness/readiness ausentes nos 5 workers; `/healthz` existe em `worker-metrics-server.ts:74`. **CONFIRMADO.**
- **es-1** — `networkpolicy.yaml` egress sem 4318/4317; `configmap.yaml:50` OTLP→:4318. **CONFIRMADO.**
- **tenant-scope (NN-I3)** — **não existe** `src/plugins/tenant-scope.ts` (plugins reais: audit-log, auth-admin, auth-jwt-consumer, idempotency, rate-limit-buckets); scoping é manual via `request.auth.appId` (decorado por `auth-jwt-consumer.ts:12`). CLAUDE.md §4-inv3 descreve um plugin de injeção automática que não existe como tal. **CONFIRMADO** (scoping real = allowlist via `iss` do JWT, defense-in-depth no repositório).
- **Dead-dep** — `grep @fastify/jwt src/` = **0**; as 2 críticas `fast-jwt` são só via ele. **CONFIRMADO.**
- **CVE** — `pnpm audit --prod` = **128** (2·56·60·10). **MOVEU +5** vs 10-25/26/27 (123).

### Pontos sólidos re-confirmados (não-achados)

UUIDv7 (I1); HMAC inbound constant-time ANTES do parse (I9); MA-008 envelope + zeroize; JWT RS256/kid/TTL (I5); `app_id` sempre do JWT assinado `iss` (não-spoofável); envelope de erro canônico Bevox (`{error:{code,message,details,request_id}}`, não-RFC7807); nenhuma credencial Meta em response schema. **Placar das 11 invariantes idêntico** a 10-21…10-27 (ver [§Parte E do 10-22](./runtime-gap-audit-2026-10-22.md)).

---

## Achados por severidade (corpus estável; detalhe em 10-21/10-22)

> **Disciplina anti-ritual.** Corpus de ~37 achados byte-idêntico há 141 dias; reproduzi-lo por extenso numa 16ª passada **é** o sintoma de GOV-1. Roll-up com âncora; a substância acionável vive no Ledger pré-adjudicado acima.

### CRÍTICO (vivo-ou-iminente p/ piloto / bloqueia conclusão)
- **GOV-1** — 16 auditorias, 141d de freeze, ZERO remediação; pausar ignorado 6× (off-ramp de 10-26 + Ledger pré-adjudicado de 10-27 não-actionados; esta 8ª sessão diária é a prova). 13 commits não-pushados. Esforço de descoberta: **0h**. **ESCALADO 7ª vez.**
- **CRÍT-1 A5/A5b** · SURVIVES · LIVE p/ WABA onboarded. (Ledger Bloco C)
- **CRÍT-2 es-1** · SURVIVES · traces dropados em prod / leak inerte. (Ledger Bloco B)
- **CRÍT-3 cross-app** · SURVIVES · latente (gatilho = 2 apps/asset). (Ledger Bloco C)
- **CRÍT-4 MA-012** · SURVIVES · bloqueia onboarding novo. (Ledger Bloco C)

### ALTO (bloqueia GA; pilot-HIGH em blip de infra)
Roll-up **inalterado** vs [10-22 §ALTO](./runtime-gap-audit-2026-10-22.md) (15 itens, todos SURVIVES): **NN1 · N1/NN-9a · NN3 · B2 · NN4 · double-send(N2/N4/I2) · NN-9A/B/C · register-phone ausente · I8/N8 · HMAC-outbound(sem-assinar+2-formatos) · §3f · SSRF-outbound(egress-mitigado) · rlq-2/obs-1/2/3**. Supply-chain **128, +5** *(1ª-mão)*.

### MÉDIO (degrada qualidade)
Inalterados vs [10-22 §MÉDIO](./runtime-gap-audit-2026-10-22.md): #16 MA-015 de-subscribe órfão (+drift repo↔canon); NN4 `noeviction`; es-1 traces; NN5 poda; status-reconciliation; N5 media OOM; N9 413 pré-HMAC; redação incompleta; PII-at-rest.

### BAIXO (higiene)
Inalterados vs [10-22 §BAIXO](./runtime-gap-audit-2026-10-22.md): 2 CVE crít `fast-jwt` dep-morta *(1ª-mão: 0 imports)*; lint vermelho `queues.ts:174` + `.mjs` órfão untracked *(1ª-mão)*; imagem pinada `:dbe9fd6 pullPolicy:Never`; `@types/node@20`; cron re-tica *(GOV-1)*; doc-drift README "249"≠443 + guia/checklist ausentes + `docs/adr/` divergente da descrição *(1ª-mão)*; `hub.verify_token` não-constant-time; MA-016 ausente do canon.

### Cobertura por categoria da missão (a-l)

| cat | Coberto por | 1ª-mão hoje? |
|---|---|---|
| a (spec'd não-impl) | register-phone, DSR, status-reconciliation, §3f, NN-9A | ref |
| b (impl divergente) | §3f, status-reconciliation, envelope de erro, tenant-scope (inv3 descreve plugin inexistente) | ✓ (NN-I3) |
| c (testes faltando) | `repository.ts` 0% unit; contagem **443/45** | ✓ |
| d (debt) | **1 TODO** (`webhook-delivery.ts:211`); GOV-1; CVE | ✓ grep |
| e (LGPD) | MA-012 `Proposta` *(1ª-mão canon)*, DSR não-wired, I8, NN5 | ✓ |
| f (OpenAPI drift) | §3f, canon-vs-repo (v1.2.0; MA-015/16 repo>canon) | ✓ |
| g (go-live infra) | CNPG `instances:1`, Redis `replicas:1`, **NN3 probes=0** | ✓ |
| h (webhook real do piloto) | A5/A5b, **NN1**, **es-1**, double-send, NN4, N9 | ✓ |
| i (inbound HMAC/idem/replay/size) | HMAC constant-time (PASS), A5 dedup-antes-persist, N9 | ref |
| j (token mgmt) | MA-008 (PASS), es-1 leak, **token-lifecycle B2** | ✓ B2 |
| k (rate limit/quota) | rlq-2 429 não-retentado, obs 0 call-sites | ref |
| l (delta vs anterior) | §Delta abaixo | ✓ |

---

## Itens-de-fechamento ordenados por valor/esforço (top 10)

**Não é descoberta — é a ordem de execução do Ledger.** Inalterado em substância vs 10-22…10-27.

| # | Item (Ledger) | Esforço | Destrava |
|---|------|---------|----------|
| 1 | **NN1** (Bloco A) | ~15min | Para o 500 espúrio em **todo rollout** — melhor ROI |
| 2 | **NN3 + N1/NN-9a + NN4** (Bloco A) | ~2.5h | Fecha o worker-zumbi invisível (inclui token-refresher/B2) + data-loss de fila |
| 3 | **lint + doc-drift** (Bloco A) | ~35min | Higiene barata; destrava "verde" e README honesto |
| 4 | **Gates de prod: es-1 (traces?) + B2 (worker/tokens?)** (Bloco B) | ~30min SSH | Rebaixa 1 CRÍT e 1 ALTO sem código, se os gates derem o esperado |
| 5 | **Supply-chain** (Bloco C) | ~2h + rebuild | Zera 2 críticas mortas + altas alcançáveis + causa-raiz (CI gate). **+5 hoje reforça urgência relativa** |
| 6 | **es-1 fix (scrub + :4318)** (Bloco B) | ~4h | Fecha o CRÍTICO na origem **e** restaura MA-007 |
| 7 | **A5/A5b** (Bloco C) | ~6h | Bloqueador #1 de inbound (LIVE p/ WABA onboarded) |
| 8 | **cross-app guard + #16** (Bloco C/D) | ~4h | Fecha PII-misdelivery (latente) + subscription órfã |
| 9 | **double-send + I8 + NN-9A/B/C** (Bloco C) | ~10h | Para double-send/replay + trilha forjável (pré-MA-012) + IDOR |
| 10 | **Convergência de contrato (§3f + merjar a14 + MA-015/16) + MA-012 + RoPa** | ~2d + jurídico | Desbloqueia onboarding-via-spec (GA) + go-live legal |

---

## Dependências cruzadas

- **es-1 / observabilidade** → scrub (es-1) e egress :4318 (MA-007) vão **juntos**; gate exige SSH a prod.
- **MA-012 / DSR / audit (I8) / retenção (NN5)** → advogado externo + RoPa (ADR-019/020); os gaps de eng **minam a base legal**.
- **Contrato (§3f, drift repo↔canon, guia, MA-015/16)** → PRs em `bevox-knowledge` (SoT por ADR-005; canon **em branch não-merjada há 148d** `fix/a14-…` — a premissa "doc ganha" repousa em branch não-merjada, e o repo já tem MA-015/16 que o canon não tem). Não mudar `signing_secret`/`event_id`/formato HMAC sem coordenar com `bevox-backend`.
- **cross-app + #16** → gatilho é **2 apps no mesmo asset Meta**, não a migração bevox-direct (greenfield+flag). Coordenar c/ futura migração dos boxes embedded do V1.
- **A5/A5b, N1/NN-9a, NN1-NN4, B2** → **compõem no mesmo gatilho** (blip de PG/Redis, rollout). A decisão de infra (single-node c/ RPO explícito **ou** réplica CNPG/Redis) é a de **maior alavancagem**.
- **Supply-chain (128 CVEs)** → sobe em degraus com o freeze; sem Dependabot/CI gate; imagem pinada `:dbe9fd6 pullPolicy:Never` bloqueia o patch (não chega a prod sem rebuild manual).

---

## Delta vs auditoria anterior (2026-10-27 → 2026-10-28)

**Código / k8s / canon / lockfile:** BYTE-IDÊNTICO em todas as camadas. 1 dia, 0 commits de intervalo.

- **FIXED: 0.** 16ª consecutiva sem remediação de engenharia.
- **SURVIVES: todos.** Re-verificação 1ª-mão dos anchors de maior severidade (NN1, N1/NN-9a, NN3, es-1, NN-I3 tenant-scope, dead-dep `@fastify/jwt`, doc-drift, OpenAPI 1.2.0, canon MA-014/branch-não-merjada, MA-012 `Proposta`): **0 drift**. Placar das 11 invariantes idêntico. Toolchain idêntico (typecheck verde / 443 verde / lint 6 / 1 TODO).
- **NET-NEW de correctness: 0.** Corpus saturado; 16 passadas convergiram.
- **MOVE mensurável: 1 (único eixo vivo).** **CVE +5 (123→128)** após 3 dias flat; breakdown 2·56·60·10 (high +3, mod +2; crít/low flat). Série 8-dias: `116 flat×3 → +7 → 123 flat×3 → +5`. A tese "degradação em degraus ~a-cada-3-4-dias" passa de **reforçada** (10-27) a **quantificada por 2 passos observados** (10-24, 10-28). O crescimento está nas bandas **alcançáveis** (high/mod), não em ruído — sharpening de "supply-chain" de ALTO estável para ALTO-com-tendência.
- **AFIA com o tempo: B2** (token-lifecycle 153→154) e todos os freeze-counters +1.
- **GOV-1:** **6ª→7ª reincidência.** O Ledger pré-adjudicado de 10-27 (a "última peça" para a Ação 3) **não foi actionado** — esta sessão (8ª diária) é a prova empírica de que o loop não se auto-encerra e o canal revisão→ação permanece aberto.
- **NET-NEW desta passada:** (1) a **medição do passo CVE +5** e a **re-quantificação da cadência** (2 passos/8 dias ⇒ diária super-amostra 3-4×); (2) a **Decisão Mínima Viável de 2 min** (parar cron + aprovar Bloco A) — reduz ainda mais a energia de ativação da revisão, já que até o off-ramp de 3 comandos e o Ledger pré-adjudicado foram ignorados 6×; (3) re-ancoragem 1ª-mão do **NN-I3 tenant-scope** (plugin inexistente) e do **MA-012 `Proposta` no canon**.
- **Saldo:** a 16ª passada **não acrescenta descoberta de correctness** — e isso, de novo, É o achado. Em 24h, **1 de ~N eixos se moveu** (CVE), e esse é precisamente o eixo que **não requer** uma auditoria diária para ser observado.

---

## Notas de método

**Calibração (effort max = rigor, não ritual).** Alvo congelado 141 dias em 4 camadas, 15 passadas prévias (fan-outs 6- e 2-agente convergidos a 0 net-new), off-ramp + Ledger pré-adjudicado não-actionados. "Effort max" aqui = **rigor de verificação + inverter/afiar a peça decisória**, **não** volume de re-enumeração. Rigor desta passada: provar byte-identidade (`git diff dbe9fd6..HEAD -- src/ db/` vazio), re-rodar o toolchain inteiro (typecheck/lint/test em 1ª-mão), re-medir `pnpm audit --prod` **apples-to-apples** (o único eixo que pode mover sem commit — um scan sem `--prod` deu 172 incluindo devDeps; o prod-only comparável da série é **128**), re-anchorar 1ª-mão cada achado de maior severidade + infra (networkpolicy/configmap/deployment-workers/event-bus/worker-metrics-server/plugins/index/shutdown), checar canon+branch+lockfile. O desperdício vetado pela missão §4 seria re-derivar 37 achados via fan-out de 5 agentes contra bytes idênticos.

**Fan-out NÃO executado — por desenho.** 10-21 rodou 6 agentes; 10-22 rodou 2 (`invariants-auditor`+`tenant-scope-auditor`) → **0 refutação / 0 drift / 0 net-new**; 10-23…10-28 rodaram 0. Repetir o fan-out contra **bytes idênticos** (`git diff` vazio) é exatamente a "invocação por inércia" que a missão §4 proíbe. Agents locais existentes e relevantes (`invariants-auditor`, `tenant-scope-auditor`, `webhook-hmac-auditor`, `secrets-redaction-auditor`, `contract-guardian`, + `adr-author`/`endpoint-implementer`/`migration-author` — 8 no total em `.claude/agents/`) **não** foram invocados pela mesma razão. Verificação inteira do **orquestrador em 1ª mão**.

**Verificado em 1ª mão hoje** (HEAD `5987426`, Node v22.23.3, pnpm 9.15.1): `git diff dbe9fd6..HEAD` (vazio p/ src/db) + `rev-list` (**13** ahead de `origin/main`, 100% `docs(audit)`; `5516c2a` 2026-06-22); último commit a `src/` = `dbe9fd6` (2026-06-09) e a `db/` = `6c50e93` (2026-05-07); canon via `$BEVOX_KNOWLEDGE_PATH=$BEVOX_KNOWLEDGE_PATH` (branch `fix/a14-bevox-meta-api-ig-callback-spec`, `0317985` 2026-06-02, ADRs topam em MA-014 — MA-012 `Status: Proposta`; PRD `2026-05-08-…` presente); lockfile `a6944d2` 2026-05-25; `typecheck` (verde, exit 0) / `lint` (6: real `queues.ts:174`, 4 snippets fora do tsconfig, 1 `.mjs` untracked) / `test` (**443/443**, 45 arq) / `audit --prod` (**128** = 2·56·60·10); greps em `src/`: `@fastify/jwt` (**0**), `TODO|FIXME|HACK|XXX|@deprecated` (**1** real, `webhook-delivery.ts:211`); `src/plugins/` (sem `tenant-scope.ts`); leitura de `src/index.ts:1-45` (ordem de hooks) + `src/lib/shutdown.ts:1-60` (LIFO) + `src/lib/event-bus.ts` (Redis pub/sub fire-and-forget) + `src/lib/worker-metrics-server.ts` (/healthz existe) + `k8s/networkpolicy.yaml` (egress sem 4318) + `k8s/configmap.yaml:50` (OTLP→:4318) + `k8s/deployment-workers.yaml` (5 workers sem probes); `docs/adr/` (só MA-015/016/README) vs `docs/adr/README.md` (move p/ canon); `openapi.yaml:4` (1.2.0, ~30 paths); ausência no repo de `consumer-integration-guide-v1.md` + `go-live-checklist.md`; `README.md:9,21,63,65,78` ("249 testes" + links mortos); `CronList` (**vazio** ⇒ gatilho de host).

**Limitações.** (a) **es-1, A5/A5b, cross-app e B2 não confirmados em runtime** — sem acesso a prod nesta sessão. Análise estática é prova forte; cluster vivo + WABAs/tenants por app + `expires_at` + liveness do `worker:tok` não são observáveis pelo código. Os **gates do Bloco B** exigem SSH a prod — deixados p/ a revisão humana. (b) `test:integration`/`test:e2e` não re-executados (byte-idêntico; 07-20 rodou integração 9/9). (c) PRD/ADRs canônicos consumidos por referência (ADR-005); o mapeamento de gaps é estável há 15 passadas contra código byte-idêntico — o fato material verificado hoje é que **o canon em si não se moveu** (148d, branch não-merjada) e **MA-012 segue `Proposta`**. (d) Consumer guide + checklist usados na versão canônica (ausentes do repo).

**Restrição respeitada:** nenhum arquivo de produto foi modificado — este relatório é o único artefato produzido. Nenhuma ação sobre o scheduler de host foi tomada (fora do escopo autorizado; o Kit de Resolução §Ação 1 a deixa pronta para a revisão humana). O arquivo untracked `.claude/tmp-gap-audit-workflow.mjs` (lixo de sessão anterior) **não** foi incluído no commit.
