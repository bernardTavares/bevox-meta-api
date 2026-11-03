# Gap Analysis — bevox-meta-api — 2026-10-27

> HEAD `50dfc7e` · Node v22.23.3 · pnpm 9.15.1 · **15ª auditoria** da série (14 prévias) · **7ª em 7 dias consecutivos** (10-21…10-27) · freeze de código **140 dias** (`dbe9fd6` = 2026-06-09). Verificação inteira em 1ª mão hoje.

---

## ⚠️ AÇÃO REQUERIDA (revisão humana de amanhã)

1. **PAUSAR o gatilho diário** — ação de *host*, o agente não consegue (ver Kit §Ação 1). O off-ramp de 10-26 não foi actionado: **esta sessão disparou mesmo assim** ⇒ o loop não se auto-encerra.
2. **Adjudicar o Ledger PRÉ-ADJUDICADO** abaixo — não há mais "decidir do zero": cada item já traz **recomendação de engenharia**; o humano **aprova ou sobrepõe + assina**. 18 linhas, ~20 min de leitura.
3. **Decidir o destino dos 12 commits locais** (100% `docs(audit)`, 0 de engenharia, 127d sem alcançar `origin/main`).

**Não há descoberta de engenharia pendente. O gargalo é 100% decisório, há 140 dias.**

---

## Resumo executivo

Estado **inalterado e terminal**, re-provado em 1ª mão hoje. `git diff dbe9fd6..HEAD -- src/ package.json pnpm-lock.yaml drizzle/` = **vazio** → o código de produto é **byte-idêntico há 140 dias**. As quatro camadas seguem congeladas: código **140d** (`dbe9fd6`), k8s/`origin/main` **127d** (`5516c2a`), **canon 147d** (ainda na branch **não-merjada** `fix/a14-bevox-meta-api-ig-callback-spec` `0317985`, que topa em **MA-014** — o repo tem MA-015/016 que o canon **não** tem), **lockfile 155d** (`a6944d2`). V1 em produção servindo `bevox-backend` há **153 dias**. **Delta real de hoje: ZERO em TODOS os eixos** — e, pelo **3º dia consecutivo, nem o CVE se moveu** (`pnpm audit --prod` = 123, breakdown idêntico **2·53·58·10**). A série CVE dos últimos 5 dias — 10-23 flat → **10-24 +7** → 10-25 flat → 10-26 flat → **10-27 flat** — **confirma por observação** (não mais por hipótese) que a degradação de supply-chain contra lockfile congelado é **monotônica em degraus ~semanais, não diária**: 1 passo em 5 dias ⇒ a cadência diária **super-amostra o sinal por ~5×**.

**Zero fixes de engenharia** (15ª passada consecutiva), **zero net-new de correctness** (corpus saturado em ~37 achados, convergido pelos fan-outs de 6- e 2-agentes de 10-21/10-22). Toolchain re-rodado 1ª-mão: `typecheck` **verde**, `test` **443/443 verde** (15ª consecutiva, 45 arquivos), `lint` **vermelho** (6 — único real em `src/` é `queues.ts:174`), **1 TODO real** (`webhook-delivery.ts:211`).

Riscos **para o piloto** inalterados (classe "perda/zumbi silencioso em blip de PG/Redis/rollout": NN1 + N1/NN-9a + A5/A5b + NN3 + NN4; token-lifecycle B2 afiado +1 dia = 153) e **MA-012 LGPD `Proposta`** bloqueando onboarding novo. **Para GA**: contrato §3f incorreto + supply-chain congelado em 123 CVEs (patch bloqueado por imagem pinada).

**O único entregável de valor marginal positivo possível nesta 15ª passada** — e o que esta auditoria faz — é **inverter a última peça que faltava**: o Ledger de 10-26 listou 18 decisões mas deixou **toda célula em branco**. Aqui elas vêm **pré-adjudicadas** (recomendação de engenharia por item). Isso colapsa o trabalho da revisão de "decidir 18 coisas" para "aprovar/sobrepor 18 recomendações + assinar".

---

## Kit de Resolução (off-ramp) — sharpened 2026-10-27

