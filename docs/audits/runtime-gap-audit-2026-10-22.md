# Gap Analysis — bevox-meta-api — 2026-10-22

## Resumo executivo

Estado geral: **V1 em produção servindo `bevox-backend` (piloto MVP Hetzner). Código de produto BYTE-IDÊNTICO desde `dbe9fd6` (2026-06-09) — freeze de 135 dias.** Esta é a **10ª auditoria** e a **2ª em 24 horas** (a 9ª foi ontem, 2026-10-21). HEAD é `0b58e0d` (o próprio audit de ontem); `git diff dbe9fd6..HEAD -- src db` = **vazio**. O k8s está congelado há 122 dias (`5516c2a`, 2026-06-22) e **o próprio canon está congelado há 142 dias** (bevox-knowledge HEAD `0317985`, 2026-06-02, ainda em branch `fix/a14-…`, não merjado em main). **Zero achados fecharam por engenharia em nenhuma das 10 passadas.**

**O veredito honesto da 10ª passada:** o alvo não se moveu em *nenhuma* camada, e a verificação de hoje torna isso incontestável — **até o único sinal que se move sozinho ficou parado**. `pnpm audit --prod` hoje retornou **exatamente** os mesmos 116 (2 crít · 51 altas · 55 mod · 8 baixas) de ontem: o supply-chain, que havia quase dobrado nos 91 dias entre 07-22 e 10-21, ficou **flat dia-a-dia**. Dois agentes especializados independentes (invariants-auditor + tenant-scope-auditor) re-derivaram do código com mandato de refutar e **retornaram 0 refutação, 0 drift de linha, 0 net-new** — o invariants-auditor em palavras próprias: *"10ª passada contra alvo congelado, 0 net-new; o gargalo é decisório, não de descoberta."* Placar das 11 invariantes **idêntico** a ontem.

**Portanto: não há achados novos de engenharia a relatar.** O corpus canônico de ~35 achados está integral e estável; a referência de detalhe completo é [`runtime-gap-audit-2026-10-21.md`](./runtime-gap-audit-2026-10-21.md), cujos anchors foram todos re-verificados hoje em primeira mão (ver Parte A). O valor marginal desta passada é **(1)** a prova quantitativa de que o alvo é estático até no eixo temporal (CVE flat em 24h); **(2)** três **correções honestas ao corpus** (abaixo); e **(3)** uma recomendação de governança específica para hoje.

**Correções ao corpus (o delta real de 2026-10-22):**

1. **CRÍT-3 (cross-app PII misdelivery) — liveness REBAIXADA de "migration-gated-LIVE" para "LATENTE mecânico".** O defeito está **confirmado** (sem unique global em `meta_waba_id`/`meta_ig_id` — só por-tenant; sem guard no connect-time; resolvers sem `orderBy`; disconnect cross-app + tokens órfãos vivos). Mas a leitura em primeira mão do spec de migração (`docs/superpowers/specs/2026-06-02-bevox-direct-foundation-design.md`) mostra que o **bevox-direct Foundation está dormente atrás do flag `META_API_FOUNDATION_ENABLED` (default false)** e é **greenfield** ("nenhuma caixa WhatsApp conectada no bevox-direct, sem backfill"). Logo a migração **não re-vincula um asset que o bevox-backend já possui** — não abre sozinha a janela de overlap. O gatilho real é **qualquer cenário em que 2 apps vinculem o MESMO `meta_waba_id`/`meta_phone_id`/`meta_ig_id`** (erro operacional, ou a futura migração dos boxes embedded do V1), não a migração bevox-direct em curso. Ontem elevou com base numa premissa de liveness que a leitura do spec de hoje tempera.

2. **A5/A5b (perda de inbound) — liveness SHARPENED.** Confirmei em primeira mão que o override de webhook por-WABA do **MA-015 ESTÁ wired no código congelado** (`wabas/service.ts:115` → `meta-client.ts:532`; commits `4aa7017`+`82f09a7` em main). Isso significa que **toda WABA onboarded pela meta-api recebe inbound em `/webhooks/meta`** — o path inbound é vivo para WABAs onboarded, não "latente até um app dedicado". A5/A5b é LIVE para qualquer WABA que tenha passado pelo gateway (a confirmação de que já existe uma exige acesso a prod/DB, fora do escopo autônomo).

3. **NET-NEW (um, operacional): MA-015 follow-up "de-subscribe no disconnect" NÃO implementado.** `grep` por `DELETE …/subscribed_apps` em `src/` = 0. `disconnectWabaByMetaWabaId` dá `UPDATE` na row mas **nunca** chama a Meta para parar de enviar → **subscription órfã**: a Meta segue mandando inbound de uma WABA desconectada para `/webhooks/meta`, para a qual não há mais token/binding. Compõe com o disconnect cross-app da CRÍT-3.

**Riscos materiais para piloto/GA (inalterados em substância vs 10-21):**

1. **Classe "perda/corrupção/zumbi silencioso em blip de PG/Redis/rollout"** — NN1 (shutdown invertido, dispara TODO deploy, ~15min, melhor ROI) + NN-9a (worker-zumbi invisível) + A5/A5b (inbound perdido, agora LIVE p/ WABA onboarded) + N2/N4/NN5-inv (double-send Meta no path outbound vivo) + NN4 (Redis sem eviction) — compõem com infra-4 (CNPG `instances:1` + Redis `replicas:1`, sem HA física). O blip é *quando*, não *se*.
2. **es-1 (CRÍTICO no código, INERTE em prod)** — secret do Meta App compartilhado com V1 + tokens → spans OTel; mas a `NetworkPolicy` bloqueia egress em :4318 (confirmado hoje 3ª vez em primeira mão). Corolário: **traces de prod dropados** (MA-007 quebrado). Gate: *traces no Tempo/Grafana?*
3. **MA-012 (jurídico)** — `Status: Proposta`, 0/4 critérios, DSR não implementado. Bloqueia go-live formal e onboarding novo (operação atual coberta pelo MSA bevox-backend).
4. **Contrato publicado factualmente incorreto (§3f)** — cliente gerado de QUALQUER dos dois OpenAPI (ambos v1.2.0) → **400 em todo send**. Bloqueia onboarding-via-spec (GA), não o piloto guide-first; o exemplo do guia (`:145`) cai na mesma armadilha.
5. **Governança sem rede** — `pnpm lint` vermelho (6), **CI build-only** (`build-image.yml` sem gate de test/lint/typecheck/audit — confirmado hoje), **sem Dependabot/Renovate**, 116 CVEs sem monitor, imagem pinada `:dbe9fd6` `pullPolicy:Never`.

