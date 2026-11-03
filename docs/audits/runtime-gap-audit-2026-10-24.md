# Gap Analysis — bevox-meta-api — 2026-10-24

> HEAD `3e83d70` · Node v22.23.3 · pnpm 9.15.1 · **12ª auditoria** da série (11 prévias) · **4ª em 4 dias consecutivos** (10-21, 10-22, 10-23, 10-24) · freeze de código **137 dias** (`dbe9fd6` = 2026-06-09).

## Resumo executivo

Estado **inalterado e terminal**. V1 em produção servindo `bevox-backend` (piloto MVP Hetzner, vivo há **150 dias**). Código de produto **byte-idêntico** desde `dbe9fd6` — `git diff dbe9fd6..HEAD -- src db` = **vazio** (prova de 1ª mão hoje). As quatro camadas estão congeladas: código **137d**, k8s **124d**, canon **144d** (ainda em branch não-merjada `fix/a14-…` `0317985`), **lockfile 152d** (`a6944d2`). Esta é a 4ª passada em 4 dias; as de 10-22 e 10-23 **recomendaram explicitamente pausar o scheduler externo** — a recomendação foi **ignorada duas vezes** e a existência desta 12ª passada é a prova. **Delta real de hoje: exatamente um eixo se moveu — CVE 116→123 (+7)**, quebrando a sequência de 3 dias flat (10-21/22/23 = 116); mecanismo esperado (novas advisories contra lockfile congelado há 152d). **Zero fixes de engenharia** (12ª consecutiva), **zero net-new de correctness** (corpus saturado em ~37 achados, convergido por fan-outs de 6- e 2-agentes em 10-21/10-22). Riscos **para o piloto** inalterados (classe "perda/zumbi silencioso em blip de PG/Redis/rollout": NN1 + N1/NN-9a + A5/A5b + NN3 + NN4; + token-lifecycle B2 afiado pelo tempo) e **MA-012 LGPD `Proposta`** bloqueando onboarding novo; **para GA**: contrato §3f incorreto + supply-chain crescente (123 CVEs).

**Recomendação única e prioritária (GOV-1, 3ª reincidência):** o gargalo é **100% decisório, há 137 dias**. Duas ações humanas, nenhuma de engenharia-de-descoberta:
1. **Adjudicar o Ledger de Decisão** da [10-22](./runtime-gap-audit-2026-10-22.md) item a item — cada achado recebe **um commit de fix _ou_ um aceite-de-risco explícito assinado**. É o entregável de maior valor desde 07-22 e não moveu um commit em 12 passadas.
2. **Desligar o scheduler de host** que dispara esta sessão diária. `CronList` retorna **"No scheduled jobs"** → **não** é um `/schedule` gerido pelo Claude; é um cron/systemd-timer **de host** (emite o hook `=== bevox-meta-api — sessão iniciada ===`). A pausa é ação de host/humano; o agente autônomo não pode (nem deve, sem autorização) desligá-la. Se mantiver cadência, troque **diária→event-triggered** (em commit a `src/`/`db/`) ou mensal.

---

## Parte A — Ground-truth (orquestrador, 1ª mão, 2026-10-24, HEAD 3e83d70)

| Verificação | Resultado 2026-10-24 | vs 2026-10-23 |
|---|---|---|
| `git diff dbe9fd6..HEAD -- src db` | **vazio** (byte-idêntico) | igual |
| Freeze de código (src/db) | **137 dias** (`dbe9fd6` = 2026-06-09) | +1 dia |
| Freeze de k8s | **124 dias** (`5516c2a` = 2026-06-22) | +1 dia |
| Freeze do **canon** (bevox-knowledge) | **144 dias** (`0317985` = 2026-06-02, branch `fix/a14-…` **não-merjada**) | +1 dia |
| Freeze do **lockfile** (`pnpm-lock.yaml`) | **152 dias** (`a6944d2` = 2026-05-25) | +1 dia |
| Piloto vivo (`bevox-backend`) | **150 dias** (desde 2026-05-27) | +1 dia |
| Commits desde o freeze | **10** (9 `docs(audit)` + 1 `ops` k8s); **0 de engenharia** | +1 (o audit 10-23) |
| Commits nas últimas 24h | **0** (nada desde o audit 10-23) | — |
| `origin/main` HEAD | **`5516c2a` = 2026-06-22** (124d atrás); **10 commits locais não-pushados, TODOS `docs(audit)`** | **net-new (medido hoje)** |
| `pnpm typecheck` | **VERDE** (exit 0) | igual |
| `pnpm lint` | **VERMELHO** — 6 problemas (`queues.ts:174` real + 3 parsing-error de snippets em `skills/…` + ruído) | igual |
| `pnpm test` (unit) | **443/443 VERDE** (45 arquivos, 13.25s) | igual |
| `pnpm audit --prod` | **123 vulns** (2 crít · 53 altas · 58 mod · 10 bx) | **MOVEU +7** (era 116: 2·51·55·8) |
| Debt markers em `src/` (cat d) | **1 TODO** (`webhook-delivery.ts:211`), 0 FIXME/HACK/XXX/@deprecated | igual |
| `CronList` (scheduler Claude) | **"No scheduled jobs"** → gatilho é cron de host, externo | igual |

