# Gap Analysis — bevox-meta-api — 2026-07-17

## Resumo executivo

Estado geral: **V1 em produção servindo `bevox-backend` (piloto MVP), com o código de produto BYTE-IDÊNTICO ao que a auditoria de 2026-07-04 examinou** — o único commit desde o baseline `5516c2a` é o próprio doc de auditoria (`560f748`); o working tree tem só 4 arquivos untracked não-produto. Consequência direta: **zero achados fecharam por engenharia nesta janela** e o corpus de 2026-07-04 (87 achados) foi **re-verificado independentemente por 5 auditores especializados — 37 achados de domínio re-confirmados, 0 refutados** — e **sobrevive intacto**. Os dois CRÍTICOS de piloto (A5, MA-012) continuam abertos, verificados em primeira mão no código.

O valor desta auditoria não é re-descobrir o que já foi mapeado (o alvo não mudou), e sim: **(1)** re-rodar o ground-truth (typecheck VERDE, lint **VERMELHO**, 443/443 testes VERDE, cobertura idêntica); **(2)** **resolver os 7 itens que a auditoria anterior deixou explicitamente em aberto** (confiança média, "a investigar") — com 2 correções ao relatório anterior no processo; **(3)** varrer superfícies sub-cobertas e produzir **10 achados NET-NEW verificados adversarialmente** (2 MÉDIO, 8 BAIXO), sendo o mais relevante uma **SSRF cega via URLs de saída controladas pelo consumer** e uma **perda silenciosa da própria trilha de auditoria em blip de Postgres** (mesma classe do A5, na camada de accountability).

Principais riscos para piloto/GA (inalterados na substância desde 07-04):
1. **A5 (CRÍTICO, código)** — dedup `SET NX` roda antes de persistir o `InboundEvent`; `meta_event_id` sem `uniqueIndex`; sem `del()` compensatório → **um blip de Postgres perde inbound para sempre, silenciosamente, com 200 OK à Meta**. Compõe com a camada de dados single-instance (infra-4). Bloqueador #1 do piloto.
2. **MA-012 (CRÍTICO, jurídico)** — postura LGPD "sub-processador interno" ainda `Status: Proposta` ("Bloqueia go-live"); não fecha por engenharia.
3. **Governança de qualidade ainda sem rede** — `pnpm lint` segue **exit 1** e não há gate de CI em PR (cov-3). O padrão que colocou ES/COEX em prod adiantando-se à governança persiste.

Delta vs 2026-07-04: **0 FIXED · ~todos SURVIVES · 10 NEW (verificados) · 2 correções ao relatório anterior · 2 candidatos NEW refutados.**

> **Nota de confiança.** Ground-truth executado pelo orquestrador (Node **v22.23.1**, HEAD `560f748`). Os 7 itens em aberto foram lidos **linha a linha** pelo orquestrador. O fan-out (5 auditores especializados do repo via `agentType` + crítico de completude → verify adversarial por candidato NET-NEW) rodou **18 agentes, 0 erros, ~1,13M tokens, ~14min**; os 12 candidatos NET-NEW passaram por cético instruído a refutar (**10 confirmados, 2 refutados**).

---

## Parte A — Ground-truth e o fato "código congelado"

Executado em Node **v22.23.1** (satisfaz o requisito Node 22; `undici@8` quebra em Node 20):

| Verificação | Resultado 2026-07-17 | vs 2026-07-04 |
|---|---|---|
| `pnpm typecheck` | **VERDE** (exit 0) | igual |
| `pnpm lint` | **VERMELHO** (exit 1) — `src/lib/queues.ts:174` (`import()` type annotation) + 4 snippets em `skills/bevox-meta-api-consumer/snippets/` = **5 problemas de produto** | **igual** (NEW-lint-1 sobrevive) |
| `pnpm exec vitest run --coverage` | **VERDE** — 45 arquivos, **443/443** | igual |
| Cobertura | **69.57% stmt / 61.5% branch / 60.88% func / 72.47% line** | **idêntica** |

- `git diff --name-only 5516c2a HEAD` = só `docs/audits/runtime-gap-audit-2026-07-04.md`. **Nenhuma linha de `src/`, `db/` ou `k8s/` mudou.**
- Sinais de cobertura persistentes: camada `repository.ts` ~**0%** (cov-2), `meta-client.ts` **47% stmt / 38% func** (cov-1), workers ~21% no nível de função.
- **Higiene [orq]:** o lint agora acusa um **6º** erro — `.claude/tmp-gap-audit-workflow.mjs:194` (`return` fora de função). É um **artefato untracked da sessão de auditoria de 2026-07-04** que ficou no repo (classe td-5). Não é problema de produto, mas suja o `pnpm lint` e deveria ser removido/gitignored.

