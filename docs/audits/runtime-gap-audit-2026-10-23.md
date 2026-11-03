# Gap Analysis — bevox-meta-api — 2026-10-23

> HEAD `ac57be9` · Node v22.23.3 · pnpm 9.15.1 · freeze de código **136 dias** (`dbe9fd6` = 2026-06-09; git reporta 135 pelo timestamp de commit) · **11ª auditoria** da série · **3ª em 72h**.

## Resumo executivo

Estado geral **inalterado e agora terminal**: V1 em produção servindo `bevox-backend` (piloto MVP Hetzner, vivo há ~149 dias desde 2026-05-27). Código de produto **byte-idêntico** desde `dbe9fd6` — `git diff dbe9fd6..HEAD -- src db` = **vazio**. k8s congelado há 123 dias; **canon congelado há 143 dias e ainda em branch não-merjado** (`fix/a14-…`, HEAD `0317985`). Esta é a 11ª passada e rodou **1 dia** após a 10ª, que recomendou **explicitamente pausar o cron** — recomendação **não actionada**; o cron disparou de novo. Principais riscos **para o piloto** (inalterados): classe "perda/zumbi silencioso em blip de PG/Redis/rollout" (NN1 + N1/NN-9a + A5/A5b + NN3 + NN4) e **MA-012 LGPD `Proposta`** bloqueando onboarding novo; **para GA**: contrato §3f factualmente incorreto + supply-chain (116 CVEs, flat). **Delta vs 10-22: zero fixes de engenharia (11ª consecutiva); o único eixo que se move sozinho — CVE — ficou flat pelo 3º dia seguido (116→116→116)**; 4 nuances/correções honestas abaixo; **nenhum net-new de correctness**. O veredito das passadas 9 e 10 agora é incontestável e auto-demonstrado pela própria existência desta passada: **o gargalo é 100% decisório; a série virou ritual automático contra bytes idênticos.**