### Anchors de maior severidade re-verificados em 1ª mão hoje (0 drift nos bytes)

- **NN1 shutdown invertido — CONFIRMADO.** `index.ts:28-33` registra hooks na ordem `fastify → queues → event-bus → postgres → redis → telemetry`; `shutdown.ts:50` roda estritamente **LIFO** (`for i=hooks.length-1; i>=0; i--`) → execução real = `telemetry → redis → postgres → event-bus → queues → **fastify POR ÚLTIMO**`. **Inverso exato** dos próprios docstrings (`index.ts:4-8` "Registrar shutdown hooks (Fastify…)" e `shutdown.ts:4-13` "1. Fastify .close() primeiro … Hooks executam na ordem inversa de registro (LIFO)"). Requests in-flight no SIGTERM batem em pool PG/Redis já fechado → erro espúrio em **todo rollout**. #1 ROI (~15min).
- **N1 / NN-9a — CONFIRMADO e reconciliado.** `db/client.ts:51-53`: `pool.on("error", (err) => { process.emit("uncaughtException", err); })` — `emit` **manual**. **Único** `uncaughtException` em `src/`; **não há** `process.on("uncaughtException")`. Semântica: `emit` manual sem listener retorna `false` e **não** aciona o fatal-handler interno do Node. Bifurca no split API/worker: **API** chama `initTelemetry()` (`index.ts:23`) → se o SDK Sentry/OTel registra `onUncaughtException`, o erro de pool é capturado e o processo pode terminar (**N1**); **workers não inicializam telemetria** (ver abaixo) → **sem listener** → erro de pool engolido → **zumbi silencioso (NN-9a)**. `unhandledRejection` só em `index.ts:38` (API), confirmando o split.
- **B2 token-lifecycle — anchor CONFIRMADO em 1ª mão.** `grep initTelemetry src/` retorna **apenas `src/index.ts`** (`:18` import, `:23` call) — **nenhum worker** inicializa telemetria. O worker `worker:tok` = `src/workers/token-refresh.ts` (existe, faz refresh). Composição: NN-9a (erro de pool engolido no worker) + **NN3** (`deployment-workers.yaml` tem **5 Deployments de worker — `worker-out`:16, `worker-in`:85, `worker-tok`:144 — e ZERO `livenessProbe`**; as 5 linhas de probe do cluster estão em `cloudflared.yaml`/`redis.yaml`/`deployment-api.yaml` só). → se o refresher zumbificar, k8s **nunca o reinicia**. Com **150 dias** de piloto, se os tokens forem da variante long-lived de ~60 dias, já se passaram ~2-3 ciclos de refresh **sem garantia em runtime** de que o refresher rodou em cada um; 1º sintoma seria outbound retornando auth-error, não um alarme. Risco **criado pela passagem do tempo** — afia +1 dia a cada passada. **Gate (exige prod):** `kubectl logs deploy/bevox-meta-api-worker-tok` + `expires_at` das rows de token.
- **CVE — único eixo que se moveu.** 2 **críticas** = `fast-jwt` (`<=6.2.3` empty-HMAC auth-bypass; `>=6.2.0 <=6.2.4` incomplete-patch CVE-2026-34950), ambas **só via `@fastify/jwt`** — `grep "@fastify/jwt" src/` = **0 imports** (só declarado em `package.json:44`). → **dead dep; drop zera as 2 críticas de graça**. JWT real via `jose`. Highs novas/afiadas **alcançáveis** no request-path: `fastify <5.12.2` (auth-bypass via URL malformada + request-body replacement + validation bypass), `undici <8.12.2` (DoS / TLS cert-validation bypass / cross-user info disclosure), `zod <4.6.6` (memory exhaustion em collections oversized — roda em **todo** request), `fast-uri` (`<3.1.7` authority-injection, `<3.1.6` SSRF via IPv6 malformado + host-confusion), `protobufjs`/`@grpc/grpc-js` (via `@google-cloud/kms` — **alcançável** porque `KMS_PROVIDER=gcp`), `find-my-way <=9.6.0` (HTTP2 DDoS), `@fastify/static` (path traversal).