> **Observação nova e factual de hoje:** o off-ramp de 10-26 foi projetado para **encerrar o loop**, não gerar uma 15ª auditoria. Esta sessão **disparou mesmo assim** ⇒ prova empírica de que *mesmo um off-ramp de 3 comandos não é executado pelo processo atual*. A conclusão sobe de grau: o problema **não** é que a decisão seja difícil ou mal-empacotada (está em 3 comandos há 5 dias); é que **o canal de revisão→ação não está conectado ao loop**. Como o gatilho é cron **de host** (não `/schedule` do Claude — `CronList` vazio), **só um humano com acesso ao host quebra o ciclo.**

**Ação 1 — Desligar o gatilho diário (host, ~2 min).** O agente autônomo **não pode**. No host de dev (`debian`, <DEV_HOST_IP>):
```bash
crontab -l                      # procurar a linha que dispara a sessão headless
systemctl --user list-timers    # ou timer de usuário
# remover a entrada OU trocar diária → semanal/event-triggered (ver nota de cadência)
```

**Ação 2 — Decidir o destino dos 12 commits locais (eng, ~5 min).** `origin/main` em `5516c2a` (127d); **12 commits locais não-pushados, 100% `docs(audit)`** — a série acumula local e **nunca alcança o remoto** onde um humano revisaria:
```bash
git log --oneline origin/main..HEAD        # revisar os 12
git push origin main                       # (a) publicar as auditorias, OU
git reset --hard 5516c2a                   # (b) descartar a série, manter só o último relatório fora do git, OU
git rebase -i 5516c2a                      # (c) esmagar em 1 commit "docs(audit): série de freeze 07-04…10-27"
```

**Ação 3 — Adjudicar o Ledger PRÉ-ADJUDICADO** (§ abaixo). **Mudança vs 10-26:** não é mais "decidir", é "revisar a recomendação". Mínimo defensável p/ o piloto seguir no ar com segurança: aprovar o **bloco "FIX agora / pure-win"** (~3.5h) + os **2 gates de prod** (es-1 traces, B2 token/worker) + aceites-de-risco assinados sobre A5/A5b, cross-app e MA-012.

> **Nota de cadência (quantificada hoje):** se o loop for mantido **de propósito** (ex.: watch de CVE/drift), o dado de hoje diz que ele está mal-calibrado: o único eixo capaz de mover sem commit (CVE) moveu **1× em 5 dias** (só 10-24). Uma cadência diária observa "nada novo" em ~80% das passadas. **Troque diária → semanal ou event-triggered** (disparar só em commit a `src/`/`db/` ou bump de `pnpm-lock.yaml`).

---

## Ledger de Decisão PRÉ-ADJUDICADO (centro desta auditoria)

> **Como usar:** cada linha traz a **recomendação de engenharia** desta auditoria. Marque **[x] APROVA** (vira commit/ação) **ou** **[ ] SOBREPÕE →** (escreva a decisão alternativa e assine). GOV-1 só fecha quando **todas** estão resolvidas. Detalhe canônico + impacto: [10-22](./runtime-gap-audit-2026-10-22.md) (compacto) / [10-21](./runtime-gap-audit-2026-10-21.md) (prosa). Severidade pelo critério da missão (piloto já roda há 153d ⇒ "bloqueia-piloto" = risco vivo-ou-iminente ao que está no ar).

### Bloco A — FIX agora / "pure-win" (sem risco, barato; fazer esta semana independente do resto) — ~3.5h total