**Pontos sólidos re-confirmados (não-achados):** I1 UUIDv7 (`db/schema/_shared.ts:73-76`); I5 JWT RS256+kid+TTL≤300s (`auth-jwt-consumer.ts:93-101,145,162`); I6 conteúdo de mensagem **é** redigido (`logger.ts:136-154`); I9 HMAC inbound constant-time (`inbound/routes.ts:55,58`) + outbound (`webhook-delivery.ts:74`); I10 multi-WABA (`bindings.ts:57-60`); I11 transações no persist; **MA-008 envelope encryption com AAD e `tokenBytes.fill(0)`** — e, correção deste ciclo, **BEM testado** (ver Parte C, item b); `GET /v1/jobs/:id` e `GET /v1/messages/:id` **são app-scoped** contra IDOR (`messages/routes.ts:83,101`).

---

## Parte B — Os 2 CRÍTICOS (bloqueiam piloto) — re-confirmados em primeira mão

**A5 — dedup `SET NX` antes de persistir o `InboundEvent`; `meta_event_id` sem `uniqueIndex`; sem `del()` compensatório → perda silenciosa e permanente de inbound em qualquer blip de Postgres** · SURVIVES · verify CONFIRMED · **[orq]**
- Ev.: `src/modules/inbound/service.ts:298` chama `isDuplicate()` (SET NX EX 24h, def. `:184-191`) **antes** de `insertInboundEvent()` em `:324`. Nenhum `del()` compensatório. `db/schema/operations.ts:98` usa `index("inbound_events_meta_event_id_idx")` — **não-único** — enquanto `uniqueIndex` **está importado e usado** logo acima (`:68`, `outbound_jobs`): a escolha é deliberada. Única migration é `0000_initial_schema.sql`. Logo o `SET NX` no Redis é o **único** dedup.
- Falha: insert lança (blip de DB/pool/failover CNPG) → 500 → Meta retenta → `isDuplicate` retorna `true` (chave já setada) → conta `deduplicated` → **200 OK** → evento **nunca persistido nem entregue**.
- Impacto: perda silenciosa de mensagem/status inbound a cada instabilidade de Postgres. **Compõe com infra-4** (CNPG `instances:1` + Redis `replicas:1`, sem HA — `k8s/cnpg-cluster.yaml:21`, `k8s/redis.yaml:18`). **Esforço: ~4h** (`uniqueIndex` em `meta_event_id`, tornando o INSERT o dedup atômico; ou confirmar a chave só pós-commit / `del()` no catch).

**MA-012 — postura LGPD "sub-processador interno" ainda `Status: Proposta` → bloqueia onboarding/produção** · SURVIVES · verify CONFIRMED · jurídico
- Ev.: `$BEVOX_KNOWLEDGE_PATH/30_adr/bevox-meta-api/MA-012-…:3` (`Status: Proposta`), `:7` ("Bloqueia: go-live de produção"), `:199-200` ("não promover a `Aceita` sem o documento em mãos"). RoPa **OT-19** nunca publicada.
- Impacto: todo PII tratado sob declaração unilateral sem parecer externo. Nuance: README posiciona `bevox-backend` como coberto por MSA — reduz risco operacional, não fecha a lacuna registral. **Esforço: ~24h jurídico.** Engenharia não fecha.

> **Nenhum CRÍTICO novo.** Os dois sobrevivem intactos desde 2026-06-02.

---

## Parte C — Resolução dos 7 itens que a auditoria de 2026-07-04 deixou em aberto

A auditoria anterior listou 7 itens do crítico-de-completude que **não passaram pelo verify adversarial** ("confiança média; a investigar"). O orquestrador leu cada um em primeira mão. Resultado — **2 correções ao relatório anterior**:

| # | Item em aberto (07-04) | Veredito | Evidência |
|---|---|---|---|
| a | Cache de auth aceita JWT com chave/app **revogados** por ≤5min | **CONFIRMED — MÉDIO** | `auth-jwt-consumer.ts:41` (`KEY_CACHE_TTL_SECONDS=300`), `:65` (cache PEM 300s), `:78` (`isAppActive` cache 60s). Sem deny-list de `jti`/`kid` no off-boarding → chave revogada honrada por até 5min, app desativado por até 60s. Mitigado por JWT ≤300s, mas é exatamente o controle de rotação/off-boarding que o cache derrota. |
| b | `crypto-envelope.ts` nunca testado quanto a tamper de AAD / reuso de nonce | **REFUTED — NÃO-GAP (correção)** | `tests/unit/lib/crypto-envelope.test.ts` cobre: AAD-swap anti-tenant (`:71-79`), auth_tag adulterado (`:81-88`), ciphertext adulterado (`:90-97`), dek_ciphertext adulterado (`:99-106`), nonce único + DEK regenerada por cifragem (`:59-68`), estabilidade de ordem de chaves (`:114-123`), algo desconhecido (`:125-129`). **A raiz de MA-008 está bem coberta; o crítico-de-completude de 07-04 errou aqui.** |
| c | Semântica de entrega SSE (`Last-Event-ID` / replay / perda entre desconexões) | **CONFIRMED — MÉDIO** | `events/routes.ts` só suporta replay via `?cursor=` (`:70`), **ignora o header `Last-Event-ID`** que clientes SSE mandam no reconnect → cliente que não rastreia o id manualmente **perde eventos entre desconexões**. Race: eventos que chegam entre o replay (`:77-86`) e o `subscriber.subscribe()` (`:90`) não caem nem no replay nem na subscription. Backpressure documentado (`:9`) mas **não aplicado**: `writeEvent` ignora o retorno de `reply.raw.write()` (`:64-67`) — confirma rlq-4. |
| d | Coreografia SIGTERM ↔ `/readyz` ↔ workers no rollout | **CONFIRMED — MÉDIO (novo bug de ordenação)** | `index.ts:28-33` registra hooks `[fastify, queues, event-bus, postgres, redis, telemetry]`; `shutdown.ts:50` roda **LIFO** → ordem real: telemetry → redis → postgres → event-bus → queues → **fastify por último**. Isso **inverte a própria docstring** de `shutdown.ts:3-9` ("1. Fastify.close() PRIMEIRO … 3. Postgres … 4. Redis"): **Postgres/Redis fecham ANTES do HTTP parar de aceitar** → requests na janela de drain batem em pool fechado → 500. Sem flag de readiness-drain: `/readyz` (`health/routes.ts:19`) nunca retorna 503 no shutdown para o k8s drenar endpoints antes do socket fechar. Blast radius mitigado no API por `replicas:2` (`deployment-api.yaml:22`), mas o defeito de ordenação é real e independente da contagem de réplicas. |
| e | Formato HMAC da fila de maior volume vs guia do consumidor | **CONFIRMED — MÉDIO** | **Dois formatos divergentes.** `webhook-delivery.ts:75` assina `x-bevox-signature: t=<ts>,v1=<hmac(ts.body)>` — **casa** o canon (`consumer-integration-guide-v1.md:246`). Mas `outbound-dispatcher.ts:52` (callback de status async) usa **header e formato diferentes**: `x-bevox-signature-256: sha256=<hmac(body)>` — sem timestamp, sem anti-replay — e **só assina `if (secret)` (`:50`)**, senão vai **não-assinado** (viola I9). Consumidor conforme o guia canônico não valida o callback de status. |
| f | `ADMIN_API_KEY` aceita 8 chars para assinar JWT admin HS256 | **CONFIRMED — BAIXO** | `env.ts:82` = `z.string().min(8)`; o bloco `superRefine` de produção (`:174-228`) **não reforça** o mínimo. Mitigado porque o valor real de prod é `openssl rand -hex 32` (runbook CLAUDE.md §11), mas o schema permite uma chave fraca/brute-forçável assinando JWT admin `aud=bevox-meta-api-admin`. |
| g | Pool/retry do `meta-client` (keep-alive? retry em ECONNRESET/5xx?) | **CONFIRMED — MÉDIO (overlap rlq-2/3)** | `meta-client.ts` usa `undici.request()` direto com `headersTimeout`/`bodyTimeout=10s` (`:274-275` etc.) e **sem retry client-level** (grep de retry/backoff/ECONNRESET = 0): um único blip de rede à Meta num envio **síncrono** (`POST /v1/messages`) falha de imediato (async é salvo pela retentativa do BullMQ). Sem Agent/Pool explícito → depende do keep-alive default do dispatcher global do undici. Overlap com rlq-2 (429 terminal) e rlq-3 (sem circuit breaker). |

---

## Parte D — Achados NET-NEW (verificados adversarialmente)

12 candidatos NET-NEW do fan-out; **10 confirmados** (2 MÉDIO, 8 BAIXO), **2 refutados**. Nenhum sobe a barra de CRÍTICO.

### NET-NEW confirmados

**MÉDIO**

1. **Trilha de auditoria é best-effort fire-and-forget → perda silenciosa do audit em blip de Postgres (I8 não garantido)** · verify CONFIRMED
   - Ev.: `src/plugins/audit-log.ts:82` dispara `void logAudit(...)` no hook **`onResponse`** (após a resposta já enviada); `src/lib/audit.ts:30-51` envolve o `insertAuditLog` em try/catch que **engole a falha** (`catch → logger().warn`, sem rethrow).
   - Impacto: sob um blip de Postgres, a **mutação retorna 200 ao consumidor mas nenhuma linha de audit persiste**, silenciosamente. Mesma classe de perda-silenciosa-em-blip-de-DB do **A5**, na camada de accountability. CLAUDE.md invariante 8 ("audit em TODA mutação") e §7 ("audit imutável por 5 anos", LGPD/MA-012) não ficam garantidos. Compõe com infra-4. As auditorias anteriores cobriram **imutabilidade** e **retenção** do audit, mas não a **durabilidade da escrita**. **Esforço: ~3h** (audit síncrono pré-resposta na transação da mutação, ou outbox durável).