**Tese central (governança, não descoberta) — agora com corolário operacional:** o alvo não se moveu por **135 dias e 10 auditorias**, e a 10ª rodou **1 dia** depois da 9ª produzindo um relatório materialmente idêntico. **Isso é o sintoma mais nítido possível de GOV-1: a série de auditorias virou ritual automático diário contra um alvo estático.** A recomendação concreta de hoje, além de adjudicar o Ledger (Parte F): **desligar/pausar o cron de auditoria autônoma até o código descongelar** — uma passada a cada 24h contra bytes idênticos é desperdício puro, e a cadência diária é por si só evidência de que o loop de decisão está quebrado. **Ou se descongela para o mínimo defensável (~4-6h eng + decisão jurídica MA-012), ou se encerra a série e se registra aceite-de-risco formal.**

> **Nota de confiança.** Ground-truth executado pelo orquestrador (Node **v22.23.3**, pnpm 9.15.1, HEAD `0b58e0d`). Fan-out **focado** (não ritual): 2 agentes via Agent tool (`invariants-auditor`, `tenant-scope-auditor`), read-only, re-derivando do CÓDIGO com mandato de refutar os anchors e caçar net-new — escolhidos por serem os dois domínios mais sensíveis à migração bevox-direct em curso. Os demais domínios (es-1/secrets, HMAC, contrato) foram re-verificados pelo **próprio orquestrador em primeira mão** (lista na Parte A / Notas de método), não por agente, justamente para não repetir o fan-out de 6 agentes de ontem (que GOV-1 e o próprio prompt — "não invocar por inércia" — desaconselham num alvo congelado). Nenhum arquivo de produto foi modificado — este relatório é o único artefato.

---

## Parte A — Ground-truth (orquestrador, Node v22.23.3, HEAD 0b58e0d)

| Verificação | Resultado 2026-10-22 | vs 2026-10-21 |
|---|---|---|
| `git diff dbe9fd6..HEAD -- src db` | **vazio** (byte-idêntico) | igual |
| Freeze de código (src/db) | **135 dias** (`dbe9fd6` = 2026-06-09) | +1 dia |
| Freeze de k8s | **122 dias** (`5516c2a` = 2026-06-22) | +1 dia |
| Freeze do **canon** (bevox-knowledge) | **142 dias** (`0317985` = 2026-06-02, branch `fix/a14-…`, não-merjado) | **net-new (não medido antes)** |
| Commits no repo desde o freeze | **8** (7 `docs(audit)` + 1 `ops` k8s) | +1 (o audit 10-21) |
| Commits desde o audit 07-22 | **1** (só o audit 10-21) | +1 |
| `pnpm typecheck` | **VERDE** (exit 0) | igual |
| `pnpm lint` | **VERMELHO** — 6 problemas (`src/lib/queues.ts:174` real + 4 snippets em `skills/.../snippets/` + 1 artefato untracked `.claude/tmp-gap-audit-workflow.mjs`) | igual (byte-idêntico) |
| `pnpm test` (unit) | **443/443 VERDE** (45 arquivos, 15.7s) | igual |
| `pnpm audit --prod` | **116 vulns** (2 crít · 51 altas · 55 mod · 8 baixas) | **IDÊNTICO** — flat dia-a-dia |

**Re-verificação em primeira mão hoje (anchors de maior severidade, confirmados nos bytes de hoje — 0 drift):**