| ID | Achado (evidência 1ª-mão hoje) | Sev | Recomendação | Esf |
|---|---|---|---|---|
| **NN1** | Shutdown LIFO fecha Fastify **por último** — `index.ts:28-33` registra `fastify→queues→event-bus→postgres→redis→telemetry`; `shutdown.ts:50` roda LIFO ⇒ execução real `telemetry→…→fastify`. Requests in-flight no SIGTERM batem em pool já fechado → erro espúrio em **todo rollout**. | ALTO | **FIX.** Registrar o hook `fastify` **por último** (ou fechar o app antes do loop LIFO). Melhor ROI da auditoria. | ~15min |
| **N1/NN-9a** | `db/client.ts:52` `process.emit("uncaughtException", err)` **manual**, sem `process.on("uncaughtException")` em lugar nenhum; `initTelemetry()` só em `index.ts:18,23` (API) ⇒ **nenhum worker** tem listener → erro de pool **engolido** → worker-zumbi. | ALTO | **FIX.** Trocar o `emit` por log estruturado + exit explícito; chamar `initTelemetry()` nos workers. | ~1h |
| **NN3** | `deployment-workers.yaml`: `livenessProbe`=**0**, `readinessProbe`=**0** (api tem 1/1). Os **5 workers** sem liveness → k8s **não reinicia** um zumbi (via NN-9a). | ALTO | **FIX.** Adicionar `livenessProbe` aos 5 Deployments de worker. | ~1h |
| **NN4** | Redis sem `maxmemory-policy noeviction` → sob pressão de memória, BullMQ perde jobs **silenciosamente**. | ALTO | **FIX.** `noeviction` + alerta de `used_memory`. | ~30min |
| **doc-drift** | `README.md:9,78` diz "**249 testes**" (real **443**); `:21,:63,:65` linkam `consumer-integration-guide-v1.md` + `go-live-checklist.md` **ausentes do repo** (`find` = 0; vivem só no canon). | BX | **FIX.** Corrigir a contagem + adicionar os 2 docs ao repo **ou** consertar os links mortos. | ~30min |
| **lint-red** | `src/lib/queues.ts:174:19` `import()` type annotation proibida (`@typescript-eslint/consistent-type-imports`). Único erro real; os outros 5 são parse-errors de snippets fora do tsconfig. | BX | **FIX.** Trocar por `import type`. | ~5min |

### Bloco B — Gates de prod (settle barato via SSH; podem rebaixar o risco sem código)

| ID | Achado | Sev | Recomendação | Esf |
|---|---|---|---|---|
| **B2** | Token-refresher pode ter zumbificado há 153d (compõe NN-9a + NN3). **Não observável pelo código.** | ALTO | **GATE.** `kubectl logs deploy/bevox-meta-api-worker-tok` + checar `expires_at` das rows. Se tokens forem long-lived/permanentes → **ACEITE** (risco não-aplicável). | ~15min |
| **es-1** | `configmap.yaml:50` aponta OTLP p/ `otel-collector…:4318`, mas `networkpolicy.yaml` egress **não** libera 4318/4317 (só 3000/9090/5432/6379/443+53). Secret do Meta App (compartilhado c/ V1) + tokens iriam p/ spans — **inerte em prod** (sem egress), mas **traces de prod são dropados** (MA-007 quebrado). | CRÍT | **GATE + FIX-pre-GA.** Gate: *há traces no Grafana?* Se não (esperado) → o leak é inerte **hoje** mas a observabilidade está cega. Fix (pré-GA): scrub do span **+** abrir :4318 **juntos**. | ~4h |

### Bloco C — FIX pré-GA (bloqueia GA; LIVE/latente conforme gatilho)

| ID | Achado | Sev | Recomendação | Esf |
|---|---|---|---|---|
| **A5/A5b** | `inbound/service.ts:298` `isDuplicate` (SET NX) **antes** do insert `:324` sem `del()` compensatório; enqueue fora de try/catch `:388-402`; `operations.ts:98` index **não-único** em `meta_event_id`. Perda silenciosa de inbound em blip PG/Redis. **LIVE p/ WABA onboarded.** | CRÍT | **FIX.** `uniqueIndex` em `meta_event_id` + re-drive + wrap do enqueue. | ~6h |
| **cross-app** | Sem unique **global** em `meta_waba_id`/`meta_ig_id`; resolvers sem `orderBy` (`wabas/repository.ts:84-91`, `ig/repository.ts:60-67`); `disconnectWabaByMetaWabaId:187-203` UPDATE sem scope; `webhook-delivery.ts:123,142` não reverifica `sub.appId==event.appId`. PII misdelivery. **Latente** (gatilho = 2 apps no mesmo asset Meta; bevox-direct é greenfield+flag). | CRÍT | **ACEITE-com-guard agora + FIX antes do 2º app.** `orderBy` determinístico + guard de connect-time **antes** de qualquer 2º app compartilhar asset Meta. | ~3h |
| **MA-012** | LGPD `Status: Proposta`, 0/4 critérios; DSR só helper não-wired (`media-storage.ts:86`). **Bloqueia onboarding novo**, não a operação atual (coberta pelo MSA bevox-backend). | CRÍT | **ESCALAR p/ jurídico agora** (carimbo) + wire DSR em paralelo (eng). | ~7h + jurídico |
| **supply-chain** | `pnpm audit --prod`=123 (2·53·58·10). As **2 críticas** são `fast-jwt` via `@fastify/jwt` (**0 imports** em `src/` ⇒ path morto). Highs alcançáveis: `fast-uri`, `undici`, `fastify`-core, `zod`, `@grpc/grpc-js`+`protobufjs` (via `@google-cloud/kms`, alcançável pq `KMS_PROVIDER=gcp`). | ALTO | **FIX.** `drop @fastify/jwt` (zera as 2 críticas mortas de graça) + bump `fastify`≥5.12.5/`undici`≥8.12.2/`fast-uri`≥3.1.9/`zod`≥4.6.6 + **gate `pnpm audit` em CI** + Dependabot (causa-raiz: sem gate, sobe em degraus com o freeze). | ~2h + rebuild |
| **double-send** | N2/N4 double-send Meta + idempotência race (I2) + replay cross-tenant (key sem tenant). | ALTO | **FIX.** Idempotência atômica + `tenant_id` na key. | ~7h |
| **I8/N8** | Audit assíncrono (plugin `audit-log.ts`) → trilha forjável/perdível. Pré-req de MA-012. | ALTO | **FIX.** Write de audit síncrono/transacional com a mutação. | ~3h |
| **NN-9A/B/C** | Mutações admin sem `Idempotency-Key`; read IDOR; soft-delete via GET. | ALTO | **FIX.** Idempotência no admin + authz nos reads + hardening de método. | ~3h |
| **§3f** | Envelope de `/v1/messages` no OpenAPI **factualmente incorreto** vs código. Consumer-facing. | ALTO | **FIX** (doc, na branch do canon). Corrigir o envelope p/ bater com o código. | ~1h |