2. **SSRF cega: URLs de saída controladas pelo consumer não validam destino** · verify CONFIRMED
   - Ev.: três sinks POSTam para URL fornecida pelo consumer sem checar que o destino não é interno: **(1)** verify-challenge no registro (`webhooks/service.ts:110`; schema só exige `z.url().startsWith("https://")` — `webhooks/schemas.ts:11`); **(2)** o worker de entrega POSTa o evento para `sub.url` (`webhook-delivery.ts:138` só checa `https://`); **(3)** o callback de status async POSTa para `callback_url` **sem nem checar o esquema** (`outbound-dispatcher.ts:56`) → aceita `http://`.
   - Impacto: consumer autenticado (ou JWT vazado) usa o pod `meta-api` — exposto em `meta-api.example.com` — como **pivot SSRF cego na rede interna k3s** (`kubernetes.default.svc`, Redis, Postgres, dashboards internos, e **metadata cloud via http** pelo `callback_url`). Threat model bounded no piloto (1 consumer confiável `bevox-backend`), mas é bloqueador de GA e defense-in-depth para um serviço interno que custodia tokens Meta. **Escala para maior severidade se a fronteira de confiança do consumer enfraquecer.** As auditorias anteriores flagraram a allowlist SSRF do download de **mídia** (Meta CDN), mas trataram a entrega **outbound** como "consumer confiável". **Esforço: ~4h** (allowlist de host / bloqueio de faixas privadas + link-local + `https`-only no callback).

**BAIXO** (higiene / defense-in-depth — todos com file:linha verificado)

3. **Callback de status async enviado NÃO-ASSINADO quando o job não carrega `callback_secret`** — `outbound-dispatcher.ts:50` (`if (secret)`), senão POST só com `content-type`. Viola I9 no caminho de callback. Distinto de (e) (que é o formato errado no caso assinado). **~1h.**
4. **`disconnectWabaByMetaWabaId` faz UPDATE cross-tenant sem `LIMIT`/scope no caminho PARTNER_REMOVED** — `wabas/repository.ts:194`: `UPDATE … WHERE eq(metaWabaId) AND isNull(disconnectedAt)`, sem `app_id`/`tenant_id` → em WABA compartilhada entre tenants (cenário coex-1, sem unicidade global) o PARTNER_REMOVED de um tenant faz soft-disconnect + supersede-tokens de **todos**. `const [row] = …returning()` (`:191`) loga só a 1ª row (não-determinístico). **~3h.**
5. **Label `route` das métricas cai para URL crua em rotas não-casadas → UUID de `tenant_id`/`message_id` no label + cardinalidade ilimitada** — `bootstrap/server.ts:155` (`req.routeOptions?.url ?? req.url…`) usado como label em `lib/metrics.ts:26,34`. Viola a regra §7.4 (proíbe `tenant_id` cru / `message_id` específico em label). Flood de 404 explode cardinalidade. **~1h.**
6. **`GET /metrics` servido mas ausente do contrato OpenAPI** — `health/routes.ts:26` vs `openapi.yaml` (só `/healthz:901`, `/readyz:924`). Mesma classe de `/webhooks/meta` e `/v1/media/:media_key` (drift residual). **~0.5h.**
7. **Respostas admin `apps` create/rotate emitem campos aditivos não documentados** — `apps/service.ts:32,36` (create retorna `key_id`, `updated_at`) e rotate (`:112-118`) além do rename `current_kid → current_public_key_id`, divergem do `ConsumerApp` em `openapi.yaml:1318-1328`. **~1h.**
8. **`downloadMedia` lê o corpo inteiro em memória sem cap de stream** — `meta-client.ts:750` (`Buffer.from(await res.body.arrayBuffer())`); o único guard é `media-download.ts:61` contra o `file_size` **auto-reportado** pela metadata da Meta. Se a metadata sub-reportar → alocação sem limite → OOM. Mitigado pela allowlist SSRF (host Meta) + `MEDIA_MAX_BYTES`. Ajustado de MÉDIO→BAIXO no verify. **~2h.**
9. **Idempotência chaveada só por `(app_id, key)`, sem discriminador de rota/método** — `idempotency.ts:98,136`; `hashBody(undefined|null)` = hash de `""` (`:53-56`), logo toda mutação de corpo-vazio tem hash idêntico. Reusar uma `Idempotency-Key` entre dois endpoints (ex.: `resync` e depois `DELETE`) devolve o 2xx cacheado do primeiro ou dispara 422 espúrio. **~2h.**
10. **`audit_logs.metadata.body` é over-redigido por inteiro para `"[REDACTED]"`** — `audit-log.ts:90-94` monta `{…, body: req.body}` e `audit.ts:32` aplica `redact()`; como a própria chave `body` está em `REDACT_KEY_NAMES` (`logger.ts:138`), a subárvore inteira do corpo vira `"[REDACTED]"`. A trilha de auditoria **perde "o que a mutação alterou"**. Não é vazamento (over-redaction é seguro), mas corrói o valor forense (LGPD/ANPD). **~2h** (allowlist seletiva no metadata do audit em vez de censura da chave inteira).