### Pontos sólidos re-confirmados (não-achados)

UUIDv7 (I1); HMAC inbound constant-time ANTES do parse (I9 inbound); MA-008 envelope + zeroize; JWT RS256/kid/TTL nos dois paths (I5); `app_id` sempre do JWT assinado `iss` — não-spoofável; envelope de erro canônico Bevox (não-RFC7807); nenhuma credencial Meta em response schema. **Placar das 11 invariantes idêntico** a 10-21/10-22/10-23 — ver [§Parte E do 10-22](./runtime-gap-audit-2026-10-22.md).

---

## Parte B — O delta real de 2026-10-24 (1 net-new mensurável; 0 de correctness)

1. **CVE quebrou o flat: 116→123 (+7).** Sequência 10-21/22/23 foi **116→116→116**; hoje **123**. Breakdown do delta: críticas +0 (2→2), **altas +2 (51→53)**, moderadas +3 (55→58), baixas +2 (8→10). **Mecanismo:** lockfile congelado há **152 dias** + base de advisories que atualiza sozinha → novas CVEs aparecem sem commit. É o **único sinal que pode mover sem código, e moveu** — a prova empírica mais limpa de que o alvo é estático e o supply-chain **degrada monotonicamente com o freeze**. Trava estrutural inalterada: imagem pinada `:dbe9fd6` `pullPolicy:Never` + CI build-only sem gate `audit`/Dependabot → o patch **não chega a prod sem rebuild manual**. Reforça o ALTO de supply-chain (não é net-new de correctness; é o eixo temporal se materializando).

2. **Token-lifecycle (B2) afia para dia 150** (cat. j — postura, não código). Anchor confirmado 1ª-mão hoje (worker-tok sem telemetry-listener + sem probe — Parte A). Cada dia de freeze aumenta a probabilidade de um ciclo de refresh ter falhado silenciosamente. Condicional (não-aplicável se tokens forem permanentes), mas é o risco que só o tempo revela.

3. **GOV-1 — 3ª reincidência (escalada terminal).** A recomendação de pausar o scheduler foi feita em **10-22** e **10-23** e **não foi actionada nas duas vezes**; esta 12ª passada é a prova viva. A decisão está **137 dias atrasada**.

> **Fan-out NÃO executado — por desenho.** 10-21 rodou 6 agentes; 10-22 rodou 2 (`invariants-auditor` + `tenant-scope-auditor`, mandato de refutar) → **0 refutação / 0 drift / 0 net-new**; 10-23 rodou 0. Repetir o fan-out contra **bytes idênticos** é exatamente a "invocação por inércia" que a missão §4 proíbe e que GOV-1 denuncia. A verificação desta passada foi **inteira em 1ª mão pelo orquestrador** (Parte A), focada (a) no **único eixo que pode mover sem commit** (CVE — e moveu) e (b) na re-verificação dos anchors de maior severidade que sustentam a recomendação mínima ao piloto (NN1, N1/NN-9a, B2/NN3). Ver Notas de método.

---

## Achados por severidade (corpus estável; detalhe canônico em 10-21/10-22)

> **Disciplina anti-ritual.** O corpus de ~37 achados é estável e byte-idêntico; reproduzi-lo por extenso numa 12ª passada **é** o sintoma de GOV-1. Abaixo: roll-up com âncora e status; prosa só onde houve 1ª-mão hoje. Detalhe + impacto: [10-22](./runtime-gap-audit-2026-10-22.md) (compacto), [10-21](./runtime-gap-audit-2026-10-21.md) (prosa integral), [10-23](./runtime-gap-audit-2026-10-23.md) (reconciliações).