### Bloco D — MÉDIO/BAIXO (higiene; agrupar num PR)

| ID | Achado | Sev | Recomendação | Esf |
|---|---|---|---|---|
| **#16 MA-015** | Nenhum `DELETE /{waba_id}/subscribed_apps` no disconnect (só o POST subscribe em `meta-client.ts:160,538`) → subscription Meta **órfã**. MA-015/016 existem como ADR **local** mas **ausentes do canon**. | MÉD | **FIX** + merjar MA-015/016 ao canon. | ~2h |
| outros | NN5 retenção sem poda; status-reconciliation nunca impl.; N5 media OOM; N9 bodyLimit 413 pré-HMAC; redação incompleta; PII-at-rest; `hub.verify_token` não-constant-time; `@types/node@20`; imagem pinada `:dbe9fd6 pullPolicy:Never`. | MÉD/BX | Ver [10-22 §MÉDIO/§BAIXO](./runtime-gap-audit-2026-10-22.md). Agrupar. | — |

---

## Parte A — Ground-truth (orquestrador, 1ª mão, 2026-10-27, HEAD 50dfc7e)

| Verificação | Resultado 2026-10-27 | vs 2026-10-26 |
|---|---|---|
| `git diff dbe9fd6..HEAD -- src/ package.json lock drizzle/` | **vazio** (byte-idêntico) | igual |
| Freeze de código (src/db) | **140 dias** (`dbe9fd6` = 2026-06-09) | +1 dia |
| Freeze de `origin/main`/k8s | **127 dias** (`5516c2a` = 2026-06-22) | +1 dia |
| Freeze do **canon** (bevox-knowledge) | **147 dias** (`0317985` = 2026-06-02; branch `fix/a14-…` **não-merjada** — `git branch --contains 0317985` = só ela; topo = **MA-014**) | +1 dia |
| Freeze do **lockfile** | **155 dias** (`a6944d2` = 2026-05-25) | +1 dia |
| Piloto vivo (`bevox-backend`) | **153 dias** (desde 2026-05-27) | +1 dia |
| Commits ahead de `origin/main` | **12**, **100% `docs(audit)`**, **0 de engenharia** | +1 (o audit 10-26) |
| Commits nas últimas 24h | **0** (nada desde o audit 10-26) | — |
| `pnpm typecheck` | **VERDE** (exit 0) | igual |
| `pnpm lint` | **VERMELHO** — 6 (único real `src/`: `queues.ts:174`; 5 = parse de snippets fora do tsconfig) | igual |
| `pnpm test` (unit) | **443/443 VERDE** (45 arquivos, 12.78s) | igual |
| `pnpm audit --prod` | **123** (**2**·53·58·10) | **FLAT 3º dia** (breakdown idêntico) |
| Debt markers em `src/` | **1 TODO** real (`webhook-delivery.ts:211`); 0 FIXME/HACK/XXX/@deprecated (demais matches = "todo/todos" PT em comentário) | igual |
| OpenAPI (repo) `info.version` | **1.2.0** (`openapi.yaml:4`) | igual |
| Consumer guide / go-live-checklist **no repo** | **AUSENTES** (`find` = 0; linkados no README) | igual |
| ADRs locais > canon | **MA-015 + MA-016** presentes em `docs/adr/`; canon topa em MA-014 → **repo à frente** | igual |