**Recomendação única e prioritária desta passada (GOV-1, 2ª reincidência):** adjudicar o **Ledger de Decisão** da [10-22](./runtime-gap-audit-2026-10-22.md#parte-f--ledger-de-decisão-o-entregável-para-a-revisão-humana) item a item (fix **ou** aceite-de-risco explícito), e **desligar o scheduler externo** que dispara esta sessão diária. `CronList` retorna **"No scheduled jobs"** → **não é** um `/schedule` gerido pelo Claude; o gatilho é um **cron/timer de host** (emite o hook `=== bevox-meta-api — sessão iniciada ===`). A ação de pausa é no host, não no Claude.

---

## Parte A — Ground-truth (orquestrador, 1ª mão, 2026-10-23, HEAD ac57be9)

| Verificação | Resultado 2026-10-23 | vs 2026-10-22 |
|---|---|---|
| `git diff dbe9fd6..HEAD -- src db` | **vazio** (byte-idêntico) | igual |
| Freeze de código (src/db) | **136 dias** (`dbe9fd6` = 2026-06-09) | +1 dia |
| Freeze de k8s | **123 dias** (`5516c2a` = 2026-06-22) | +1 dia |
| Freeze do **canon** (bevox-knowledge) | **143 dias** (`0317985` = 2026-06-02, branch `fix/a14-…`, **não-merjado** — `branch --contains HEAD` = só a própria branch) | +1 dia |
| Commits no repo desde o freeze | **9** (8 `docs(audit)` + 1 `ops` k8s); 0 de engenharia | +1 (o audit 10-22) |
| `pnpm typecheck` | **VERDE** (exit 0) | igual |
| `pnpm lint` | **VERMELHO** — 6 problemas (`queues.ts:174` real + 3 parsing-error de snippets em `skills/…` + 1 `import()` + o `.mjs` untracked) | igual |
| `pnpm test` (unit) | **443/443 VERDE** (45 arquivos, ~14s) | igual |
| `pnpm audit --prod` | **116 vulns** (2 crít · 51 altas · 55 mod · 8 baixas) | **IDÊNTICO — flat pelo 3º dia** |
| Debt markers em `src/` (cat d) | **1 TODO** (`webhook-delivery.ts:211`), 0 FIXME/HACK/XXX/@deprecated | igual |
| `CronList` (scheduler Claude) | **"No scheduled jobs"** → gatilho é cron de host, externo | **net-new (não medido antes)** |

**Anchors de maior severidade re-verificados em 1ª mão hoje (0 drift nos bytes):**

- **NN1 shutdown invertido** — `index.ts:28-33` registra hooks na ordem `fastify → queues → event-bus → postgres → redis → telemetry`; `shutdown.ts:50` roda estritamente **LIFO** (`for i=hooks.length-1; i>=0; i--`) → execução real = `telemetry → redis → postgres → event-bus → queues → **fastify POR ÚLTIMO**`. É o **inverso exato** dos próprios docstrings (`shutdown.ts:4-9` e `index.ts:4-8`: "1. Fastify .close() primeiro"). Requests in-flight no SIGTERM batem em pool PG/Redis já fechado → erro espúrio em **todo rollout**. #1 ROI (~15min).
- **N1 / NN-9a (reconciliação do flip-flop crash-vs-zumbi)** — a **única** referência a `uncaughtException` em `src/` é um `process.emit("uncaughtException", err)` **manual** em `db/client.ts:52` (handler do `pool.on('error')`). **Não há `process.on("uncaughtException")` em `src/`.** Semântica precisa: um `emit` manual sem listener registrado é um dispatch EventEmitter comum que retorna `false` e **não** aciona o fatal-handler interno do Node (esse só dispara em throw genuinamente não-capturado via `_fatalException`, não num `emit` manual). **O comportamento bifurca exatamente no split API/worker** — validando (não refutando) o corpus: a **API** roda `initTelemetry()` (`index.ts:23`); **se** o SDK Sentry/OTel registrar seu listener `onUncaughtException` (default do SDK Node), o erro de pool é capturado e o processo pode terminar (**N1**); os **workers não inicializam telemetria** → **sem listener** → o `emit` é engolido → erro de pool de PG silenciosamente descartado → **zumbi silencioso (NN-9a)**. A dobradiça é a config do Sentry em `telemetry.ts` (não re-lida hoje — byte-idêntica; variável conhecida). `unhandledRejection` existe **só** em `index.ts:38` (API), confirmando o split.
- **#16 MA-015 de-subscribe ausente** — SURVIVES. `subscribed_apps` aparece 2× em `src/`, ambas o **POST** subscribe (`meta-client.ts:160` docstring, `:538` chamada); o único `unsubscribe` é pub/sub Redis p/ SSE (`events/routes.ts:113`), não-relacionado. **Nenhum `DELETE /{waba_id}/subscribed_apps`** → `disconnectWabaByMetaWabaId` dá UPDATE na row mas nunca pede à Meta pra parar → **subscription Meta órfã**.
- **@fastify/jwt morto** — `package.json:44` declara `^10.0.0`; **0 imports** em `src/`. As 2 CVEs **críticas** (`fast-jwt`) chegam só por essa dep → **não-alcançáveis**; removê-la zera-as de graça. JWT real via `jose`.
- **register-phone ausente** — `grep -E "request_code|/register|requestCode|verifyCode"` em `src/` = **0**. Fluxo de PIN/2FA de número não existe.
- **DSR ausente** — único vestígio é um **helper não-wired** (`media-storage.ts:86`: "usado no DSR erasure cascade"); **nenhum** endpoint `POST /admin/dsr`. Confirma gap de MA-012.
- **Docs canônicos do piloto ausentes do repo** — `docs/architecture/consumer-integration-guide-v1.md` e `docs/go-live-checklist.md` **não existem no repo** (README `:21,:65` linka ambos); vivem só no canon (`20_architecture/bevox-meta-api/`). `openapi.yaml` existe no repo (43.8KB, 2026-06-09).

**Pontos sólidos re-confirmados (não-achados):** UUIDv7 (I1); HMAC inbound constant-time ANTES do parse (I9 inbound); MA-008 envelope + zeroize; JWT RS256/kid/TTL nos dois paths (I5); `app_id` sempre do JWT assinado `iss` — **não-spoofável**; envelope de erro canônico Bevox (não-RFC7807); nenhuma credencial Meta em response schema. Placar das 11 invariantes **idêntico** a 10-21/10-22 — ver [§Parte E do 10-22](./runtime-gap-audit-2026-10-22.md#parte-e--placar-das-11-invariantes-claudemd-45--idêntico-a-10-21-anchors-de-hoje).

---

## Parte B — O delta real de 2026-10-23 (4 nuances; 0 net-new de correctness)

1. **CVE flat pelo 3º dia (116→116→116).** A dobra 65→116 ocorreu nos 91 dias entre 07-22 e 10-21; agora são **72h de janela** (10-21, 10-22, 10-23) com breakdown **idêntico** (2 crít · 51 alt · 55 mod · 8 bx). Prova quantitativa reforçada de que o alvo é estático **até no eixo temporal** — o único sinal que se move sem commit está parado. (Trava estrutural inalterada: lockfile congelado + imagem pinada `:dbe9fd6` `pullPolicy:Never` + CI build-only sem gate `audit`/Dependabot → patch não chega a prod sem rebuild manual.)

2. **Risco time-sharpened: ciclo de vida de token Meta sob 149 dias de piloto** (cat. j — **posture, não código**). O piloto está vivo há ~5 meses. Tokens de System User da WhatsApp Cloud API **podem** ser permanentes (sem expiry) **ou** long-lived (~60 dias, exigindo refresh). O worker `worker:tok` (`token-refresh.ts`) implementa o refresh, **mas** depende de dois defeitos abertos: **NN-9a** (erro de pool no worker engolido → zumbi silencioso) + **NN3** (workers sem `livenessProbe` → zumbi nunca reiniciado). **Composição temporal:** se os tokens do piloto forem da variante de 60 dias, já se passaram ~2-3 ciclos de refresh, **sem garantia em runtime de que o refresher rodou em cada um** — e o 1º sintoma de falha seria envio outbound retornando auth-error + inbound degradado, não um alarme. Quanto mais longo o freeze, mais acute. **Gate (exige prod):** `kubectl logs` do worker:tok + `expires_at` das rows de token no DB. **Condicional** (não-aplicável se tokens forem permanentes), mas é o risco que a passagem do tempo **cria** e que auditorias anteriores (feitas mais cedo no piloto) não podiam ver.

3. **Reconciliação N1-vs-NN-9a (ver Parte A).** O flip-flop de passadas anteriores ("crash" vs "zumbi") se resolve: o mecanismo **bifurca no split API/worker** e portanto **ambos os achados são reais e complementares** — API pode terminar (N1, dep. do listener Sentry), worker engole e vira zumbi (NN-9a). Correção de precisão ao corpus, não mudança de severidade.

4. **GOV-1 — 2ª reincidência (escalada terminal).** A recomendação de **pausar o cron** foi feita explicitamente em 10-22 e **não foi actionada**; a existência desta 11ª passada é a prova. `CronList` confirma que **não há** schedule gerido pelo Claude → o gatilho é externo ao Claude (cron/systemd de host). A pausa é uma ação **de host/humano**; o agente autônomo não pode (nem deve, sem autorização explícita) desligá-la por conta própria.

> **Fan-out NÃO executado nesta passada — por desenho.** 10-21 rodou 6 agentes; 10-22 rodou 2 (`invariants-auditor` + `tenant-scope-auditor`) com mandato de refutar e obteve **0 refutação / 0 drift / 0 net-new**. Repetir o fan-out contra bytes idênticos é precisamente a "invocação por inércia" que a missão proíbe e que GOV-1 denuncia. A verificação desta passada foi **inteira em 1ª mão pelo orquestrador** (Parte A), focada nos anchors de maior severidade + nos dois eixos que podem mover sem commit (CVE; tempo/token). Ver Notas de método.

---

## Parte C — Corpus por severidade (estável; detalhe canônico em 10-21/10-22)

> **Disciplina anti-ritual.** O corpus de ~37 achados é estável e byte-idêntico. Reproduzi-lo por extenso numa 11ª passada é o próprio sintoma de GOV-1. Abaixo: roll-up com âncora e status; **prosa só onde houve nuance hoje**. Detalhe completo + impacto: [`runtime-gap-audit-2026-10-22.md`](./runtime-gap-audit-2026-10-22.md#parte-b--achados-por-severidade-cobre-categorias-a-l-da-missão) (compacto) e [`runtime-gap-audit-2026-10-21.md`](./runtime-gap-audit-2026-10-21.md) (prosa integral).

### CRÍTICO (bloqueia conclusão do módulo / vivo-ou-iminente)

- **GOV-1 · 11 auditorias, 136 dias de freeze, ZERO remediação; recomendação de pausar ignorada** (cat. d/l) · **ESCALADO 2ª vez.** 9 commits desde o freeze (8 audit-docs + 1 k8s), 0 de engenharia. O Ledger de Decisão — "entregável de maior valor" desde 07-22 — não moveu um commit em 11 passadas. **Esforço de descoberta: 0h.** Ação: adjudicar o Ledger + pausar o scheduler de host.
- **CRÍT-1 · A5 + A5b — perda silenciosa de inbound em blip PG/Redis** (cat. a/h/i) · SURVIVES · LIVE p/ WABA onboarded (MA-015 wired). `inbound/service.ts:298` (`isDuplicate` SET NX antes do insert `:324`, sem `del()` compensatório); enqueue fora de try/catch (`:388-402`); `operations.ts:98` index não-único. ~6h.
- **CRÍT-2 · es-1 — secret do Meta App (compartilhado c/ V1) + tokens → spans OTel** (cat. d/j) · SURVIVES · CRÍTICO-no-código / **INERTE-em-prod** (NetworkPolicy bloqueia egress :4318 → `configmap.yaml:50` seta OTLP mas `networkpolicy.yaml:52-71` só libera 53/5432/6379/443). Corolário: **traces de prod dropados** (MA-007 quebrado). Gate: *traces no Grafana?* ~3-4h (scrub) **+** abrir :4318.
- **CRÍT-3 · Cross-app PII misdelivery** (cat. a/i/j/f/g) · SURVIVES · defeito CONFIRMED, **liveness LATENTE** (migração bevox-direct é greenfield + flag-dormante). Sem unique **global** em `meta_waba_id`/`meta_ig_id` (só por-tenant); sem guard de connect-time; resolvers sem `orderBy` (`wabas/repository.ts:84-91`, `ig/repository.ts:60-67`); `disconnectWabaByMetaWabaId` (`:187-203`) UPDATE sem scope → tokens órfãos; `webhook-delivery.ts:123,142` não reverifica `sub.appId == event.appId`. Gatilho real = **2 apps no mesmo asset Meta**. ~3h + testes.
- **CRÍT-4 · MA-012 LGPD `Status: Proposta`, 0/4 critérios, DSR não implementado** (cat. e) · SURVIVES. Canon `30_adr/bevox-meta-api/MA-012-…` presente; DSR só helper não-wired (`media-storage.ts:86`). Operação atual coberta pelo MSA bevox-backend; **onboarding novo bloqueado**. Eng ~7h + jurídico.

### ALTO (bloqueia GA; pilot-HIGH em blip de infra)

Roll-up **inalterado** vs [10-22 §ALTO](./runtime-gap-audit-2026-10-22.md#alto-bloqueia-ga-pilot-high-em-blip-de-infra--decidir-aceite) (15 itens, todos SURVIVES): **NN1** shutdown invertido *(1ª-mão hoje — Parte A)* · **N1+NN-9a** crash/zumbi *(1ª-mão, reconciliado — Parte A/B)* · **NN3** 5 workers sem probe · **N2/N4/NN5-inv** double-send Meta · **I2+NN1-inv** idempotência race + replay cross-tenant · **NN-9A** mutações admin sem `Idempotency-Key` · **supply-chain** (bump undici/fastify/fast-uri + drop @fastify/jwt) *(1ª-mão)* · **register-phone ausente** *(1ª-mão: 0 matches)* · **I8/N8** durabilidade do audit · **NN-9B/9C** read IDOR + soft-del via GET · **HMAC outbound** pode sair não-assinado + 2 formatos · **§3f** OpenAPI factualmente incorreto · **SSRF outbound** (egress-mitigado 443) · **NN-1** HMAC/verify-token secret global · **rlq-2/obs-1/2/3** 429 não-retentado + métricas 0 call-sites.

### MÉDIO / BAIXO

Inalterados vs [10-22 §MÉDIO](./runtime-gap-audit-2026-10-22.md#médio-degrada-qualidade) (itens 16-29: **#16 MA-015 de-subscribe órfão** *(1ª-mão hoje — SURVIVES)*, NN4 Redis sem eviction, es-1 traces dropados, NN5 retenção sem poda, status-reconciliation nunca implementado, N5 media OOM, N9 bodyLimit 413 pré-HMAC, redação incompleta, PII-at-rest, etc.) e [§BAIXO](./runtime-gap-audit-2026-10-22.md#baixo-higiene) (itens 30-37: 2 CVE crít `fast-jwt` dep-morta *(1ª-mão)*, lint vermelho *(1ª-mão)*, imagem pinada, `@types/node@20`, cron re-tica, drift de contrato, **doc-drift** *(1ª-mão: guide/checklist ausentes do repo; README "249 testes" vs 443 reais)*, hub.verify_token não-constant-time).

### Cobertura por categoria da missão (a-l)

| cat | Coberto por | 1ª-mão hoje? |
|---|---|---|
| a (spec'd não-impl) | register-phone, DSR, status-reconciliation, §3f, NN-9A | ✓ register/DSR |
| b (impl divergente) | §3f, status-reconciliation, envelope de erro | parcial |
| c (testes faltando) | `repository.ts` 0% unit; scoping I3 só por leitura estática | contagem 443/45 ✓ |
| d (debt) | **1 TODO** (`webhook-delivery.ts:211`); GOV-1; CVE | ✓ grep |
| e (LGPD) | MA-012 `Proposta`, DSR, I8 audit, NN5 retenção | ✓ DSR/MA-012 |
| f (OpenAPI drift) | §3f, handlers-fora-do-spec, renomes, canon-vs-repo | ref |
| g (go-live infra) | CNPG `instances:1`, Redis `replicas:1`, NN3 probes, secrets | ref |
| h (webhook real do piloto) | A5/A5b, NN1, es-1, double-send, NN4, N9 | ✓ NN1 |
| i (inbound HMAC/idem/replay/size) | HMAC constant-time (PASS), A5 dedup-antes-persist, N9 413, NN-1 | ✓ |
| j (token mgmt) | MA-008 (PASS), es-1 leak, **token-lifecycle time-sharpened (B2)** | ✓ |
| k (rate limit/quota) | rlq-2 429 não-retentado, obs métricas 0 call-sites | ref |
| l (delta vs anterior) | §Delta abaixo | ✓ |

---

## Itens-de-fechamento ordenados por valor/esforço (top 10)

Inalterado em substância vs 10-22. **Não é descoberta nova — é a lista de decisão que não se moveu em 11 passadas.**

| # | Item | Esforço | Destrava |
|---|------|---------|----------|
| 1 | **NN1** — Fastify fecha primeiro (registrar o hook por último **ou** fechar app antes do loop LIFO em `shutdown.ts`) | ~15min | Para o erro espúrio em **todo rollout** — melhor ROI |
| 2 | **NN3 + N1 + NN-9a** — `livenessProbe` nos 5 workers; `db/client.ts` **loga** em vez de `emit("uncaughtException")`; `initTelemetry()` nos workers | ~2h | Fecha o worker-zumbi invisível (inclui o **token-refresher** — risco B2) |
| 3 | **Supply-chain** — bump `fastify`≥5.12.5 + `undici`≥8.10.2 + `fast-uri`≥3.1.5; **drop `@fastify/jwt`** (zera 2 críticas mortas); **gate `pnpm audit/test/lint` em CI** + Dependabot | ~2h + rebuild | Fecha altas alcançáveis + a causa-raiz de governança do supply-chain |
| 4 | **NN4 + N11 + NN5** — Redis `maxmemory`+`noeviction`+alerta; `commandTimeout`; poda de `webhook_deliveries` | ~2h | Fecha data-loss de fila, hang, crescimento ilimitado |
| 5 | **es-1** — SpanProcessor/hook que apaga `url.full`/`url.query` p/ hosts Meta **+** abrir :4318 no egress (juntos) | ~4h | Fecha o CRÍTICO na origem **e** restaura MA-007 |
| 6 | **A5 + A5b** — `uniqueIndex` em `meta_event_id` + re-drive + wrap do enqueue | ~6h | Bloqueador #1 de inbound (LIVE p/ WABA onboarded) |
| 7 | **cross-app + #16** — `orderBy` determinístico + guard de connect-time + scope de app em `disconnectWabaByMetaWabaId` + `DELETE /subscribed_apps` no disconnect | ~4h + testes | Fecha PII-misdelivery (latente) + subscription órfã |
| 8 | **Idempotência atômica + fim do double-send + tenant na key + admin idempotente** | ~7h | Para double-send, replay cross-tenant, mutação admin não-idempotente |
| 9 | **Audit síncrono (I8) + NN-9B/9C** | ~5h | Fecha trilha forjável (pré-req MA-012) + IDOR + soft-del leak |
| 10 | **Convergência de contrato (canon→código)** + patchar exemplo do guia + **MA-012 + RoPa OT-19** | ~2d + jurídico | Desbloqueia onboarding-via-spec (GA) + go-live legal |

**Mínimo defensável p/ o piloto continuar** (inalterado): #1 + #2 + NN4 `noeviction` + #3 + gate es-1 (traces no Grafana?) + aceite-de-risco sobre A5/A5b e cross-app = **~4-6h eng** + decisão jurídica MA-012 + o gate diagnóstico de token/worker em prod (B2).

---

## Dependências cruzadas

- **es-1 / observabilidade** → scrub (es-1) e egress :4318 (obs/MA-007) vão **juntos**. Gate exige SSH a prod.
- **MA-012 / DSR / audit (I8) / retenção (NN5)** → advogado externo + RoPa **OT-19** (ADR-019/020); os gaps de eng **minam a base legal**.
- **Contrato (§3f, drift repo↔canon, guia)** → PRs em `bevox-knowledge` (SoT por ADR-005; canon **em branch não-merjado** há 143d — a premissa "doc ganha" repousa sobre branch não-merjada). Não mudar `signing_secret`/`event_id`/formato HMAC sem coordenar com `bevox-backend`.
- **cross-app + #16** → gatilho é **2 apps no mesmo asset Meta**, não a migração bevox-direct (greenfield+flag). Coordenar c/ futura migração dos boxes embedded do V1 (ver [[bevox-direct-migration-to-meta-api]], [[meta-app-bernardTavares-shared]]).
- **register-phone / ES-COEX / IG / MA-015** → dependem do Meta App compartilhado "Bevox Solutions" + Meta App Review + smoke/e2e contra sandbox.
- **A5/A5b, N1/NN-9a, NN1-NN4, token-lifecycle (B2), infra-4** → **compõem no mesmo gatilho** (blip de PG/Redis, rollout). A decisão de infra (single-node c/ RPO explícito **ou** réplica CNPG/Redis) é a de **maior alavancagem**.
- **Supply-chain (116 CVEs)** → sobe com o freeze; sem Dependabot/CI gate; imagem pinada bloqueia o patch.

---

## Delta vs auditoria anterior (2026-10-22 → 2026-10-23)

**Código / k8s / canon:** BYTE-IDÊNTICO em todas as camadas. 1 dia e 1 commit (o audit 10-22) de intervalo.

- **FIXED: 0.** 11ª consecutiva sem remediação de engenharia.
- **SURVIVES: todos.** Re-verificação em 1ª mão dos anchors de maior severidade: 0 drift. Placar das 11 invariantes idêntico.
- **NUANCES / CORREÇÕES ao corpus: 4.** (B1) **CVE flat pelo 3º dia** (116→116→116; janela de 72h estática). (B2) **Risco time-sharpened de token-lifecycle** — genuinamente novo porque é **criado pela passagem do tempo** (~149 dias de piloto × refresher sem probe/zumbi-engolido); não é achado de código mas de **postura**, e auditorias mais cedo no piloto não podiam vê-lo. (B3) **Reconciliação N1-vs-NN-9a** — o `process.emit("uncaughtException")` de `db/client.ts:52` sem listener bifurca no split API/worker, **validando** os dois achados como complementares. (B4) **GOV-1 2ª reincidência** — a recomendação de pausar o cron (10-22) não foi actionada; `CronList` vazio prova que o gatilho é **externo ao Claude**.
- **NET-NEW de correctness: 0.** Nenhum. O corpus está saturado; 11 passadas (incluindo 6- e 2-agente fan-outs) convergiram.
- **Saldo:** a 11ª passada **não acrescenta descoberta de engenharia** — e isso é, ele mesmo, o achado. Acrescenta: (1) a prova de que o eixo temporal (CVE) está flat por 72h; (2) um risco de postura que só o tempo revela (B2); (3) uma reconciliação de precisão (B3); (4) a escalada terminal de GOV-1 com a localização concreta do scheduler (host, não Claude). **A tese de 07-21/07-22/10-21/10-22 é agora auto-demonstrada pela própria existência desta passada: não há o que descobrir sem descongelar; a decisão está 136 dias atrasada.**

---

## Notas de método

**Calibração (effort max ≠ ritual).** Reconheci: alvo congelado 136 dias, 10 passadas prévias, e a recomendação explícita de 10-22 de pausar a série. "Effort max" aqui é **rigor**, não maximização de tokens — e o rigor, estabelecido pelas próprias passadas 9 e 10, é que re-derivação do zero tem valor marginal **nulo** (GOV-1 + missão: "não invocar por inércia"). Foquei o esforço nos **únicos eixos que podem mover sem commit** (CVE; tempo/token) + re-verificação em 1ª mão dos anchors de maior severidade + os sweeps que a missão exige explicitamente (debt-markers cat. d; existência dos inputs canônicos).

**Fan-out NÃO executado — por desenho** (ver box na Parte B). 10-22 rodou 2 agentes céticos → 0 net-new; repeti-lo seria a inércia que a missão proíbe. Toda a verificação desta passada foi do **orquestrador em 1ª mão**.

**Verificado em 1ª mão hoje** (HEAD ac57be9, Node v22.23.3): `git diff dbe9fd6..HEAD -- src db` (vazio) + log de commits; estado git do canon (branch não-merjado); `pnpm typecheck` (verde) / `lint` (6) / `test` (**443/443**) / `audit --prod` (**116**); leitura de `src/index.ts` (ordem de registro NN1 + unhandledRejection), `src/lib/shutdown.ts` (LIFO :50 + docstring), `src/db/client.ts:52` (emit uncaughtException); greps `subscribed_apps`/`unsubscrib`, `@fastify/jwt`, `request_code|register`, `uncaughtException`, `TODO|FIXME|HACK|XXX|@deprecated`; existência de `consumer-integration-guide`/`go-live-checklist` (ausentes do repo) + inputs canônicos em `$BEVOX_KNOWLEDGE_PATH` (PRD 2026-05-08, MA-001..008/012/013/014, runtime-topology, guide); `CronList` (vazio).

**Limitações.** (a) **es-1, A5/A5b, cross-app e o novo risco de token-lifecycle (B2) não confirmados em runtime** — sem acesso a prod nesta sessão autônoma. A análise estática é prova forte; o cluster vivo + contagem de WABAs/tenants por app + `expires_at` de tokens + liveness do worker:tok **não são observáveis pelo código**. Gates diagnósticos (traces no Grafana? worker:tok vivo? tokens expirando?) exigem SSH a prod — deixados p/ a revisão humana. (b) `test:integration`/`test:e2e` não re-executados (byte-idêntico; 07-20 rodou integração 9/9). (c) `telemetry.ts` não re-lido para resolver a dobradiça Sentry-listener de B3 (byte-idêntico; variável conhecida e documentada). (d) Consumer guide + checklist usados na versão canônica (ausentes do repo).

**Restrição respeitada:** nenhum arquivo de produto foi modificado — este relatório é o único artefato produzido. Nenhuma ação sobre o scheduler externo foi tomada (fora do escopo autorizado; recomendada para a revisão humana).