### CRÍTICO (bloqueia conclusão do módulo / vivo-ou-iminente)

- **GOV-1 · 12 auditorias, 137d de freeze, ZERO remediação; recomendação de pausar ignorada 2×** (cat. d/l) · **ESCALADO 3ª vez.** 10 commits desde o freeze (9 audit-docs + 1 k8s), 0 de engenharia. O Ledger de Decisão não moveu um commit em 12 passadas. **`origin/main` não avança desde 2026-06-22 (124d): os 10 commits de audit da série (desde 07-04) estão TODOS não-pushados localmente — o loop não entrega nem os próprios relatórios ao remoto onde um humano revisaria** (net-new hoje). **Esforço de descoberta: 0h.** Ação: adjudicar o Ledger + pausar o scheduler de host.
- **CRÍT-1 · A5 + A5b — perda silenciosa de inbound em blip PG/Redis** (cat. a/h/i) · SURVIVES · LIVE p/ WABA onboarded. `inbound/service.ts:298` (`isDuplicate` SET NX antes do insert `:324`, sem `del()` compensatório); enqueue fora de try/catch (`:388-402`); `operations.ts:98` index não-único. ~6h.
- **CRÍT-2 · es-1 — secret do Meta App (compartilhado c/ V1) + tokens → spans OTel** (cat. d/j) · SURVIVES · CRÍTICO-no-código / **INERTE-em-prod** (`networkpolicy.yaml:52-71` libera só 53/5432/6379/443 → OTLP :4318 de `configmap.yaml:50` bloqueado). Corolário: **traces de prod dropados** (MA-007 quebrado). Gate: *traces no Grafana?* ~3-4h scrub **+** abrir :4318.
- **CRÍT-3 · Cross-app PII misdelivery** (cat. a/i/j/f/g) · SURVIVES · CONFIRMED, **liveness LATENTE** (gatilho = **2 apps no mesmo asset Meta**; bevox-direct é greenfield+flag-dormante). Sem unique **global** em `meta_waba_id`/`meta_ig_id`; resolvers sem `orderBy` (`wabas/repository.ts:84-91`, `ig/repository.ts:60-67`); `disconnectWabaByMetaWabaId` (`:187-203`) UPDATE sem scope; `webhook-delivery.ts:123,142` não reverifica `sub.appId == event.appId`. ~3h + testes.
- **CRÍT-4 · MA-012 LGPD `Status: Proposta`, 0/4 critérios, DSR não implementado** (cat. e) · SURVIVES. DSR só helper não-wired (`media-storage.ts:86`). Operação atual coberta pelo MSA bevox-backend; **onboarding novo bloqueado**. Eng ~7h + jurídico.

### ALTO (bloqueia GA; pilot-HIGH em blip de infra)

Roll-up **inalterado** vs [10-22 §ALTO](./runtime-gap-audit-2026-10-22.md) (15 itens, todos SURVIVES), com **supply-chain re-afiado hoje**:

- **NN1** shutdown invertido *(1ª-mão hoje — Parte A)* · **N1+NN-9a** crash/zumbi *(1ª-mão, reconciliado)* · **NN3** 5 workers sem probe *(1ª-mão: `deployment-workers.yaml` 5 Deployments, 0 probe)* · **N2/N4/NN5-inv** double-send Meta · **I2+NN1-inv** idempotência race + replay cross-tenant · **NN-9A** mutações admin sem `Idempotency-Key` · **register-phone ausente** · **I8/N8** durabilidade do audit · **NN-9B/9C** read IDOR + soft-del via GET · **HMAC outbound** pode sair não-assinado + 2 formatos · **§3f** OpenAPI factualmente incorreto · **SSRF outbound** (egress-mitigado 443) · **NN-1** HMAC/verify-token secret global · **rlq-2/obs-1/2/3** 429 não-retentado + métricas 0 call-sites.
- **supply-chain (123 CVEs, +7 hoje)** *(1ª-mão)* — bump `fastify`≥5.12.5 + `undici`≥8.12.2 + `fast-uri`≥3.1.9 + `zod`≥4.6.6; **drop `@fastify/jwt`** (zera 2 críticas mortas); gate `pnpm audit/test/lint` em CI + Dependabot. **Alcançáveis no request-path** confirmadas hoje: fastify-core auth-bypass, undici TLS-bypass, zod memory-exhaustion, fast-uri SSRF, grpc/protobufjs (via GCP KMS).