### Anchors de maior severidade re-verificados em 1ª mão hoje (0 drift)

> O `git diff` vazio **prova** por si que todo achado derivado de fonte é byte-idêntico; as re-leituras abaixo são p/ **re-citar linhas em 1ª mão**.

- **NN1** — `index.ts:28-33` ordem de registro + docstring `:4-8` ("Fastify primeiro") contradita pelo LIFO `shutdown.ts:50`. **CONFIRMADO.**
- **N1/NN-9a** — `db/client.ts:52` `emit("uncaughtException")` manual (único em `src/`), 0 `process.on("uncaughtException")`; `initTelemetry` só `index.ts:18,23`; `unhandledRejection` só `index.ts:38`. **CONFIRMADO.**
- **NN3** — `deployment-workers.yaml` liveness=0/readiness=0; api=1/1. **CONFIRMADO.**
- **es-1** — egress sem 4318/4317; `configmap.yaml:50` OTLP→4318. **CONFIRMADO (crítico-no-código / inerte-em-prod).**
- **Dead-dep** — `grep @fastify/jwt src/` = **0**; as 2 críticas `fast-jwt` são só via ele. **CONFIRMADO.**
- **CVE** — `pnpm audit --prod` = **123** (2·53·58·10), idêntico a 10-25/26. **NÃO se moveu (3º dia).**

### Pontos sólidos re-confirmados (não-achados)

UUIDv7 (I1); HMAC inbound constant-time ANTES do parse (I9); MA-008 envelope + zeroize; JWT RS256/kid/TTL nos dois paths (I5); `app_id` sempre do JWT assinado `iss` (não-spoofável); envelope de erro canônico Bevox (não-RFC7807); nenhuma credencial Meta em response schema. **Placar das 11 invariantes idêntico** a 10-21…10-26 (ver [§Parte E do 10-22](./runtime-gap-audit-2026-10-22.md)).

---

## Achados por severidade (corpus estável; detalhe em 10-21/10-22)

> **Disciplina anti-ritual.** Corpus de ~37 achados estável e byte-idêntico; reproduzi-lo por extenso numa 15ª passada **é** o sintoma de GOV-1. Roll-up com âncora; a substância vive no Ledger pré-adjudicado acima e no detalhe de 10-21/10-22.

### CRÍTICO (vivo-ou-iminente p/ piloto / bloqueia conclusão)
- **GOV-1** — 15 auditorias, 140d de freeze, ZERO remediação; pausar ignorado 5× (off-ramp de 10-26 não-actionado). **ESCALADO 6ª vez.** 12 commits não-pushados. Esforço de descoberta: **0h**.
- **CRÍT-1 A5/A5b** · SURVIVES · LIVE p/ WABA onboarded. (Ledger Bloco C)
- **CRÍT-2 es-1** · SURVIVES · crítico-no-código / inerte-em-prod + traces dropados. (Ledger Bloco B)
- **CRÍT-3 cross-app** · SURVIVES · latente (gatilho = 2 apps/asset). (Ledger Bloco C)
- **CRÍT-4 MA-012** · SURVIVES · bloqueia onboarding novo. (Ledger Bloco C)

### ALTO (bloqueia GA; pilot-HIGH em blip de infra)
Roll-up **inalterado** vs [10-22 §ALTO](./runtime-gap-audit-2026-10-22.md) (15 itens, todos SURVIVES): **NN1 · N1/NN-9a · NN3 · B2 · NN4 · double-send(N2/N4/I2) · NN-9A/B/C · register-phone ausente · I8/N8 · HMAC-outbound(sem-assinar+2-formatos) · §3f · SSRF-outbound(egress-mitigado) · NN-1 · rlq-2/obs-1/2/3**. Supply-chain **123, flat 3º dia** *(1ª-mão)*.