### NET-NEW refutados (não entram no corpus)

- **HMAC inbound usa `META_WEBHOOK_APP_SECRET` global único, sem modelo per-Meta-app** → **REFUTED**: o serviço opera sob **um** Meta App compartilhado ("Bevox Solutions"); o secret único é correto por design. Não é gap.
- **401 inbound distingue "Missing" vs "Invalid" `X-Hub-Signature-256` (oráculo)** → **REFUTED/ADJUSTED (não-real)**: distinção de mensagem sem canal de timing explorável; sem valor de oráculo prático.

### Correções ao relatório de 2026-07-04

- **(C-1) `crypto-envelope` — item (b):** o crítico-de-completude de 07-04 alegou "nunca testado quanto a tamper de AAD/nonce". **Errado** — `crypto-envelope.test.ts` cobre AAD-swap, tag/ct/dek tamper e unicidade de nonce (ver Parte C-b). MA-008 está bem coberto.
- **(C-2) E.164 em `audit_logs` — achado `e164-audit-outbound` (07-04):** o relatório modelou "`audit-log.ts` grava `req.body` via `redact()` mas não mascara `to` (E.164)". **Mecanismo corrigido:** como a chave `body` está em `REDACT_KEY_NAMES`, **o corpo inteiro vira `"[REDACTED]"`** — o `to` **NÃO** vaza em `audit_logs` (over-redaction, achado NET-NEW #10). O **risco líquido** de E.164 sem máscara persistido **permanece**, mas migra para **`outbound_jobs.payload_json`** (`messages/service.ts:177`, gravado cru para dispatch, retido 30d), não para `audit_logs`.

---

## Parte E — Corpus sobrevivente por severidade (re-verificado, 0 refutado)

Todo o corpus de 2026-07-04 foi re-verificado pelos 5 auditores especializados do repo (`invariants-auditor`, `webhook-hmac-auditor`, `tenant-scope-auditor`, `secrets-redaction-auditor`, `contract-guardian`) contra o código atual — **37 achados de domínio, todos CONFIRMED, 0 REFUTED**. Detalhe integral de cada um está em [`runtime-gap-audit-2026-07-04.md`](./runtime-gap-audit-2026-07-04.md); abaixo, o mapa agrupado do que **sobrevive** com a evidência-âncora re-conferida.

**Placar das 11 invariantes (CLAUDE.md §4):** PASS **I1, I5, I6, I9, I10, I11** · PARTIAL **I2** (rotas admin sem `Idempotency-Key` + read-then-write sem `SET NX`), **I3** (plugin `tenant-scope` inexistente; scoping por `app_id` é manual; lookups `findWabaByMetaWabaId`/`findWabaByTenantAndMetaId` não-escopados por app), **I4** (log/response/Sentry limpos, mas es-1 vaza via spans OTel), **I7** (templates hard-delete sem `deleted_at`), **I8** (callback GET não auditado + durabilidade best-effort — NET-NEW #1).

### ALTO (bloqueia GA, não bloqueia piloto) — sobrevivem
- **es-1** — `client_secret`/`access_token`/OAuth `code` vazam via auto-instrumentação undici do OpenTelemetry (`url.full` não redigido). `meta-client.ts:270` (`searchParams.set` de todo param), `:315` (`client_secret`), `:364` (`/debug_token`); `telemetry.ts:96-99` liga `getNodeAutoInstrumentations` (só `instrumentation-fs` off) → span com URL+query exportado a OTLP sem scrubber. **[orq re-confirmado]**. **~3h.**
- **Idempotência sem reserva atômica → envio DOBRADO ao cliente sob retry concorrente.** `idempotency.ts:98` read + `:136` write sem `SET NX`; `messages/service.ts` chama a Meta antes do insert; o unique index só barra o 2º insert. **[orq]**. **~4h.**
- **Ausência total de fluxo `register` de phone number (Cloud API).** `grep register|request_code|verify_code` em `phone-numbers/`/`meta-client.ts`/`wabas/service.ts` = 0. Escala a CRÍTICO se o piloto onboardar número net-new/migrado via ES puro. **~6h.**
- **hmac-a8** — dedup de Instagram desligado em prod (`inbound/service.ts:247` passa `value=undefined`). **~1.5h.** · **tenant-a10** — resolução inbound por `meta_waba_id`/`meta_ig_id` sem escopo app/tenant, `.limit(1)` sem `orderBy`. **~5h.**
- **rlq-2** — 429/throttle Meta vira `META_REJECTED` terminal no dispatcher → async perdido; sem `Retry-After`. **~4h.**
- **coex-1** — ES/COEX persiste WABA por `waba_id` do front sem unicidade global de `meta_waba_id` → WABA compartilhável entre tenants (compõe com tenant-a10 e NET-NEW #4). **~5h.**
- **cg-skill-1** — `skill bevox-meta-api-consumer` não conhece `connect/complete`/`config_id`/`coexistence`. **~3h.**
- **lgpd-a15-dsr** — sem endpoint DSR/erasure nem tabela `dsr_requests`; `listMediaKeys()` sem caller. **~8h.** · **lgpd-immutability** — imutabilidade de `audit_logs` é só comentário; sem REVOKE/RULE/TRIGGER. **~4h.**
- **tok-1** — envio Instagram lança `INTERNAL` 500 (resolver IG inexistente). **~8h.** · **tok-2** — tokens IG nunca renovados. **~6-8h.**
- **obs-1/obs-2/obs-3** — `metaRequestDuration`/`tokenRefreshTotal`/`queueSize` nunca observados → alertas e painéis cegos. · **infra-5** — sem alerta para workers críticos down.
- **cov-3 (sem gate de CI)** — único workflow é `build-image.yml` (push:main, nunca PR) → causa-raiz dos reds que chegaram a prod. **~4h.**
- **[NEW deste ciclo] SSRF outbound (Parte D #2)** — classificada aqui por ser bloqueador de GA.

### MÉDIO (degrada qualidade) — sobrevivem + itens resolvidos da Parte C
Superfície ES/COEX (es-2/es-3/es-4/es-5, coex-2/coex-3/coex-4, inv-es-1/inv-es-2, lgpd-coex-1, obs-4, tok-4/tok-5); tenancy defense-in-depth (tenant-a9/tenant-1/tenant-2/tenant-3); contrato/OpenAPI (**cg-collision-1** repo e canon ambos `1.2.0` mas forkados; **cg-1-callback-path** `/v1/oauth/waba/callback` real vs `/v1/tenants/{id}/wabas/connect/callback` no spec — **[orq re-confirmado via inventário de rotas]**; cg-residual-batch: `/webhooks/meta`, `/deactivate`, `/v1/media/:media_key` fora do spec); idempotência/soft-delete/secrets parciais (inv-i2-admin, inv-i7-templates, secrets-3/secrets-4, **E.164 em `outbound_jobs.payload_json`** — ver correção C-2); robustez inbound (inbound-NEW-1..4, hmac-ratelimit, `/webhooks/meta` sem rate-limit/allowlist); rlq-1/rlq-3/rlq-4; infra-2 (imagem tag mutável git-SHA `deployment-api.yaml:49` + `imagePullPolicy:Never`), infra-3 (`job-migrate` aponta para org+SHA divergentes: `ghcr.io/bevox/…migrator-5706afe` vs runtime `ghcr.io/bernardtavares/…dbe9fd6`), infra-4 (data layer single-instance), infra-6; hmac-callback-format/hmac-desub; lgpd-a21/a22/media/region.
**Resolvidos nesta auditoria (Parte C, MÉDIO):** cache de auth revogado ≤5min (a); semântica SSE + backpressure (c); ordenação de shutdown invertida + sem readiness-drain (d); formato HMAC do callback (e); retry/pool do meta-client (g). **NET-NEW MÉDIO:** durabilidade do audit (#1).

### BAIXO (higiene) — sobrevivem + NET-NEW
Prévios: NEW-lint-1 (**vivo**, `queues.ts:174`), hmac-verifytoken (`===` não constant-time), inv-i3-recon/inv-i4-a2, es-5, rlq-5, secrets-5, tok-4/tok-5, infra-7 (PDB p/ workers singleton `replicas:1`: token/cleanup/media), coex-4, td-1 (README diz "249 testes", real **443** — `README.md:9,78`), **td-2** (links quebrados: `docs/architecture/consumer-integration-guide-v1.md` e `docs/go-live-checklist.md` **ausentes no repo**, só no canon — **[orq confirmado]**), td-3, td-4, td-5, td-6, obs-5. **NET-NEW BAIXO:** Parte D #3–#10. **Resolvido (Parte C):** `ADMIN_API_KEY` min(8) (f).

---

## Itens-de-fechamento ordenados por valor/esforço (top 10)

| # | Item | Esforço | Destrava |
|---|------|---------|----------|
| 1 | **A5** — `uniqueIndex` em `meta_event_id` (INSERT vira dedup atômico) ou confirmar SETNX pós-commit / `del()` no catch | ~4h | **Bloqueador #1 do piloto**: perda silenciosa de inbound em blip de DB |
| 2 | **Gate de CI** (`typecheck`+`lint`+`test` em PR e push) — cov-3 | ~4h | Impede red/regressão chegar à imagem de prod |
| 3 | **Lint verde** (`queues.ts:174` + eslint dos snippets) + **remover `.claude/tmp-gap-audit-workflow.mjs`** untracked | ~1h | Desbloqueia o gate #2 (`pnpm lint` hoje = exit 1, agravado por artefato de auditoria) |
| 4 | **es-1** — tirar secret/code/token da query (POST body/header) + dropar `url.full`/`url.query` dos spans OTel | ~3h | Fecha vazamento de `client_secret`/token ao Tempo |
| 5 | **Idempotência com reserva `SET NX`** (fecha double-send **e** o NET-NEW #9 de namespace de chave) | ~4h | Para de mandar mensagem dobrada + colisão de key entre endpoints |
| 6 | **Fluxo `register` de phone number** para onboarding ES | ~6h | Desbloqueia o 1º envio no piloto p/ número novo/migrado |
| 7 | **Durabilidade do audit + SSRF outbound** (NET-NEW #1 e #2): audit síncrono na transação da mutação + allowlist de host nas 3 saídas | ~7h | Fecha perda silenciosa da trilha (LGPD) + pivot SSRF na rede interna |
| 8 | **hmac-a8** (1 linha no call-site IG + teste) + **rlq-2** (429→`RATE_LIMITED` retryable + `Retry-After`) | ~5.5h | Dedup IG real + para de dropar async em throttle |
| 9 | **Acender observabilidade** (`metaRequestDuration`/`tokenRefreshTotal`/`queueSize`) + de-subscribe no disconnect (hmac-desub) + **corrigir label `route`** (NET-NEW #5) | ~8h | 3 painéis/alertas deixam de ser cegos; sem subscriptions órfãs; sem PII/cardinalidade em métrica |
| 10 | **Carimbar MA-012 + RoPa OT-19** | jurídico ~24h | Bloqueio legal de onboarding de novos consumidores / GA |

> **Mínimo defensável para o piloto:** #1–#6 (~22h eng) + aceitar formalmente RPO/RTO de infra-4, **fora** de MA-012 (jurídico). **GA** exige #7–#10 + reconciliação de contrato (cg-*) + IG (tok-1/tok-2) + tenant-a10/tenant-scope + E2E (cov-4) + imutabilidade/retenção de audit.

---

## Dependências cruzadas

- **MA-012, lgpd-a15-dsr, lgpd-coex-1, lgpd-immutability, durabilidade-do-audit (#1), over-redaction-do-audit (#10)** → advogado externo + RoPa **OT-19** (canon; ADR-019/020). Não-código para a parte jurídica.
- **cg-collision-1, cg-1-callback-path, cg-residual-batch, `/metrics` fora do spec (#6), campos admin não-documentados (#7), cg-skill-1** → PRs em `bevox-knowledge` (SoT por ADR-005; CLAUDE.md §8 "Parar — PR"). Atualizar a `skill bevox-meta-api-consumer`.
- **Campos de contrato** (`current_kid`/`current_public_key_id`, `signing_secret`, `delivery_mode`) + **formato HMAC do callback (e)** → coordenar com **bevox-backend** (consumidor já provisionado) antes de mudar nomes/shapes ou o consumidor quebra a validação.
- **tok-1/tok-2 (IG)** → roadmap IG (`ig/token-resolver.ts`); refresh IG usa endpoint Meta distinto.
- **es-1 / label-route (#5)** → dependem de `OTEL_EXPORTER_OTLP_ENDPOINT` setado (MA-007 Grafana); confirmar config de prod.
- **register de phone number, ES/COEX, MA-015** → dependem do app compartilhado "Bevox Solutions" + Meta App Review; smoke/e2e contra Meta sandbox.
- **infra-4 (HA)** → decisão de infra (aceitar single-node ou réplica CNPG/Redis); **compõe com A5 e com a durabilidade do audit (#1)**.
- **MA-016 analytics** → `src/modules/analytics` **não existe** (ADR-only, `Proposta`); é gate do sub-projeto Cleanup de **bevox-direct**, não bloqueia o piloto do meta-api.

---

## Delta vs auditoria anterior (2026-07-04)

**Código:** BYTE-IDÊNTICO (só o doc de auditoria mudou desde `5516c2a`). Logo:

- **FIXED: 0.** Nada fechou por engenharia nesta janela. Os 3 reds do ciclo 06-04→07-04 seguem verdes (443/443 verificado), mas nenhum achado de 07-04 fechou.
- **SURVIVES: ~todos.** Re-verificação independente dos 5 auditores especializados: **37 achados de domínio CONFIRMED, 0 REFUTED.** Ground-truth idêntico (typecheck verde, lint vermelho 5 problemas de produto, 443 testes, cobertura 69.57%).
- **NEW: 10 (verificados adversarialmente)** — 2 MÉDIO (durabilidade do audit; SSRF outbound), 8 BAIXO (Parte D). 2 candidatos NEW **refutados** (HMAC single-env; oráculo 401).
- **CORREÇÕES ao relatório de 07-04: 2** — (C-1) `crypto-envelope` **é** bem testado (não-gap); (C-2) E.164 **não** vaza em `audit_logs` (over-redaction) — risco líquido migra para `outbound_jobs.payload_json`.
- **RESOLVIDOS (7 itens em aberto de 07-04):** a/c/d/e/f/g confirmados como achados reais (severidades na Parte C); b refutado (não-gap).

**Saldo:** o alvo não se moveu. Os dois CRÍTICOS de piloto (A5, MA-012) e o lint vermelho continuam abertos; a superfície ES/COEX segue sem ADR/skill/CI. O ganho líquido desta auditoria sobre a anterior é **fechar as 7 incógnitas** (com 2 correções) e **adicionar 10 achados verificados** — nenhum eleva o teto de severidade, mas dois (durabilidade do audit e SSRF outbound) tocam accountability LGPD e a fronteira de rede interna e merecem entrar no plano de GA.

---

## Notas de método

**Orquestração.** Diferente de 07-04 (fan-out de 52 agentes re-descobrindo do zero), esta auditoria calibrou para o fato de **código congelado**: re-descoberta redundante tem valor marginal baixo quando o alvo é idêntico e já foi exaustivamente coberto. O foco foi **verificação independente + net-new**. Fan-out via Workflow (ultracode): **5 auditores especializados do repo** (`invariants-auditor`, `webhook-hmac-auditor`, `tenant-scope-auditor`, `secrets-redaction-auditor`, `contract-guardian` via `agentType`) + **1 crítico de completude** → **verify adversarial** por candidato NET-NEW (cético instruído a refutar, default REFUTED). **18 agentes, 0 erros, ~1,13M tokens, ~14min.** O crítico declarou "nada net-new" em 8 áreas (jobs/messages scoping, admin auth, phone-numbers register, cleanup, entre outras — batendo com os spot-checks do orquestrador).

**Ground-truth [orq]** (Node **v22.23.1**, HEAD `560f748`): `pnpm typecheck` → VERDE; `pnpm lint` → VERMELHO (exit 1; `queues.ts:174` + 4 snippets = 5 problemas de produto, + 1 artefato de auditoria untracked); `vitest run --coverage` → VERDE (45 arquivos, **443/443**); cobertura **69.57% stmt / 61.5% branch / 60.88% func / 72.47% line**.

**Leitura direta [orq]** (não delegada) dos 7 itens em aberto + spine: `auth-jwt-consumer.ts`, `crypto-envelope.ts` + seu teste, `shutdown.ts`, `index.ts`, `events/routes.ts`, `env.ts`, `webhook-delivery.ts`, `outbound-dispatcher.ts`, `idempotency.ts`, `media-download.ts`, `health/routes.ts`, `meta-client.ts` (regiões de secret/retry), `inbound/service.ts` (A5), `db/schema/operations.ts` (índice `meta_event_id`), `messages/routes.ts` (scoping), `k8s/*` (réplicas/imagem/migrate), inventário completo de rotas vs OpenAPI, `README.md` (staleness/links), MA-012 no canon. **2 correções ao relatório de 07-04** vieram exatamente dessa leitura direta (valor do orquestrador ler o código vs. especular).

**Limitações.** (a) `test:integration`/`test:e2e` exigem Postgres+Redis em Docker e não foram executados (só `vitest run` unit) — a suíte E2E continua scaffolding (cov-4). (b) A camada `repository.ts` tem ~0% de cobertura (DB mockado): os predicados de scoping foram verificados por leitura estática das assinaturas + WHERE, não por execução. (c) ADRs MA-001..MA-014 **não existem no repo** (só `MA-015`/`MA-016` em `docs/adr/`); a rastreabilidade in-repo dos invariantes depende do canon (`$BEVOX_KNOWLEDGE_PATH=$BEVOX_KNOWLEDGE_PATH`). (d) O guia do consumidor referenciado pela missão (`docs/architecture/consumer-integration-guide-v1.md`) **não existe no repo** (td-2) — a comparação de HMAC usou a versão canônica (`20_architecture/bevox-meta-api/consumer-integration-guide-v1.md:246`).

**Restrição respeitada:** nenhum arquivo de produto foi modificado — este relatório é o único artefato produzido.