### MÉDIO / BAIXO

Inalterados vs [10-22 §MÉDIO](./runtime-gap-audit-2026-10-22.md) (itens 16-29: **#16 MA-015 de-subscribe órfão** — nenhum `DELETE /{waba_id}/subscribed_apps`, só o POST subscribe em `meta-client.ts:160,538`; NN4 Redis sem `noeviction`; es-1 traces dropados; NN5 retenção sem poda; status-reconciliation nunca implementado; N5 media OOM; N9 bodyLimit 413 pré-HMAC; redação incompleta; PII-at-rest) e §BAIXO (itens 30-37: **2 CVE crít `fast-jwt` dep-morta** *(1ª-mão)*; **lint vermelho** 6 *(1ª-mão)*; imagem pinada; `@types/node@20`; cron re-tica; drift de contrato; **doc-drift** — README "249 testes" vs **443 reais** *(1ª-mão hoje)*, `consumer-integration-guide-v1.md`/`go-live-checklist.md` linkados no README mas **ausentes do repo** — vivem só no canon; `hub.verify_token` não-constant-time).

### Cobertura por categoria da missão (a-l)

| cat | Coberto por | 1ª-mão hoje? |
|---|---|---|
| a (spec'd não-impl) | register-phone, DSR, status-reconciliation, §3f, NN-9A | ref |
| b (impl divergente) | §3f, status-reconciliation, envelope de erro | ref |
| c (testes faltando) | `repository.ts` 0% unit; I3 só leitura estática | contagem **443/45** ✓ |
| d (debt) | **1 TODO** (`webhook-delivery.ts:211`); GOV-1; CVE | ✓ grep |
| e (LGPD) | MA-012 `Proposta`, DSR não-wired, I8 audit, NN5 retenção | ref |
| f (OpenAPI drift) | §3f, handlers-fora-do-spec, canon-vs-repo | ref |
| g (go-live infra) | CNPG `instances:1`, Redis `replicas:1`, **NN3 probes** ✓, secrets | ✓ NN3 |
| h (webhook real do piloto) | A5/A5b, **NN1** ✓, es-1, double-send, NN4, N9 | ✓ NN1 |
| i (inbound HMAC/idem/replay/size) | HMAC constant-time (PASS), A5 dedup-antes-persist, N9 413, NN-1 | ref |
| j (token mgmt) | MA-008 (PASS), es-1 leak, **token-lifecycle B2** ✓ | ✓ B2 |
| k (rate limit/quota) | rlq-2 429 não-retentado, obs métricas 0 call-sites | ref |
| l (delta vs anterior) | §Delta abaixo | ✓ |

---

## Itens-de-fechamento ordenados por valor/esforço (top 10)

**Não é descoberta nova — é a lista de decisão que não se moveu em 12 passadas.** Substância inalterada vs 10-22/10-23.

| # | Item | Esforço | Destrava |
|---|------|---------|----------|
| 1 | **NN1** — Fastify fecha primeiro (registrar o hook por último **ou** fechar app antes do loop LIFO em `shutdown.ts`) | ~15min | Para o erro espúrio em **todo rollout** — melhor ROI |
| 2 | **NN3 + N1 + NN-9a** — `livenessProbe` nos 5 workers; `db/client.ts` **loga** em vez de `emit("uncaughtException")`; `initTelemetry()` nos workers | ~2h | Fecha o worker-zumbi invisível (inclui o **token-refresher** — risco B2) |
| 3 | **Supply-chain** — bump `fastify`≥5.12.5 + `undici`≥8.12.2 + `fast-uri`≥3.1.9 + `zod`≥4.6.6; **drop `@fastify/jwt`** (zera 2 críticas mortas); **gate `pnpm audit/test/lint` em CI** + Dependabot | ~2h + rebuild | Fecha altas alcançáveis + a causa-raiz do supply-chain (que **cresceu +7 hoje**) |
| 4 | **NN4 + N11 + NN5** — Redis `maxmemory`+`noeviction`+alerta; `commandTimeout`; poda de `webhook_deliveries` | ~2h | Fecha data-loss de fila, hang, crescimento ilimitado |
| 5 | **es-1** — SpanProcessor que apaga `url.full`/`url.query` p/ hosts Meta **+** abrir :4318 no egress (juntos) | ~4h | Fecha o CRÍTICO na origem **e** restaura MA-007 |
| 6 | **A5 + A5b** — `uniqueIndex` em `meta_event_id` + re-drive + wrap do enqueue | ~6h | Bloqueador #1 de inbound (LIVE p/ WABA onboarded) |
| 7 | **cross-app + #16** — `orderBy` determinístico + guard de connect-time + scope de app em `disconnectWabaByMetaWabaId` + `DELETE /subscribed_apps` no disconnect | ~4h + testes | Fecha PII-misdelivery (latente) + subscription órfã |
| 8 | **Idempotência atômica + fim do double-send + tenant na key + admin idempotente** | ~7h | Para double-send, replay cross-tenant, mutação admin não-idempotente |
| 9 | **Audit síncrono (I8) + NN-9B/9C** | ~5h | Fecha trilha forjável (pré-req MA-012) + IDOR + soft-del leak |
| 10 | **Convergência de contrato (canon→código)** + patchar exemplo do guia + **MA-012 + RoPa OT-19** | ~2d + jurídico | Desbloqueia onboarding-via-spec (GA) + go-live legal |

**Mínimo defensável p/ o piloto continuar** (inalterado): #1 + #2 + NN4 `noeviction` + #3 + gate es-1 (traces no Grafana?) + aceite-de-risco sobre A5/A5b e cross-app + o gate diagnóstico de token/worker em prod (B2) = **~4-6h eng** + decisão jurídica MA-012.

---

## Dependências cruzadas

- **es-1 / observabilidade** → scrub (es-1) e egress :4318 (obs/MA-007) vão **juntos**. Gate exige SSH a prod.
- **MA-012 / DSR / audit (I8) / retenção (NN5)** → advogado externo + RoPa **OT-19** (ADR-019/020); os gaps de eng **minam a base legal**.
- **Contrato (§3f, drift repo↔canon, guia)** → PRs em `bevox-knowledge` (SoT por ADR-005; canon **em branch não-merjada há 144d** — a premissa "doc ganha" repousa sobre branch não-merjada). Não mudar `signing_secret`/`event_id`/formato HMAC sem coordenar com `bevox-backend`.
- **cross-app + #16** → gatilho é **2 apps no mesmo asset Meta**, não a migração bevox-direct (greenfield+flag). Coordenar c/ futura migração dos boxes embedded do V1 ([[bevox-direct-migration-to-meta-api]], [[meta-app-bernardTavares-shared]]).
- **register-phone / ES-COEX / IG / MA-015** → dependem do Meta App compartilhado "Bevox Solutions" + Meta App Review + smoke/e2e contra sandbox.
- **A5/A5b, N1/NN-9a, NN1-NN4, token-lifecycle (B2)** → **compõem no mesmo gatilho** (blip de PG/Redis, rollout). A decisão de infra (single-node c/ RPO explícito **ou** réplica CNPG/Redis) é a de **maior alavancagem**.
- **Supply-chain (123 CVEs, +7 hoje)** → sobe monotonicamente com o freeze; sem Dependabot/CI gate; imagem pinada bloqueia o patch.

---

## Delta vs auditoria anterior (2026-10-23 → 2026-10-24)

**Código / k8s / canon / lockfile:** BYTE-IDÊNTICO em todas as camadas. 1 dia, 0 commits de intervalo.

- **FIXED: 0.** 12ª consecutiva sem remediação de engenharia.
- **SURVIVES: todos.** Re-verificação em 1ª mão dos anchors de maior severidade (NN1, N1/NN-9a, B2/NN3, dead-dep crítica): 0 drift. Placar das 11 invariantes idêntico.
- **NET-NEW de correctness: 0.** Corpus saturado; 12 passadas (incl. 6- e 2-agente fan-outs) convergiram.
- **MOVE mensurável: 1.** **CVE 116→123 (+7)** — a sequência de 3 dias flat quebrou no 4º dia. É o único eixo que se move sem commit, e se moveu; prova empírica de que o supply-chain degrada com o freeze (lockfile 152d). Dentro do +7, highs **alcançáveis** novas/afiadas: undici `<8.12.2`, fast-uri `<3.1.9`, fastify-core `<5.12.2`, zod `<4.6.6`.
- **AFIA com o tempo: B2** (token-lifecycle dia 149→150) e todos os freeze-counters +1.
- **GOV-1:** **2ª→3ª reincidência.** Recomendação de pausar o scheduler (10-22, 10-23) ignorada 2×; esta passada é a prova. **Net-new de governança hoje:** `origin/main` congelado em `5516c2a` (2026-06-22, 124d); **10 commits locais não-pushados, 100% `docs(audit)`** — a série inteira acumula local e **nunca alcança o remoto**, logo o loop não tem canal de entrega ao humano mesmo quando produz.
- **Saldo:** a 12ª passada **não acrescenta descoberta de engenharia** — e isso é, ele mesmo, o achado. A tese de 07-21→10-23 é auto-demonstrada pela própria existência desta passada: **não há o que descobrir sem descongelar; a decisão está 137 dias atrasada. O único movimento em 24h foi o supply-chain piorar sozinho.**

---

## Notas de método

**Calibração (effort max = rigor, não ritual).** Reconheci: alvo congelado 137 dias em 4 camadas, 11 passadas prévias (6- e 2-agente fan-outs convergidos a 0 net-new), e a recomendação explícita de 10-22/10-23 de pausar a série. "Effort max" aqui é **rigor**, não maximização de tokens — e o rigor, estabelecido pelas próprias passadas 9-11 (GOV-1 + missão §4 "não invocar por inércia"), é que re-derivação do zero tem valor marginal **nulo**. Foquei o esforço no **único eixo que pode mover sem commit** (CVE — e moveu, +7) + re-verificação em 1ª mão dos anchors que sustentam a recomendação mínima ao piloto + os sweeps que a missão exige (debt-markers cat. d; existência dos inputs canônicos).

**Fan-out NÃO executado — por desenho** (ver box na Parte B). Repeti-lo contra bytes idênticos seria a inércia que a missão §4 proíbe. Toda a verificação desta passada foi do **orquestrador em 1ª mão**.

**Verificado em 1ª mão hoje** (HEAD 3e83d70, Node v22.23.3, pnpm 9.15.1): `git diff dbe9fd6..HEAD -- src db` (vazio) + log de commits (0 nas últimas 24h); git log do canon (branch não-merjada, 0 mudanças em 30d) e do lockfile (152d); `pnpm typecheck` (verde) / `lint` (6) / `test` (**443/443**) / `audit --prod` (**123** — 2·53·58·10, +7 vs 116); leitura integral de `src/index.ts` (ordem de registro NN1 + `initTelemetry` só na API + `unhandledRejection`), `src/lib/shutdown.ts` (LIFO :50 + docstring :4-13), `src/db/client.ts:51-53` (emit uncaughtException); greps `@fastify/jwt` (0 imports), `initTelemetry` (só index.ts), `TODO|FIXME|HACK|XXX|@deprecated` (1); `deployment-workers.yaml` (5 Deployments de worker, 0 probe) + localização das 5 linhas de probe (api/redis/cloudflared); extração das advisories crít/high do `pnpm audit --json`; `CronList` (vazio).

**Limitações.** (a) **es-1, A5/A5b, cross-app e o risco de token-lifecycle (B2) não confirmados em runtime** — sem acesso a prod nesta sessão autônoma. A análise estática é prova forte; cluster vivo + WABAs/tenants por app + `expires_at` de tokens + liveness do `worker:tok` **não são observáveis pelo código**. Gates diagnósticos (traces no Grafana? `worker:tok` vivo? tokens expirando?) exigem SSH a prod — deixados p/ a revisão humana. (b) `test:integration`/`test:e2e` não re-executados (byte-idêntico; 07-20 rodou integração 9/9). (c) `telemetry.ts` não re-lido (byte-idêntico; dobradiça Sentry-listener de B3 documentada em 10-23). (d) Consumer guide + checklist ausentes do repo; usados na versão canônica. (e) Breakdown exato por-advisory do +7 não diffado contra snapshot de 10-23 (10-23 não persistiu a lista por-item); o delta de **contagem** (116→123) e de **severidade** (2·51·55·8 → 2·53·58·10) é 1ª-mão e apples-to-apples (mesmo métrica de severity-sum do footer do `pnpm audit`).

**Restrição respeitada:** nenhum arquivo de produto foi modificado — este relatório é o único artefato produzido. Nenhuma ação sobre o scheduler externo foi tomada (fora do escopo autorizado; recomendada para a revisão humana).