### MÉDIO (degrada qualidade)
Inalterados vs [10-22 §MÉDIO](./runtime-gap-audit-2026-10-22.md): #16 MA-015 de-subscribe órfão (+drift repo↔canon); NN4 `noeviction`; es-1 traces; NN5 poda; status-reconciliation; N5 media OOM; N9 413 pré-HMAC; redação incompleta; PII-at-rest.

### BAIXO (higiene)
Inalterados vs [10-22 §BAIXO](./runtime-gap-audit-2026-10-22.md): 2 CVE crít `fast-jwt` dep-morta *(1ª-mão: 0 imports)*; lint vermelho `queues.ts:174` *(1ª-mão)*; imagem pinada `:dbe9fd6 pullPolicy:Never`; `@types/node@20`; cron re-tica *(GOV-1)*; doc-drift README "249"≠443 + guia/checklist ausentes *(1ª-mão)*; `hub.verify_token` não-constant-time; MA-016 ausente do canon.

### Cobertura por categoria da missão (a-l)

| cat | Coberto por | 1ª-mão hoje? |
|---|---|---|
| a (spec'd não-impl) | register-phone, DSR, status-reconciliation, §3f, NN-9A | ref |
| b (impl divergente) | §3f, status-reconciliation, envelope de erro | ref |
| c (testes faltando) | `repository.ts` 0% unit; contagem **443/45** | ✓ |
| d (debt) | **1 TODO** (`webhook-delivery.ts:211`); GOV-1; CVE | ✓ grep |
| e (LGPD) | MA-012 `Proposta`, DSR não-wired, I8, NN5 | ref |
| f (OpenAPI drift) | §3f, canon-vs-repo (v1.2.0; MA-015/16 repo>canon) | ✓ |
| g (go-live infra) | CNPG `instances:1`, Redis `replicas:1`, **NN3 probes=0** | ✓ |
| h (webhook real do piloto) | A5/A5b, **NN1**, **es-1**, double-send, NN4, N9 | ✓ |
| i (inbound HMAC/idem/replay/size) | HMAC constant-time (PASS), A5 dedup-antes-persist, N9, NN-1 | ref |
| j (token mgmt) | MA-008 (PASS), es-1 leak, **token-lifecycle B2** | ✓ B2 |
| k (rate limit/quota) | rlq-2 429 não-retentado, obs 0 call-sites | ref |
| l (delta vs anterior) | §Delta abaixo | ✓ |

---

## Itens-de-fechamento ordenados por valor/esforço (top 10)

**Não é descoberta — é a ordem de execução do Ledger.** Inalterado em substância vs 10-22…10-26.

| # | Item (Ledger) | Esforço | Destrava |
|---|------|---------|----------|
| 1 | **NN1** (Bloco A) | ~15min | Para o erro espúrio em **todo rollout** — melhor ROI |
| 2 | **NN3 + N1/NN-9a + NN4** (Bloco A) | ~2.5h | Fecha o worker-zumbi invisível (inclui token-refresher/B2) + data-loss de fila |
| 3 | **lint + doc-drift** (Bloco A) | ~35min | Higiene barata; destrava "verde" e README honesto |
| 4 | **Gates de prod: es-1 (traces?) + B2 (worker/tokens?)** (Bloco B) | ~30min SSH | Rebaixa 1 CRÍT e 1 ALTO sem código, se os gates derem o esperado |
| 5 | **Supply-chain** (Bloco C) | ~2h + rebuild | Zera 2 críticas mortas + altas alcançáveis + causa-raiz (CI gate) |
| 6 | **es-1 fix (scrub + :4318)** (Bloco B) | ~4h | Fecha o CRÍTICO na origem **e** restaura MA-007 |
| 7 | **A5/A5b** (Bloco C) | ~6h | Bloqueador #1 de inbound (LIVE p/ WABA onboarded) |
| 8 | **cross-app guard + #16** (Bloco C/D) | ~4h | Fecha PII-misdelivery (latente) + subscription órfã |
| 9 | **double-send + I8 + NN-9A/B/C** (Bloco C) | ~10h | Para double-send/replay + trilha forjável (pré-MA-012) + IDOR |
| 10 | **Convergência de contrato (§3f + merjar a14 + MA-015/16) + MA-012 + RoPa** | ~2d + jurídico | Desbloqueia onboarding-via-spec (GA) + go-live legal |

---

## Dependências cruzadas

- **es-1 / observabilidade** → scrub (es-1) e egress :4318 (MA-007) vão **juntos**; gate exige SSH a prod.
- **MA-012 / DSR / audit (I8) / retenção (NN5)** → advogado externo + RoPa **OT-19** (ADR-019/020); os gaps de eng **minam a base legal**.
- **Contrato (§3f, drift repo↔canon, guia, MA-015/16)** → PRs em `bevox-knowledge` (SoT por ADR-005; canon **em branch não-merjada há 147d** `fix/a14-…` — a premissa "doc ganha" repousa em branch não-merjada, e o repo já tem MA-015/16 que o canon não tem). Não mudar `signing_secret`/`event_id`/formato HMAC sem coordenar com `bevox-backend`.
- **cross-app + #16** → gatilho é **2 apps no mesmo asset Meta**, não a migração bevox-direct (greenfield+flag). Coordenar c/ futura migração dos boxes embedded do V1.
- **A5/A5b, N1/NN-9a, NN1-NN4, B2** → **compõem no mesmo gatilho** (blip de PG/Redis, rollout). A decisão de infra (single-node c/ RPO explícito **ou** réplica CNPG/Redis) é a de **maior alavancagem**.
- **Supply-chain (123 CVEs)** → sobe em degraus com o freeze; sem Dependabot/CI gate; imagem pinada `:dbe9fd6 pullPolicy:Never` bloqueia o patch (não chega a prod sem rebuild manual).

---

## Delta vs auditoria anterior (2026-10-26 → 2026-10-27)

**Código / k8s / canon / lockfile:** BYTE-IDÊNTICO em todas as camadas. 1 dia, 0 commits de intervalo.

- **FIXED: 0.** 15ª consecutiva sem remediação de engenharia.
- **SURVIVES: todos.** Re-verificação 1ª-mão dos anchors de maior severidade (NN1, N1/NN-9a, NN3 probes=0, es-1 egress-sem-:4318, dead-dep `@fastify/jwt` 0-imports, doc-drift, OpenAPI 1.2.0, canon MA-014/branch-não-merjada): **0 drift**. Placar das 11 invariantes idêntico. Toolchain idêntico (typecheck verde / 443 verde / lint 6).
- **NET-NEW de correctness: 0.** Corpus saturado; 15 passadas convergiram.
- **MOVE mensurável: 0.** **CVE flat 123→123** pelo **3º dia consecutivo** (2·53·58·10). Série 5-dias: flat → **+7** → flat → flat → flat ⇒ a tese "degradação em degraus ~semanais" passa de confirmada (10-26) a **reforçada** (1 passo em 5 dias).
- **AFIA com o tempo: B2** (token-lifecycle 152→153) e todos os freeze-counters +1.
- **GOV-1:** **5ª→6ª reincidência.** Pausar (10-22…10-26) ignorado 5×; o off-ramp de 10-26 **não foi actionado** — esta sessão (7ª diária) é a prova. `origin/main` congelado em `5516c2a` (127d); 12 commits não-pushados.
- **NET-NEW desta passada (único valor marginal positivo): o Ledger PRÉ-ADJUDICADO.** 10-26 entregou o off-ramp + Ledger de 18 linhas **em branco**; 10-27 **preenche a recomendação de cada linha** (FIX-agora/gate-prod/FIX-pré-GA/aceite-com-trigger), organizadas em Blocos A-D por risco×esforço. Colapsa a revisão de "decidir 18" para "aprovar/sobrepor 18". É a última peça que faltava para a Ação 3 do off-ramp ser executável em ~20 min.
- **Saldo:** a 15ª passada **não acrescenta descoberta** — e isso, de novo, É o achado. Em 24h, **zero eixos se moveram**, incl. o supply-chain pelo 3º dia.

---

## Notas de método

**Calibração (effort max = rigor, não ritual).** Alvo congelado 140 dias em 4 camadas, 14 passadas prévias (fan-outs 6- e 2-agente convergidos a 0 net-new), recomendação explícita de 10-22…10-26 de pausar a série + off-ramp não-actionado. "Effort max" aqui = **rigor de verificação + inverter a última peça decisória** (pré-adjudicar o Ledger), **não** volume de re-enumeração. O rigor desta passada: provar byte-identidade (`git diff` vazio), re-rodar o toolchain inteiro (typecheck/lint/test), re-medir `pnpm audit --prod` **apples-to-apples** (o único eixo que pode mover sem commit — um scan inicial sem `--prod` deu 172 incluindo devDeps; o prod-only comparável é **123**), re-anchorar 1ª-mão cada achado de maior severidade, checar canon+lockfile. Desperdício (a inércia vetada pela missão §4) seria re-derivar 37 achados via fan-out de 5 agentes contra bytes idênticos.

**Fan-out NÃO executado — por desenho.** 10-21 rodou 6 agentes; 10-22 rodou 2 (`invariants-auditor`+`tenant-scope-auditor`, mandato de refutar) → **0 refutação / 0 drift / 0 net-new**; 10-23…10-27 rodaram 0. Repetir o fan-out contra **bytes idênticos** (`git diff` vazio) é exatamente a "invocação por inércia" que a missão §4 proíbe e que GOV-1 denuncia. Agents locais relevantes (`invariants-auditor`, `tenant-scope-auditor`, `webhook-hmac-auditor`, `secrets-redaction-auditor`, `contract-guardian`) não foram invocados pela mesma razão. A verificação foi inteira do **orquestrador em 1ª mão**.

**Verificado em 1ª mão hoje** (HEAD 50dfc7e, Node v22.23.3, pnpm 9.15.1): `git diff dbe9fd6..HEAD` (vazio p/ src/pkg/lock/drizzle) + `rev-list` (12 ahead de `origin/main`, 100% `docs(audit)`; 0 commits/24h); canon via `$BEVOX_KNOWLEDGE_PATH=$BEVOX_KNOWLEDGE_PATH` (`branch fix/a14-…`, `0317985` 2026-06-02, `branch --contains` = só ela, ADRs topam em MA-014, PRD `2026-05-08-…` presente); lockfile `a6944d2` 2026-05-25; `typecheck` (verde) / `lint` (6, real `queues.ts:174`) / `test` (**443/443**, 45 arq) / `audit --prod` (**123** = 2·53·58·10, flat 3º dia; sub-scan sem `--prod` = 172 c/ devDeps); greps em `src/`: `@fastify/jwt` (**0**), `uncaughtException|unhandledRejection` (`db/client.ts:52` emit, `index.ts:38-40`), `initTelemetry` (só `index.ts:18,23`+def), `TODO|FIXME|HACK|XXX|@deprecated` (**1** real, `webhook-delivery.ts:211`); `deployment-workers.yaml` (liveness/readiness=0) vs `deployment-api.yaml` (1/1); `networkpolicy.yaml` egress (3000/9090/5432/6379/443+53 — **sem 4318/4317**); `configmap.yaml:50` (OTLP→:4318); `openapi.yaml:4` (1.2.0); **ausência** no repo de `consumer-integration-guide-v1.md`+`go-live-checklist.md`; **presença** de `docs/adr/MA-015-*`+`MA-016-*`; `README.md:9,21,63,65,78` ("249 testes" + links mortos); leitura de `src/index.ts:1-45`.

**Limitações.** (a) **es-1, A5/A5b, cross-app e B2 não confirmados em runtime** — sem acesso a prod nesta sessão. Análise estática é prova forte; cluster vivo + WABAs/tenants por app + `expires_at` + liveness do `worker:tok` não são observáveis pelo código. Os **gates do Bloco B** exigem SSH a prod — deixados p/ a revisão humana. (b) `test:integration`/`test:e2e` não re-executados (byte-idêntico; 07-20 rodou integração 9/9). (c) PRD/ADRs canônicos consumidos por referência (ADR-005); o mapeamento de gaps é estável há 14 passadas contra código byte-idêntico — o fato material verificado hoje é que **o canon em si não se moveu** (147d, branch não-merjada). (d) Consumer guide + checklist usados na versão canônica (ausentes do repo).

**Restrição respeitada:** nenhum arquivo de produto foi modificado — este relatório é o único artefato produzido. Nenhuma ação sobre o scheduler de host foi tomada (fora do escopo autorizado; o Kit de Resolução §Ação 1 a deixa pronta para a revisão humana).