- **NN1 shutdown invertido** — `index.ts:28` registra `fastify` PRIMEIRO; `shutdown.ts:50` executa estritamente LIFO (`for i=hooks.length-1; i>=0; i--`) → `fastify.close()` roda por ÚLTIMO, depois de `postgres`/`redis` fechados — **o inverso exato do docstring do próprio arquivo** (`shutdown.ts:4-9`). Dispara em todo rollout. Fix ~15min.
- **N1/NN-9a** — `index.ts` tem `process.on("unhandledRejection")` (`:38`) mas **nenhum** `process.on("uncaughtException")`. Confirma o split: API-com-Sentry termina; workers (sem telemetry) engolem o `pool.on('error')` → zumbi silencioso.
- **es-1 (cadeia completa)** — `configmap.yaml:50` seta `OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector.monitoring…:4318`; `networkpolicy.yaml:52-71` permite egress só em 53/5432/6379/**443** — **:4318 ausente**. 3ª confirmação independente: spans com secret **não saem do pod** (es-1 inerte) **e** traces de prod dropados (MA-007 quebrado).
- **§3f contrato** — `openapi.yaml:1202-1233` (`MessageSendRequest`): `required:[channel,to,type]`, campo `from_phone_number_id`, enum de **8 tipos**, chaves top-level por-tipo (`text`/`template`/`media`/`interactive`). Código (`messages/schemas.ts:28-41`): `from` + chave única **`content`** discriminada por `type`, só **3 tipos** (text/template/image). Cliente gerado de qualquer spec → **400**. Guia canônico `:145` cai na armadilha (exemplo trunca em `type:"template", ...` sem `content`); `:267` diz "6 tentativas" vs `WEBHOOK_DELIVERY_MAX_RETRIES` default **8** (`env.ts:86`).
- **I9 outbound não-assinado** — `messages/schemas.ts:55-56` `callback_url`/`callback_secret` opcionais sem `.refine()`; `outbound-dispatcher.ts:50` assina só `if (secret)` → sai POST sem header. 2 esquemas incompatíveis (`x-bevox-signature-256` body-only vs `x-bevox-signature: t=,v1=`).
- **MA-015 wired** (ver Resumo) + **de-subscribe follow-up ausente** (`grep DELETE …subscribed_apps` = 0).
- **@fastify/jwt morto** — `package.json:44` declara, **0 imports** em `src/`; JWT via `jose` (`auth-admin.ts:23`, `auth-jwt-consumer.ts:17`). As 2 críticas (`fast-jwt`) são não-alcançáveis; remover a dep zera-as de graça.
- **CI build-only** — única workflow `build-image.yml` (`push:[main]` → Buildx → push ghcr); **zero** step de `test`/`lint`/`typecheck`/`audit`. Sem `dependabot.yml`/`renovate.json`.

**Pontos sólidos re-confirmados (não-achados):** I1 UUIDv7 (`_shared.ts:73` + migration `uuid PRIMARY KEY`, zero serial/uuidv4); HMAC inbound constant-time ANTES do parse (`inbound/routes.ts:58` → parse `:119-121`); MA-008 envelope + zeroize; JWT RS256/kid/TTL travado nos dois paths (`auth-jwt-consumer.ts:93,145,96,162`); **`app_id` sempre do JWT assinado `iss` — NÃO spoofável** (`auth-jwt-consumer.ts:118-121`); envelope de erro canônico Bevox (não-RFC7807); nenhum campo de credencial Meta em response schema.

---

## Parte B — Achados por severidade (cobre categorias a-l da missão)

> **Disciplina anti-ritual.** O corpus é estável e detalhado em `runtime-gap-audit-2026-10-21.md`. Aqui apresento cada achado de forma **compacta** (descrição · evidência-âncora de hoje · categoria · esforço · status), com **prosa completa só onde há nuance nova de 2026-10-22**. "SURVIVES" = re-confirmado hoje sem drift. Impacto detalhado: ver 10-21.

### CRÍTICO (bloqueia conclusão do módulo / vivo-ou-iminente)

**GOV-1 · Programa: 10 auditorias, 135 dias de freeze, ZERO remediação — e a cadência virou diária** (cat. d/l) · **ESCALADO**
8 commits no repo desde o freeze (7 audit-docs + 1 k8s bump); 0 de engenharia. A 10ª passada rodou **1 dia** após a 9ª e produziu relatório materialmente idêntico. O Ledger de Decisão, declarado "o entregável de maior valor" em 07-22 e 10-21, **não moveu um commit**. **Impacto:** o módulo não termina por falta de descoberta — termina por falta de decisão; e o loop autônomo agora gasta recurso diariamente contra bytes idênticos. **Esforço:** 0h de descoberta. **Recomendação (hoje):** (a) adjudicar o Ledger (Parte F) item a item; **(b) pausar o cron de auditoria autônoma até o código descongelar** — relatórios diários idênticos são desperdício e são o próprio sintoma.

**CRÍT-1 · A5 + A5b — perda/sub-entrega silenciosa de inbound em blip de PG/Redis** (cat. a/h/i) · SURVIVES · **liveness SHARPENED**
`inbound/service.ts:298` chama `isDuplicate` (SET NX EX 24h) **antes** de `insertInboundEvent` (`:324`), sem `del()` compensatório; `listActiveSubscriptions`+loop `queue.add` (`:388-402`) fora de try/catch; `operations.ts:98` usa `index()` não-único em `meta_event_id`. Insert/enqueue lança → 5xx → Meta retenta → dedup suprime → evento **nunca persistido/entregue**. **Nuance 2026-10-22:** o override MA-015 está wired → inbound de WABA onboarded É roteado a `/webhooks/meta` → **A5/A5b LIVE para WABA onboarded** (não só "app dedicado"). **~6h** (uniqueIndex + re-drive + wrap do enqueue).

**CRÍT-2 · es-1 — secret do Meta App (compartilhado com V1) + tokens → spans OTel** (cat. d/j) · SURVIVES · CONFIRMED-no-código / INERTE-em-prod
Cadeia completa re-confirmada hoje em 1ª mão (Parte A). Defeito de código CRÍTICO e latente (1 edição de manifesto o torna vivo); egress bloqueia :4318. Gate: *traces no Grafana?* Fix ~3-4h (SpanProcessor/hook que apaga `url.full`/`url.query` p/ hosts Meta) **junto** com abrir :4318. MA-015 confirma o acoplamento: `META_WEBHOOK_APP_SECRET`/`app_secret` são **compartilhados com o V1** por design.

**CRÍT-3 · Cross-app PII misdelivery (f/g/d) — defeito CONFIRMED, liveness REBAIXADA a LATENTE** (cat. a/i/j) · **REFRAME 2026-10-22**
Anchors (tenant-scope-auditor, hoje, 0 drift): `wabas/repository.ts:84-91` (`findWabaByMetaWabaId` `.limit(1)` sem orderBy), `ig/repository.ts:60-67`, `wabas/repository.ts:187-203` (`disconnectWabaByMetaWabaId` UPDATE por `meta_waba_id` sem tenant/app/limit; supersede só a row retornada → **outra conexão fica com tokens vivos**), `bindings.ts:111-113` (phone unique GLOBAL) + `phone-numbers/repository.ts:37-46` (upsert não re-parenteia → row-takeover silencioso cross-tenant), consumido em `inbound/service.ts:204,212`; worker `webhook-delivery.ts:123,142` **não** reverifica `sub.appId == event.appId`. **Chave:** o schema **não tem** unique global em `meta_waba_id`/`meta_ig_id` (só `(tenant_id, meta_*_id)`) e **não há guard de connect-time** → overlap é mecanicamente possível. **Correção de liveness (vs 10-21):** a migração bevox-direct é **greenfield + flag-dormante** (`META_API_FOUNDATION_ENABLED` default false; sem backfill) → **não abre sozinha a janela**. Gatilho real = 2 apps vinculando o MESMO asset Meta (erro operacional, ou futura migração dos boxes do V1). **Severidade mantida CRÍTICO** (consequência = PII inbound ao app errado + disconnect cross-app + tokens órfãos), **mas LATENTE, não migration-gated-live.** **~3h + testes.**

**CRÍT-4 · MA-012 — postura LGPD `Status: Proposta`, 0/4 critérios, DSR não implementado** (cat. e) · SURVIVES
`$BEVOX_KNOWLEDGE_PATH/30_adr/bevox-meta-api/MA-012-…:3` (`Proposta`, committed 2026-05-08); critério de Aceita (parecer externo + RoPa OT-19 via ADR-019/020 + PRD §12 + carimbo) — **0/4**. DSR `POST /admin/dsr` não implementado (só helper de erasure não-wired). Base legal minada por I8 (audit forjável) + gaps de retenção (NN5). README: `bevox-backend` sob MSA → operação atual defensável; **onboarding novo bloqueado**. **Eng ~7h + jurídico ~24h.**

> Nenhum CRÍTICO refutado. A5/es-1/MA-012 intactos; cross-app **reframe honesto** (defeito intacto, liveness tempered); GOV-1 escalado pela cadência diária.

### ALTO (bloqueia GA; pilot-HIGH em blip de infra — decidir aceite)

| # | Achado | Âncora (hoje) | cat | Status | ~Esforço |
|---|--------|---------------|-----|--------|----------|
| 1 | **NN1 shutdown invertido** (dispara todo rollout) · **melhor ROI** | `index.ts:28` + `shutdown.ts:50` (LIFO) | h | SURVIVES · 1ª-mão hoje | ~15min |
| 2 | **N1 + NN-9a** crash API / zumbi-silencioso worker | `db/client.ts:51-53`; sem `uncaughtException` | h/d | SURVIVES · 1ª-mão hoje | ~1.5h |
| 3 | **NN3** 5 workers sem probes k8s (singletons `replicas:1`) | `deployment-workers.yaml` (0 probes); `worker-metrics-server.ts:74` pronto | g/h | SURVIVES | ~XS |
| 4 | **N2/N4/NN5-inv/NN-9E** double-send Meta / job preso / 500-pós-envio (**path vivo**) | `messages/service.ts:181`→`:203`; `queues.ts:31`; `operations.ts:68` | a/h/k/j | SURVIVES | ~6-8h |
| 5 | **I2 + NN1-inv** idempotência race sync + replay cross-tenant | `idempotency.ts:98`→`:136`; tenant no header `schemas.ts:46` | a/h | SURVIVES · 1ª-mão hoje | ~4-6h |
| 6 | **NN-9A** mutações admin sem `Idempotency-Key` | plugin `throw` sem `req.auth` (`idempotency.ts:84`); admin seta `req.admin` (`auth-admin.ts:104`); `apps/routes.ts:24,35,44`; `webhooks/routes.ts:58` | a | SURVIVES · 1ª-mão hoje | ~2-3h |
| 7 | **Supply-chain**: `undici`≥8.10.2 + `fastify`≥5.12.5 + `fast-uri`≥3.1.5 + drop `@fastify/jwt` | `pnpm audit` (116); `package.json:44` (dead) | d/h | SURVIVES (flat 24h) | ~1-2h + rebuild |
| 8 | **Ausência do fluxo `register` de phone** (PIN 2FA antes do 1º envio) | `grep register\|request_code` em `src/` = 0 | a/g/h | SURVIVES | ~6h |
| 9 | **I8/N8/NN4-inv** durabilidade+integridade do audit (pré-req MA-012) | `audit-log.ts:60-61,82,50`; `lib/audit.ts:45`; `db/schema/audit.ts:8` (TODO) | e | SURVIVES · 1ª-mão hoje | ~5h |
| 10 | **NN-9B/NN-9C** read IDOR cross-tenant + tenant soft-deleted via GET | `messages/repository.ts:48-52`; `tenants/repository.ts:32-38` + `service.ts:62-65` | a | SURVIVES · 1ª-mão hoje | ~2h |
| 11 | **Outbound HMAC** callback pode sair não-assinado + anti-replay ausente + 2 esquemas | `outbound-dispatcher.ts:50,56` vs `webhook-delivery.ts:71-76` | i | SURVIVES · 1ª-mão hoje | ~2h |
| 12 | **Contrato §3f** OpenAPI factualmente incorreto + armadilha do guia | `openapi.yaml:1202-1233` vs `messages/schemas.ts:28-41`; guia `:145,:267` | b/f | SURVIVES · 1ª-mão hoje | ~2h guia / ~2d canon |
| 13 | **SSRF outbound** (oráculo verify-on-create + callback http) — egress-mitigado a 443 | `webhooks/service.ts:63,112-115`; `messages/schemas.ts:55` | g/h/i | SURVIVES | ~4h |
| 14 | **NN-1 hmac** HMAC inbound + verify-token são secret GLOBAL, não per-Meta-app | `inbound/routes.ts:46,91`; `env.ts:69`; MA-015 (acoplamento V1) | i | SURVIVES | ~1-2d |
| 15 | **rlq-2 + obs-1/2/3** 429 Meta não retentado + métricas-chave 0 call-sites | `meta-client.ts:261`; `metaRequestDuration`/`tokenRefreshTotal`/`queueSize` | k | SURVIVES | ~3h |

### MÉDIO (degrada qualidade)

| # | Achado | Âncora (hoje) | cat | ~Esforço |
|---|--------|---------------|-----|----------|
| 16 | **MA-015 de-subscribe ausente → subscription Meta órfã** (**NET-NEW 2026-10-22**) | `grep DELETE …subscribed_apps` = 0; `disconnectWabaByMetaWabaId` não chama Meta | h/i/j | ~P-M |
| 17 | **NN4** Redis sem `maxmemory`/eviction (fila durável × cache efêmero) | `redis.yaml:32-35`; `queues.ts:33`; staging `docker-compose.prod.yml:42` | h/j | ~S |
| 18 | **es-1 corolário** traces de prod dropados (egress :4318) | `networkpolicy.yaml:52-71` | k | ~0.5h (junto c/ es-1) |
| 19 | **NN5** cleanup nunca poda `webhook_deliveries` nem `audit_logs` (ADR-020 sem hard-delete-5a) | `cleanup/repository.ts` | e/h | ~S-M |
| 20 | **Status reconciliation nunca implementado** — `delivered`/`read` anunciados mas nunca persistidos | `messages/schemas.ts:79-87` (comentário admite só `queued\|sent\|failed`) | b/a | ~M |
| 21 | **N5/NN-9d** media OOM (`arrayBuffer()` sem cap) | `meta-client.ts:750`; `media-download.ts:61` | h/j | ~M |
| 22 | **N6/NN-9e** `readyz` não checa S3; KMS arrasta grpc/protobuf ao hot-path | `health.ts:108-113` | g/h | ~P |
| 23 | **N9** `/webhooks/meta` sem override de bodyLimit 1MB → 413 pré-HMAC | `server.ts:102` | i/h | ~P |
| 24 | **N11** Redis `enableOfflineQueue:true` sem `commandTimeout` | `redis.ts:22` | h | ~P |
| 25 | **es-1 vetor 2ário** redação incompleta (22 sinks `{err}`; key-list lowercased-exato) | `logger.ts:151`; `serializeErrorRedacted` não é `serializers.err` | d/j | ~2h |
| 26 | **N1-secrets** label de rota 404 com cardinalidade ilimitada | `server.ts:155`; `metrics.ts:26,34` | k | ~0.5h |
| 27 | **E.164 sem máscara em repouso** + `error.details`/`from` cru na response | `messages/service.ts:177,241`; `error-handler.ts:69` | e | ~0.5h |
| 28 | **NN-9b/NN-9c-completeness** staging workers "unhealthy" + dead_letter terminal-silencioso | `Dockerfile:107` (`:3000` vs worker `:9090`); `webhook-delivery.ts:210-211` (TODO) | h | ~P-M |
| 29 | **NN-worker-1/2** UPDATE/SELECT sem `app_id` em tabelas que têm `app_id` (worker-only/admin-gated) | `messages/repository.ts:57-85`; `wabas/repository.ts:255-311`; `ig/repository.ts:81-124` | a | ~2h |

### BAIXO (higiene)

| # | Achado | Âncora (hoje) | ~Esforço |
|---|--------|---------------|----------|
| 30 | **CVE crítico `fast-jwt` (2)** — dep MORTA (`@fastify/jwt` nunca importado) | `package.json:44` | ~15min |
| 31 | **`pnpm lint` exit 1** (`queues.ts:174` real + 4 snippets + `.mjs` untracked) | — | ~1h |
| 32 | **NN7** imagem `:dbe9fd6` `pullPolicy:Never` + Dockerfile embarca dev-deps | `Dockerfile:96` (stage `prod-deps` existe, não usado) | ~M |
| 33 | **N10** `@types/node@20` vs `engines>=22.19`; `@types/uuid@11` vs `uuid@14` | `package.json:76,78` | ~0.5h |
| 34 | **N12/N13** cron re-tica no rollout + "3am UTC" falso; HPA só API; PDB ausente p/ tok/cleanup/media | `cleanup.ts:71,9`; `token-refresh.ts:172`; `hpa.yaml`; `pdb.yaml` | ~2h |
| 35 | **Contrato** drift repo↔canon (mesmo 1.2.0) + renomes + handlers-fora-do-spec + `private_key_pem` em response (exceção by-design, não-marcada) | `openapi.yaml`; `apps/routes.ts` (201/rotate) | ~2d |
| 36 | **Doc-drift** (ver Parte C abaixo) | README; CLAUDE.md:16; `docs/adr/README.md` | ~1h |
| 37 | **F8/F7-SSE/JWT-clamp** `hub.verify_token` `===` não-constant-time; fan-out SSE ilimitado; `JWT_MAX_AGE_SECONDS.max(900)` (default 300, compliant) | `inbound/routes.ts:91`; `env.ts:78` | ~P |

---

## Parte C — Doc-drift re-confirmado + net-new de documentação

Tudo cat. (b)/(f)/(l). Nenhum bloqueia piloto; são **higiene de canon** (mudança exige PR explícito — CLAUDE.md §8).

- **README** (`:7`) diz "V1 em produção" mas `package.json:3` é `0.1.0` (nunca bumpado p/ 1.0.0). "249 testes" (`:9,:78`) vs **443** reais. Linka `docs/architecture/consumer-integration-guide-v1.md` (`:21,:63`) e `go-live-checklist.md` (`:65`) — **ambos ausentes do repo** (vivem só no canon `20_architecture/bevox-meta-api/`).
- **CLAUDE.md §2** (`:16`) manda ler "`docs/adr/` — ADRs MA-001..MA-008 (Aceitas) + MA-012" — mas essas ADRs **migraram para o canon em 2026-05-08** (`docs/adr/README.md:3`); o dir local hoje só tem **MA-015 + MA-016 (drafts) + README**. O ponteiro do CLAUDE.md está obsoleto. **(NET-NEW de doc.)**
- **`docs/adr/README.md`** índice (`:17-33`) lista MA-001..008 + MA-012 e diz MA-009/010/011 "sem ADR escrita" — mas **omite MA-013/MA-014 (existem no canon) e MA-015/MA-016 (existem local)**. Índice stale. **(NET-NEW de doc.)**
- **MA-015 process inversion** — `Status: Proposta` (`:3`) mas a implementação **está em produção** (wired + commits em main). Inversão de processo (uma ADR que decide algo já vivo). Critério de Aceita `:155-158` (carimbo do fundador + smoke/e2e contra sandbox) não cumprido.
- **MA-016 (analytics)** — `Status: Proposta`, **ADR de intenção/backlog**, **não implementado** (sem módulo, sem spec). Gate do sub-projeto **Cleanup** da migração bevox-direct (critério "zero `graph.facebook.com`") — **não** do piloto nem de Foundation/Dispatch.
- **Canon em branch não-merjado** — bevox-knowledge está em `fix/a14-bevox-meta-api-ig-callback-spec` (HEAD 2026-06-02), e `docs/adr/README.md:7` admite que o canon está "em draft branch até review+merge". A premissa "documentação ganha / canon é SoT" (CLAUDE.md §2, ADR-005) repousa sobre branches não-merjadas. **(NET-NEW de observação.)**
- **Guia consumer** — `:267` "6 tentativas" vs código `8`; exemplo de send `:145` trunca sem `content` (armadilha §3f).

---

## Parte D — Varredura de CVE (116 — flat dia-a-dia)

`pnpm audit --prod` @ HEAD `0b58e0d`: **116 vulns** (2 críticas · 51 altas · 55 moderadas · 8 baixas) — **breakdown idêntico ao de 2026-10-21**. A dobra (65→116) ocorreu nos 91 dias entre 07-22 e 10-21; **em 24h não mudou** (snapshot de advisories estável no dia). Triagem por **alcançabilidade** (inalterada vs 10-21):

| Sev | Pacote | Alcançável? | Ação |
|---|---|---|---|
| **CRÍT ×2** | `fast-jwt@6.2.2` (via `@fastify/jwt`) | **NÃO** — dep nunca importada; JWT via `jose` | **Remover `@fastify/jwt`** → zera as 2 críticas |
| **ALTO** | `undici@8.1.0` (direta) | **SIM** — cliente de toda chamada Meta + outbound | Bump ≥8.10.2 (confirmado no output de hoje) |
| **ALTO** | `fastify@5.8.5` (core) | **SIM** — request-path; mina §4 | Bump ≥5.12.5 |
| **ALTO ×9** | `fast-uri@3.1.0` (via fastify/ajv) | **SIM** — parse de URI de todo request | Bump ≥3.1.5 |
| baixa/alta | `@grpc/grpc-js@1.14.3` (+protobuf, via `@google-cloud/kms`/OTel) | baixa (resposta confiável GCP) | Bump transitivo ≥1.14.5 |
| — | `@fastify/static`, `find-my-way`, `@opentelemetry/*`, `joi`, `brace-expansion` | **REFUTADAS** (swagger off em prod; HTTP1; OTLP push+egress block; transitivos) | monitorar |

**Trava estrutural (inalterada):** lockfile congelado + imagem pinada `:dbe9fd6` `pullPolicy:Never` → patch não chega a prod sem rebuild. **Sem gate** (CI build-only, sem Dependabot/Renovate — confirmado hoje). O número sobe sozinho — e só não subiu hoje porque foram 24h.

---

## Parte E — Placar das 11 invariantes (CLAUDE.md §4/§5) — idêntico a 10-21, anchors de hoje

Re-derivado pelo invariants-auditor (0 refutação, 0 net-new) + migration SQL (`uuid PRIMARY KEY`).

| Inv | Veredito | Âncora atual (HEAD 0b58e0d) |
|---|---|---|
| **I1** UUIDv7 | **PASS** | `db/schema/_shared.ts:73`; `db/migrations/0000_initial_schema.sql:12` (`uuid PRIMARY KEY`); zero serial/uuidv4/gen_random. |
| **I2** Idempotência | **PARTIAL (FAIL na garantia)** | `idempotency.ts:98→136` (read-then-write sem reserva); `messages/service.ts:181` Meta antes do insert `:203`; replay cross-tenant (`:86,97` + header `schemas.ts:46`); admin sem (NN-9A). |
| **I3** app/tenant-scope | **PARTIAL / DRIFT** | `server.ts:147` (plugin "futuro" — nunca existiu); `app_id` do JWT `iss` **não-spoofável** (fronteira dura íntegra); `tenant_id` = defense-in-depth (sem claim). Gaps f/g/d + NN-9B/C + NN-worker. |
| **I4** tokens fora de log | **PASS (WARN es-1)** | `logger.ts:151` (`redact()`); sink de traces (es-1) latente/inerte via egress. |
| **I5** JWT RS256+kid+TTL | **PASS (WARN)** | `auth-jwt-consumer.ts:93,145,96,162`. WARN `env.ts:78` `.max(900)` (default 300). |
| **I6** PII redaction | **PASS** | `logger.ts:57,151`; raw inbound nunca logado. Gaps PII-at-rest/response (#27). |
| **I7** soft-delete | **PARTIAL (defensável)** | `_shared.ts:103`; único hard-delete `templates/repository.ts:90` (espelho Meta); NN-9C `getTenant` vaza soft-deleted. |
| **I8** audit em mutação | **PARTIAL (FAIL na durabilidade)** | `audit-log.ts:60,82,50`; `lib/audit.ts:45`; `db/schema/audit.ts:8` (imutabilidade TODO). |
| **I9** HMAC webhooks | **PASS inbound / PARTIAL outbound** | Inbound `inbound/routes.ts:58` (constant-time antes do parse `:119-121`). Outbound `outbound-dispatcher.ts:50` não-assinado + 2 formatos. |
| **I10** multi-WABA | **PARTIAL** | `bindings.ts:138,57-58`; resolução sem `orderBy` (`wabas/repository.ts:88`). |
| **I11** transações ≥2 escritas | **PASS (WARN)** | `apps/repository.ts:35` (+ wabas/ig). WARN: envio grava `outbound_jobs` (`service.ts:203`) + `idempotency_records` (`idempotency.ts:136`) não-atômico. |

> Nenhuma invariante mudou de cor vs o baseline congelado.

---

## Parte F — LEDGER DE DECISÃO (o entregável para a revisão humana)

Inalterado em substância vs 10-21, com a correção de liveness da CRÍT-3 e o net-new #16. **Não repita este Ledger numa 11ª passada sem adjudicá-lo — ele não moveu um commit em 11 passadas e 135 dias.** A ação de amanhã deve ser **uma decisão por linha** (fix, ou aceite-de-risco explícito + mitigação), não mais achados.

| # | Item | Fix | Aceitar p/ piloto? | Risco residual se aceitar |
|---|------|-----|--------------------|---------------------------|
| **GOV-1** | 10 audits / 0 fixes / cadência diária | decisão + **pausar cron** | **N/A — decidir o processo** | Série vira ritual automático; recurso desperdiçado; postura degrada sozinha |
| **NN1** | shutdown invertido | ~15min | **NÃO — fechar já** (dispara todo deploy) | 500/reconexão espúria em cada rollout |
| ALTO-2 | N1 + NN-9a (crash API / zumbi worker) | ~1.5h | **Recomendo fix** | Worker-zumbi invisível (tok/cleanup/media) |
| ALTO-3 | NN3 workers sem probe | ~XS | **NÃO — fechar já** | Singleton travado sem restart, invisível |
| CRÍT-2 | es-1 | ~3-4h | **Só com o gate:** traces no Grafana? **Não**→aceitável (corrigir obs); **Sim**→**NÃO** | Secret do V1 + tokens a quem lê Grafana |
| CRÍT-1 | A5+A5b | ~6h | **LIVE p/ WABA onboarded** (MA-015 wired). Aceitar só com RPO + monitor de gap de `meta_event_id` | Inbound do cliente perdido em failover, invisível |
| CRÍT-3 | cross-app f/g/d | ~3h+testes | **LATENTE** (migração é greenfield). Aceitar com nota + **guard de connect-time antes de qualquer cenário multi-app no mesmo asset** | PII ao app errado; disconnect cross-app; tokens órfãos |
| #16 | MA-015 de-subscribe órfão | ~P-M | **Aceitável p/ piloto** (fechar antes do self-service onboarding) | Meta segue mandando inbound de WABA desconectada |
| ALTO-4 | N2/N4/NN5-inv (double-send outbound) | ~6-8h | **Aceitável com nota** se volume async baixo | Cliente recebe 2×; job preso; 500 pós-envio |
| ALTO-5 | I2 + NN1-inv (idempotência) | ~4-6h | **Aceitável** (1 consumer, key server-minted) | Double-send sob concorrência; replay cross-tenant se ≥2 tenants |
| ALTO-6 | NN-9A (admin sem idempotência) | ~2-3h | **Aceitável com nota** (admin confiável) | Rotate-key dobrado = 2 keys; replay dobrado |
| ALTO-7 | supply-chain + drop `@fastify/jwt` | ~1-2h + rebuild | **Trivial exceto pela imagem pinada — fechar** | CVEs alcançáveis acumulam sem patch |
| ALTO-8 | register phone | ~6h | **Só se o piloto NÃO onboardar número novo/migrado** — confirmar c/ produto | 1º envio a número novo falha |
| ALTO-9 | I8/N8 (audit) | ~5h | **Aceitável p/ piloto**, mas **pré-req de MA-012** | Trilha 5a incompleta/forjável |
| ALTO-10 | NN-9B/NN-9C (IDOR + soft-del via GET) | ~2h | **Aceitável** (defense-in-depth, 1 tenant), tripwire no 2º | Leitura cross-tenant dentro do app |
| ALTO-11 | HMAC outbound não-assinado | ~2h | **NÃO se o piloto usar `callback_url`** (viola I9) | Webhook sem HMAC / replayável / 2 formatos |
| ALTO-12 | Contrato §3f + guia | ~2h guia / ~2d canon | **Aceitável p/ piloto guide-first** se patchar o exemplo do guia + smoke | Onboarding-via-spec (GA) 100% quebrado |
| MÉDIO | NN4 (Redis eviction) | ~S | **Setar `noeviction` já** | writes falham em OOM; ou perda de job |
| MÉDIO | NN5 (retenção) | ~S-M | **Aceitável p/ piloto** (meses), fechar p/ GA | Crescimento ilimitado no volume 20Gi |
| CRÍT-4 | MA-012 (jurídico) | eng ~7h + jur ~24h | **Decisão jurídica.** Operação atual sob MSA; onboarding novo **NÃO** | Exposição regulatória; base legal minada |

**Mínimo defensável para o piloto continuar:** NN1 (~15min) + NN3 + N1/NN-9a (~2h) + NN4 `noeviction` (~15min) + supply-chain bump + drop `@fastify/jwt` (~1-2h + rebuild) + rodar o gate de es-1 (traces no Grafana?) + decisão de aceite-de-risco sobre A5/A5b e cross-app — **~4-6h de eng** + a decisão jurídica MA-012 + o gate diagnóstico. **GA** exige o resto + register-phone + E2E real contra Meta sandbox + convergência de contrato (canon→código) + supply-chain gate em CI.

---

## Itens-de-fechamento ordenados por valor/esforço (top 10)

| # | Item | Esforço | Destrava |
|---|------|---------|----------|
| 1 | **NN1** — inverter ordem de registro de hooks em `index.ts` (Fastify.close primeiro) | ~15min | Para o 500/reconexão espúria em **todo rollout** — melhor ROI |
| 2 | **NN3 + N1 + NN-9a** — `livenessProbe` nos 5 workers; `db/client.ts` loga em vez de `emit`; `initTelemetry()` nos workers | ~2h | Fecha o worker-zumbi invisível + crash em failover CNPG |
| 3 | **Supply chain** — bump `fastify`≥5.12.5 + `undici`≥8.10.2 + `fast-uri`≥3.1.5; drop `@fastify/jwt`; **gate `pnpm audit/test/lint` em CI** + Dependabot | ~2h + rebuild | Fecha altas alcançáveis + 2 críticas-mortas + a causa-raiz de governança |
| 4 | **NN4 + N11 + NN5** — Redis `--maxmemory`+`noeviction`+alerta; `commandTimeout`; cleanup de `webhook_deliveries` | ~2h | Fecha data-loss de fila, hang, crescimento ilimitado |
| 5 | **es-1** — SpanProcessor/hook que apaga `url.full`/`url.query` p/ hosts Meta + abrir :4318 no egress **junto** | ~4h | Fecha o CRÍTICO na origem **e** restaura observabilidade (MA-007) |
| 6 | **A5 + A5b** — `uniqueIndex` em `meta_event_id` + re-drive de deliveries + wrap do enqueue | ~6h | Bloqueador #1 de inbound (LIVE p/ WABA onboarded via MA-015) |
| 7 | **cross-app f/g/d + MA-015 de-subscribe** — `orderBy` determinístico + guard de connect-time + scope de app em `disconnectWabaByMetaWabaId` + `DELETE /subscribed_apps` no disconnect | ~4h + testes | Fecha PII-misdelivery (latente) + subscription órfã |
| 8 | **Idempotência atômica + fim do double-send + tenant na key + admin idempotente** | ~7h | Para double-send, replay cross-tenant, mutação admin não-idempotente |
| 9 | **Audit síncrono (I8) + NN-9B/NN-9C** — logAudit no service, validar `X-Tenant-Id`, scope de tenant em `findOutboundJob`, filtro `deletedAt` em `getTenant` | ~5h | Fecha trilha forjável (pré-req MA-012) + IDOR + soft-del leak |
| 10 | **Convergência de contrato (canon→código)** + patchar exemplo do guia + MA-012 + RoPa OT-19 | ~2d + jurídico | Desbloqueia onboarding-via-spec (GA) + go-live legal |

---

## Dependências cruzadas

- **es-1 / observabilidade** → `configmap.yaml:50` seta :4318; `networkpolicy.yaml:52-71` não permite egress em :4318. Gate: traces no Tempo/Grafana (exige SSH a prod). Scrub (es-1) e egress (obs) vão **juntos**.
- **MA-012 / DSR / durabilidade do audit (I8) / retenção (NN5)** → advogado externo + RoPa **OT-19** (ADR-019/020, committed no canon). Os gaps de eng **minam a base legal** de MA-012 §114.
- **Contrato (§3f, renomes, drift repo↔canon, guia)** → PRs em `bevox-knowledge` (SoT por ADR-005; §8 "Parar — PR"). Convergência é **canon→código** (código em prod/congelado). **Não mudar** `signing_secret`/`event_id`/formato HMAC `t=,v1=` sem coordenar com `bevox-backend`.
- **cross-app f/g/d + MA-015 de-subscribe** → o gatilho é **2 apps no mesmo asset Meta**, não a migração bevox-direct (greenfield+flag). Coordenar com a futura migração dos boxes embedded do V1 → meta-api (ver [[bevox-direct-migration-to-meta-api]], [[meta-app-bernardTavares-shared]]).
- **register-phone, ES/COEX, IG, MA-015 override** → dependem do Meta App compartilhado "Bevox Solutions" + Meta App Review + smoke/e2e contra sandbox. Webhook a nível de app aponta pro V1 → meta-api depende do override por-WABA (MA-015, wired).
- **A5/A5b, N1/NN-9a, NN1-NN4, audit, infra-4** → **compõem no mesmo gatilho** (blip de PG/Redis, rollout). A decisão de infra (single-node com RPO explícito **ou** réplica CNPG/Redis) é a de **maior alavancagem** — muda o *quando* de todos.
- **Supply chain (116 CVEs)** → sobe com o freeze; sem Dependabot/CI gate; imagem pinada bloqueia o patch.
- **MA-016 (analytics)** → bloqueia sub-projeto **Cleanup** da migração bevox-direct, não o piloto.

---

## Delta vs auditoria anterior (2026-07-22 → **2026-10-21** → 2026-10-22)

**Código:** BYTE-IDÊNTICO (src/db desde `dbe9fd6`; k8s desde `5516c2a`; **canon desde `0317985`/2026-06-02**). 1 dia e 1 commit (o audit 10-21) entre 10-21 e hoje.

- **FIXED: 0.** Nada fechou por engenharia (10ª consecutiva).
- **SURVIVES: todos.** 2 agentes independentes (invariants + tenant-scope) re-derivando do código com mandato de refutar: **0 refutado, 0 drift material, 0 net-new de invariante**. Placar das 11 idêntico. Re-verificação em 1ª mão do orquestrador nos anchors de maior severidade: 0 drift.
- **CORREÇÕES ao corpus (o delta honesto de hoje): 3.** (a) **CRÍT-3 liveness REBAIXADA** de "migration-gated-LIVE" para "LATENTE mecânico" — o spec de migração mostra bevox-direct greenfield + flag-dormante, logo a migração não abre sozinha a janela de overlap; o defeito segue confirmado e CRÍTICO, mas o gatilho é 2-apps-no-mesmo-asset, não a migração em curso. (b) **A5/A5b liveness SHARPENED** — MA-015 override **confirmado wired** → inbound roteado a `/webhooks/meta` p/ WABA onboarded → LIVE (não "latente até app dedicado"). (c) **CVE flat dia-a-dia** (116→116) — primeira medição que mostra o alvo estático até no eixo temporal em janela curta.
- **NET-NEW verificado: 1 operacional + 2 de doc.** #16 **MA-015 de-subscribe ausente** (subscription Meta órfã no disconnect); CLAUDE.md §2 ponteiro obsoleto p/ `docs/adr/` local; `docs/adr/README.md` índice stale (omite MA-013/14/15/16) + canon em branch não-merjado. **Nenhum net-new de invariante ou de correctness no request-path** (os probes céticos dos 2 agentes aterrissaram todos no corpus de 10-21).
- **ESCALADO: GOV-1.** A cadência virou **diária** (10-21 → 10-22), produzindo relatórios materialmente idênticos — o sintoma mais nítido de que o gargalo é 100% decisório. Recomendação net-new: **pausar o cron** além de adjudicar o Ledger.
- **Saldo:** a 10ª passada **prova** (não só afirma) que o alvo é estático em todas as camadas — código, k8s, canon, testes, lint, typecheck e até CVE (flat em 24h) — e que 2 equipes independentes de refutação não acham nada novo. O valor líquido é: **(1)** a prova temporal; **(2)** 3 correções honestas ao corpus (CRÍT-3 tempered, A5/A5b sharpened, CVE flat); **(3)** 1 net-new operacional (MA-015 órfão) + 2 de doc; **(4)** a escalada de GOV-1 com a recomendação concreta de pausar o loop. **A tese de 07-21/07-22/10-21 não só se mantém — ela agora é incontestável: não há mais o que descobrir sem descongelar; a decisão está atrasada.**

---

## Notas de método

**Calibração.** Reconheci o alvo congelado e a existência de 9 passadas prévias. Re-descoberta do zero tem valor marginal nulo (GOV-1 + prompt: "não invocar por inércia"). Foco em **(a)** ground-truth em 1ª mão, incluindo o **delta temporal do `pnpm audit`** (flat em 24h — o achado-chave de método); **(b)** re-verificação dos anchors de maior severidade nos bytes de hoje; **(c)** um fan-out **focado** (2 agentes, não 6) nos domínios sensíveis à migração em curso, com mandato de refutar + caçar net-new; **(d)** leitura de fontes que a missão pediu e que mudam a liveness (spec de migração bevox-direct; MA-015/016).

**Orquestração.** Fan-out via **Agent tool** (não Workflow), read-only: `invariants-auditor` (placar das 11 + re-confirmação + net-new) e `tenant-scope-auditor` (7 anchors cross-app + liveness da migração + net-new). Ambos retornaram **0 refutação, 0 drift, 0 net-new de invariante/scope** (net-new do tenant-scope mapeou p/ a classe NN-worker já catalogada). Os domínios es-1/secrets, HMAC in/out e contrato §3f foram re-verificados pelo **orquestrador em 1ª mão** (não delegados) para evitar repetir o fan-out de 6 agentes de ontem.

**Leitura direta [orq]** (HEAD 0b58e0d, Node v22.23.3): `index.ts` (NN1 ordem + ausência de uncaughtException), `shutdown.ts` (LIFO :50), `messages/schemas.ts` (§3f código + callback opcional + tenant no header), `openapi.yaml` (`MessageSendRequest` :1202-1233), `networkpolicy.yaml` + `configmap.yaml` (es-1 egress :4318), `k8s/` (manifestos), `docs/adr/README.md` + `MA-015` + `MA-016` (governança de ADR + wiring), `.github/workflows/build-image.yml` (CI build-only), canon git state (branch/merge), spec de migração bevox-direct (greenfield+flag), guia consumer canônico (`:145` trunc, `:267` 6-vs-8). Greps: `subscribeWabaApp`/`subscribed_apps` (MA-015 wired), `DELETE …subscribed_apps` (de-subscribe ausente), `@fastify/jwt` (morto), `register` (ausente). Executado: `pnpm typecheck` VERDE, `pnpm lint` VERMELHO (6), `pnpm test` **443/443**, `pnpm audit --prod` **116**.

**Limitações.** (a) **es-1/observabilidade + A5/A5b/cross-app liveness não confirmados em runtime** — sem acesso a prod nesta sessão autônoma. A análise estática (egress/NP, schema, spec) é prova forte, mas o cluster vivo + a contagem de WABAs onboarded/tenants por app **não são observáveis pelo código**. Gate diagnóstico (traces no Grafana; existe WABA onboarded? há overlap de asset?) exige SSH a prod — deixado p/ a revisão humana. (b) `test:integration`/`test:e2e` não re-executados (byte-idêntico; 07-20 rodou integração 9/9). (c) `repository.ts` segue 0% unit — scoping (I3) verificado por leitura estática. (d) Consumer guide + go-live-checklist não existem no repo (só no canon) — usei a versão canônica. (e) `pnpm audit` reflete o snapshot de advisories de hoje.

**Restrição respeitada:** nenhum arquivo de produto foi modificado — este relatório é o único artefato produzido.
