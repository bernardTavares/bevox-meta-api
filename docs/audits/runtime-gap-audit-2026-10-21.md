# Gap Analysis — bevox-meta-api — 2026-10-21

## Resumo executivo

Estado geral: **V1 em produção servindo `bevox-backend` (piloto MVP Hetzner). Código de produto BYTE-IDÊNTICO desde `dbe9fd6` (2026-06-09) — freeze de 134 dias.** HEAD é `96b9194` (o próprio audit de 2026-07-22); `git diff dbe9fd6..HEAD -- src db` = **vazio**. Desde o freeze, o repo inteiro recebeu **7 commits: 6 `docs(audit):` + 1 `ops:`** (bump de manifesto k8s `5516c2a`, 2026-06-22, hoje com 121 dias). Esta é a **9ª auditoria consecutiva contra o mesmo alvo** e a **1ª em 91 dias** (nenhum commit no repo entre 07-22 e hoje). **Zero achados fecharam por engenharia em nenhuma das 9 passadas.**

O corpus foi re-derivado do código por **6 auditores independentes** (5 especializados do repo + 1 completeness-critic), cada um com mandato de **refutar** os anchors de maior severidade, + verificação em primeira mão do orquestrador (Node v22.23.3). **Nos CRÍTICO/ALTO da camada de dados: 0 anchor refutado, 0 drift de linha material.** As refutações desta passada são **correções do corpus**, não desaparecimento de risco (abaixo).

**O que esta passada (91 dias depois) faz que as 8 anteriores NÃO fizeram** (o valor marginal honesto):

1. **A postura de supply-chain quase DOBROU sozinha.** `pnpm audit --prod` hoje: **116 vulnerabilidades (2 críticas · 51 altas · 55 moderadas · 8 baixas)** vs **65 (1 crít · 26 altas)** em 2026-07-22 — **+51 totais, +25 altas, +1 crítica, com ZERO linha mudada**. Confirma a tese de 07-22 ("freeze não é neutro") de forma incontestável: a árvore travada acumula CVEs divulgadas *depois* do freeze. **Net-new alcançável e no request-path:** `fastify@5.8.5` (o próprio core — **auth bypass**, request/header-validation bypass, body replacement; patch ≥5.12.5) e `fast-uri@3.1.0` (**9 altas**: SSRF, host-confusion, path-traversal; patch ≥3.1.5) — ambos minam exatamente as invariantes §4. `undici@8.1.0` (cliente de TODA chamada Meta) agora pede patch **≥8.10.2** (era ≥8.5.0). As 2 críticas seguem sendo `fast-jwt` **MORTA** (`@fastify/jwt` no `package.json:44`, nunca importado) → removê-la zera as 2 críticas de graça.

2. **O "crash duro de worker" (NN2 de 07-22) é REFUTADO e substituído por algo pior — o "worker-zumbi silencioso".** Verificado empiricamente (Node v22.23.3): `process.emit("uncaughtException", err)` **sem listener retorna `false` e o processo SOBREVIVE** — o erro é **engolido em silêncio**. Logo `db/client.ts:52` (`pool.on('error')`) bifurca: API-com-Sentry → `process.exit(1)` (N1, crash); **5 workers + API-sem-DSN → swallow silencioso**. Nos workers (sem telemetria NN2, sem probe NN3, singletons `replicas:1`) isso é **outage total e invisível** da função (tok/cleanup/media), não crash-loop. Reframe material do cluster N1/NN2/NN3.

3. **A migração bevox-backend→bevox-direct torna a classe cross-APP (d/f/g) MIGRATION-GATED-LIVE.** O tenant-scope-auditor reposiciona os hazards de resolução por identificador Meta — `tenant-a10` (resolver `meta_waba_id`/`meta_ig_id` `.limit(1)` **sem orderBy** → PII inbound **entregue ao app/tenant ERRADO**), `F4` (phone unique GLOBAL), `disconnect` sem tenant/app — de "teóricos" para **vivos durante janelas de overlap de identificador Meta**, exatamente o que a migração dos consumer-apps provisionados (bevox-backend 2026-05-31, bevox-direct 2026-06-03) cria. **A classe mais grave de leak cross-tenant real é esta — e ela não depende do nº de tenants por app.**

4. **Reframe estrutural do I3 (tenant-scope-auditor): o plugin `tenant-scope` NUNCA EXISTIU.** Não há `src/plugins/tenant-scope.ts`; `server.ts:147` o rotula "futuro"; o JWT consumer **não parseia claim `tenant_id`** (tokens são **app-scoped apenas**). Consequência dupla: (a) a invariante §3 descreve máquina inexistente — todo scoping é manual por-repository, sem backstop; (b) o isolamento **cross-tenant-dentro-do-app NÃO é fronteira de segurança** (tenants não têm credencial própria), só defense-in-depth dentro do trust-boundary do próprio consumer. Isso **rebaixa** o "firehose de inbound" e o "findOutboundJob cross-tenant" de ALTO-externo para **defense-in-depth**, e **eleva** a necessidade de ADR para reconciliar §3/MA-003 com a realidade (`app_id` é a única fronteira dura — e está íntegra).

5. **Net-new de invariante na superfície admin: mutações admin NÃO carregam `Idempotency-Key`** (NN-9A). O plugin `throw` sem `req.auth` consumer, então `/admin/apps` create (`apps/routes.ts:24`), rotate-key (`:35`), deactivate (`:44`) e dead-letter replay (`webhooks/routes.ts:58`) **não aceitam idempotência** — double-submit de rotate-key gera 2 keys válidas; replay duplo re-entrega. Viola §4.2 (só health/ready/metrics isentos).

**Riscos materiais para piloto/GA (ordenados):**

1. **Classe "perda/corrupção/zumbi silencioso em blip de PG/Redis/rollout"** — **NN1 (shutdown invertido, dispara TODO deploy, ~15min, melhor ROI)** + **NN-9a (worker-zumbi invisível)** + A5/A5b (inbound perdido/sub-entregue) + N2/N4/NN5-inv/NN-9E (double-send Meta + 500-pós-envio no path outbound **VIVO** do piloto) + NN4 (Redis sem eviction → perda de job) — todos **compõem com infra-4** (CNPG `instances:1` + Redis `replicas:1` + 2 réplicas de API no mesmo node, sem HA física). O blip é *quando*, não *se*.
2. **es-1 (CRÍTICO no código, provavelmente INERTE em prod)** — secret do Meta App **compartilhado com o V1** + tokens de tenant → spans OTel em claro; mas a `NetworkPolicy` enforçada **bloqueia egress em :4318** (confirmado 2× nesta passada: "só 1 NetworkPolicy existe; 4318 nunca aparece em egress"). Corolário: **traces de prod provavelmente dropados** (MA-007 quebrado). Gate diagnóstico único: *os traces aparecem no Tempo/Grafana?*
3. **Cross-app PII misdelivery (f/g/d) migration-gated** — durante a migração bevox-direct, PII inbound pode ser persistida/entregue ao app errado, e `PARTNER_REMOVED` pode desconectar o consumer errado deixando tokens vivos.
4. **MA-012 (jurídico)** — `Status: Proposta`, **0/4 critérios de Aceita cumpridos**, DSR `POST /admin/dsr` não implementado. Bloqueia go-live formal e onboarding novo (operação atual coberta pelo MSA bevox-backend).
5. **Contrato publicado factualmente incorreto** — cliente gerado de QUALQUER dos dois OpenAPI **não envia nenhuma mensagem** (§3f → 400). Bloqueia onboarding-via-spec (GA), não o piloto guide-first — mas o **exemplo do guia está truncado** exatamente no ponto que quebra (armadilha do 1º send real).
6. **Governança sem rede** — `pnpm lint` vermelho (6, 1 real em `queues.ts:174`), **CI é build-only** (`build-image.yml` empurra imagem sem gate de test/lint/typecheck/audit), **sem Dependabot/Renovate**, e **116 CVEs sem monitor**. Imagem pinada `:dbe9fd6` `imagePullPolicy:Never` → **nenhum patch chega a prod sem descongelar**.

**Tese central (governança, não descoberta):** o alvo não se moveu por **134 dias e 9 auditorias**, mas **o custo de NÃO decidir compõe e agora é mensurável**: os CVEs alcançáveis quase dobraram, e a migração bevox-direct ativa uma classe cross-app de PII-misdelivery. **O gargalo não é descoberta — é decisão/ação.** A revisão humana de amanhã deve produzir **uma DECISÃO por item (fix, ou aceite-de-risco explícito com mitigação)**, não mais achados. A **Parte F (Ledger de Decisão)** é o entregável de maior valor. A alternativa honesta é explícita: **ou se descongela para o mínimo defensável (~4-6h eng + decisão jurídica), ou se encerra a série de auditorias e se registra aceite-de-risco formal** — uma 10ª passada idêntica tem valor marginal ~nulo.

> **Nota de confiança.** Ground-truth executado pelo orquestrador (Node **v22.23.3**, pnpm 9.15.1, HEAD `96b9194`). Fan-out via **Agent tool** (não Workflow), read-only, 6 agentes re-derivando do CÓDIGO (não do relatório anterior), default-cético, instruídos a **refutar** os anchors de maior severidade. Verificação em **primeira mão** do orquestrador: `index.ts`, `shutdown.ts`, `db/client.ts`, `telemetry.ts`, `idempotency.ts`, `inbound/routes.ts`, `inbound/service.ts` (estrutura), `networkpolicy.yaml`, `configmap.yaml`, `cleanup/repository.ts`, `.github/workflows/build-image.yml`, k8s HA (CNPG/Redis/PDB), MA-012 + ADR-020 (canon), guia consumer canônico (§3f), + `pnpm typecheck`/`lint`/`test`/`audit --prod` executados. Nenhum arquivo de produto foi modificado — este relatório é o único artefato.

---

## Parte A — Ground-truth (orquestrador, Node v22.23.3, HEAD 96b9194)

| Verificação | Resultado 2026-10-21 | vs 2026-07-22 |
|---|---|---|
| `git diff dbe9fd6..HEAD -- src db` | **vazio** (byte-idêntico) | igual |
| Commits no repo desde o freeze (dbe9fd6) | **7** (6 `docs(audit)` + 1 `ops` k8s) | +1 (este será o 7º audit-doc) |
| Commits desde o audit 07-22 | **0** (91 dias sem nada) | — |
| `pnpm typecheck` | **VERDE** (exit 0) | igual |
| `pnpm lint` | **VERMELHO** (exit 1) — 6 problemas: 1 real de produto (`src/lib/queues.ts:174`, `import()` type annotation) + 4 snippets em `skills/.../snippets/` (`parserOptions.project`) + 1 artefato untracked (`.claude/tmp-gap-audit-workflow.mjs:194`) | **igual** (byte-idêntico) |
| `pnpm test` (unit) | **443/443 VERDE** (45 arquivos, ~14s) | igual |
| `pnpm audit --prod` | **VERMELHO** (exit 1) — **116 vulns** (2 crít · 51 altas · 55 mod · 8 baixas) | **65 (1 crít · 26 altas)** → **+51** |
| Freeze de código | **134 dias** (`dbe9fd6` = 2026-06-09) | +91 dias |
| Freeze de k8s | **121 dias** (`5516c2a` = 2026-06-22) | +91 dias |

- **Cobertura unit não re-medida** (byte-idêntico; cito a série: ~69.57%/61.5%/60.88%/72.47%). `repository.ts` de **todos** os módulos segue **0% unit** — predicados de scoping (I3) verificados só por leitura estática.
- **`test:integration`/`test:e2e` não re-executados** (byte-idêntico; 07-20 rodou integração 9/9 em infra real). Nota: a memória do operador diz "290 testes passam" — **desatualizada**; a medição de hoje é **443** (o README diz "249", drift separado).
- Working tree: 4 untracked não-produto (o `.mjs` = o 6º erro de lint; `docs/superpowers/specs/…`; `scripts/check-meta-app.mjs`; `scripts/provision-bevox-direct-consumer.js`).

**Pontos sólidos re-confirmados em primeira mão (não-achados):** I1 UUIDv7 (`db/schema/_shared.ts:73`); **HMAC inbound constant-time ANTES do `JSON.parse`** (`inbound/routes.ts:58` `timingSafeEqual` + guard de length `:56`; parse só em `:119-121` depois do verify `:112-115`); MA-008 envelope KEK/DEK + zeroize (`token-resolver.ts`); **JWT via `jose` com algoritmo travado nos dois paths** (consumer RS256 `auth-jwt-consumer.ts:93,145`; admin HS256 via jose) — **imune às 2 críticas de `fast-jwt`**; config fail-fast no boot; **hardening de pod exemplar** (runAsNonRoot, readOnlyRootFilesystem, drop ALL caps) em API **e** workers; `secret.yaml` template limpo; Dockerfile non-root + `tini` + HEALTHCHECK; envelope de erro canônico Bevox (não-RFC7807, consistente spec↔código↔PRD §9.4); 1 migration, 16 tabelas íntegras; **nenhum campo de credencial Meta** (`access_token`/`app_secret`/`client_secret`) em response schema.

---

## Parte B — Os quatro reenquadramentos desta passada

### B1 · NN-9a — "worker-zumbi silencioso" substitui o "crash duro" (NN2 refutado)

07-22 afirmou que `pool.on('error')` num worker causaria **crash duro** (sem listener Sentry). **Refutado empiricamente** (Node v22.23.3): `process.emit("uncaughtException", err)` **sem listener retorna `false`; o processo sobrevive** — o erro é **engolido**. O path `db/client.ts:51-53` bifurca:
- **API com Sentry** (prod seta DSN) → a integração default do `@sentry/node` v10 captura e **termina o processo** (N1, como descrito). Drop de conexão idle (rotineiro em failover CNPG `instances:1`) derruba o pod.
- **5 workers (nunca chamam `initTelemetry()`) + API sem DSN** → **swallow silencioso**. No worker: pool morto, **sem crash, sem restart (NN3 — zero probes), sem telemetria (NN2)** = **zumbi invisível**. Nos singletons `replicas:1` (tok/cleanup/media) = **outage total e silencioso** daquela função, sem alerta.

Isto é **pior** que crash-loop (que ao menos o k8s reiniciaria). O cluster N1/NN2/NN3 reposiciona-se: a superfície worker é a mais frágil **e** a mais barata de fechar (NN1 ~15min; `initTelemetry()` nos workers + `livenessProbe` já pronto em `worker-metrics-server.ts:74`).

### B2 · Supply-chain quase dobrou — e as net-new são alcançáveis e no request-path

`pnpm audit --prod` @ HEAD: **116 vulns** (grafo de produção), vs 65 em 07-22. Delta **+51** com lockfile congelado. As net-new que importam (triadas por **alcançabilidade**, não por CVSS):

- **`fastify@5.8.5` (core) — ALTA, NOVA, request-path.** Auth bypass via URL malformada + request/header-validation bypass + body replacement. Ataca diretamente o pipeline que serve auth-jwt/idempotency/tenant-scope (as invariantes §4). Patch **≥5.12.5**. **Headline da passada.**
- **`fast-uri@3.1.0` — 9 ALTAS, NOVA.** SSRF, host-confusion, path-traversal; usado por fastify/ajv no parse de URI de **todo** request → alcançável. Patch **≥3.1.5**. Compõe com os sinks SSRF já conhecidos.
- **`undici@8.1.0` (direta, cliente de TODA chamada Meta + entrega outbound) — ALTA.** TLS cert validation bypass (MITM), WS DoS, cross-user disclosure, cross-origin routing. Patch **≥8.10.2** (era ≥8.5.0). Importado em `meta-client.ts:13`, `webhooks/service.ts:17`, `webhook-delivery.ts:20`, `outbound-dispatcher.ts:19`.

**REFUTADAS por alcançabilidade** (disciplina cética): `@fastify/static` (route-guard bypass — só via swagger-ui, que `openapi-docs.ts:20-22` **pula em `NODE_ENV=production`** → inerte em prod); `find-my-way` HTTP2 DDoS (fastify roda HTTP1); `@opentelemetry/*` prometheus-exporter crash (app usa OTLP push, egress bloqueia 4318); `joi`/`brace-expansion` (transitivos, baixa alcançabilidade). As 2 **críticas** (`fast-jwt`) permanecem **MORTAS** (dep não importada). `@grpc/grpc-js`+`protobufjs` (via `@google-cloud/kms`, hot-path de decrypt em prod) são altas de **baixa controlabilidade** (resposta confiável do Google).

**Trava estrutural:** lockfile congelado + imagem pinada `:dbe9fd6` `imagePullPolicy:Never` ⇒ nenhum patch chega a prod sem rebuild+re-import — que o freeze proíbe. **Um bump minor (fastify ≥5.12.5, undici ≥8.10.2, fast-uri ≥3.1.5) + drop do `@fastify/jwt`** limpa as 2 críticas e as altas mais expostas. Detalhe na Parte D.

### B3 · Cross-APP (d/f/g) é migration-gated-LIVE durante a migração bevox-direct

O tenant-scope-auditor separou dois eixos que 8 passadas misturavam:
- **cross-TENANT-dentro-do-app** (firehose de inbound, `findOutboundJob`): **defense-in-depth**, dentro do trust-boundary do consumer (tokens são app-scoped; tenants não têm credencial). Rebaixado de ALTO-externo.
- **cross-APP** (d/f/g): **a classe grave real.** Alcançada na camada de resolução por identificador Meta, que deriva `appId` **e** `tenantId` do payload inbound:
  - **f/tenant-a10 (C):** `findWabaByMetaWabaId` (`wabas/repository.ts:84-91`) e `findIgByMetaIgId` (`ig/repository.ts:60-67`) usam `.limit(1)` **sem orderBy**; consumidos em `inbound/service.ts:204,212` → se o mesmo `meta_waba_id`/`meta_ig_id` existir em ≥2 conexões, **PII inbound (conteúdo, contatos) é persistida E entregue ao app/tenant ERRADO, não-deterministicamente.**
  - **d/F4 (C):** `phone_numbers` unique só em `metaPhoneId` GLOBAL (`bindings.ts:111-113`); upsert (`phone-numbers/repository.ts:37-46`) não reescreve `wabaConnectionId` → número sob 2 apps mantém a WABA do app1 + vaza metadata app2→app1.
  - **g/NN2-tenant (C/H):** `disconnectWabaByMetaWabaId` (`wabas/repository.ts:187-203`) faz UPDATE por `meta_waba_id` **sem tenant/app/limit** → `PARTNER_REMOVED` desconecta **ambos** os apps; **corolário novo:** o supersede de tokens só atinge a row retornada → a **outra** conexão desconectada **mantém tokens vivos**.

**Liveness:** em regime estável a Meta normalmente proíbe a mesma WABA/número vivo em 2 conexões → LATENTE. **Mas a janela de migração bevox-backend→bevox-direct cria exatamente a sobreposição** de `meta_waba_id`/`meta_phone_id`/`meta_ig_id` que dispara d/f/g. **Sai de teórico para migration-gated-live.**

### B4 · es-1 — inalterado (código-CRÍTICO, prod-provável-INERTE), agora confirmado 2×

Cadeia CONFIRMADA em primeira mão + secrets-auditor (com evidência de `node_modules`):
- `telemetry.ts:86-104` ativa `NodeSDK` com `getNodeAutoInstrumentations` (só `instrumentation-fs` off → **undici ON**), **sem SpanProcessor nem hook de scrub**; `redactStringSecrets` roda **só** no `beforeSend` do Sentry (`:65`→`:166`), nunca em spans. `@opentelemetry/instrumentation-undici@0.25.0` (`undici.js:166-168`) grava `url.full`+`url.query` **sem redação**.
- Sinks: `meta-client.ts` GETs com `META_APP_SECRET`/`access_token`/`code` na query string (debug_token, exchangeCode, discovery/phone/template/COEX). POSTs usam header `Authorization` → **não** capturados.
- **Egress bloqueia:** `networkpolicy.yaml:52-71` permite egress só em DNS/53, 5432, 6379, **443** — **:4318 ausente**. Completeness-critic: "só 1 NetworkPolicy existe; 4318 aparece só no `configmap.yaml`, nunca em egress → **definitivo**". Logo os spans com secret **não saem do pod**.

Consequências (idênticas a 07-22, re-confirmadas): es-1 **provavelmente INERTE** em prod; **defeito de código continua CRÍTICO e latente** (1 edição de manifesto o torna vivo); **corolário: traces de prod provavelmente dropados** (observabilidade MA-007 quebrada). **Gate diagnóstico único (exige SSH a prod, fora do escopo autônomo):** *os traces aparecem no Tempo/Grafana?* Fix ~3-4h (SpanProcessor/hook que apaga `url.full`/`url.query` p/ hosts Meta) fecha na origem, **independente** do egress, e deve ir **junto** com a abertura de 4318.

---

## Parte C — Achados por severidade (cobre categorias a-l da missão)

### CRÍTICO (bloqueia conclusão do módulo / vivo-ou-iminente)

**GOV-1 · Programa: 9 auditorias, 134 dias de freeze, ZERO remediação — e o custo compõe** (cat. d/l) · **NET-NEW framing**
7 commits no repo desde o freeze (6 audit-docs + 1 k8s bump); 0 nos últimos 91 dias. Nenhum dos ~35 achados recorrentes fechou por engenharia. O Ledger de Decisão de 07-22 (declarado "o entregável de maior valor") **não moveu um commit**. Enquanto isso os CVEs alcançáveis quase dobraram (49→116) e a migração bevox-direct ativou a classe cross-app. **Impacto:** o módulo não "termina" por falta de descoberta — termina por falta de decisão. **Esforço:** 0h de descoberta; a ação é organizacional. **Recomendação:** adjudicar o Ledger (Parte F) item a item **amanhã**, ou registrar aceite-de-risco formal e **encerrar a série** (uma 10ª passada é redundante).

**CRÍT-1 · A5 + A5b — perda/sub-entrega silenciosa de inbound em blip de PG/Redis** (cat. a/h/i) · SURVIVES · CONFIRMED [orq 1ª mão]
`inbound/service.ts:298` chama `isDuplicate(metaEventId)` (SET NX EX 24h, `:184`) **antes** de `insertInboundEvent()` (`:324`); **nenhum `del()` compensatório** (grep vazio em `inbound/`). `processMetaWebhook` **não** está em try/catch (`inbound/routes.ts:129`). `operations.ts:98` usa `index()` **não-único** em `meta_event_id` enquanto `uniqueIndex` está importado (`:18`) e usado p/ outbound (`:68`) — o SET NX é o **único** dedup. **A5 (perda):** insert lança → 5xx → Meta retenta → `isDuplicate=true` → 200 → evento nunca persistido/entregue. **A5b (sub-entrega):** `listActiveSubscriptions` (`:388`) + loop `queue.add` (`:402`) **não** estão em try/catch (ao contrário do media-enqueue `:347` e `publishEvent` `:375`) → throw pós-insert → 5xx → dedup suprime reprocessamento. **Liveness:** o Meta App compartilhado "Bevox Solutions" roteia o webhook WhatsApp a nível de app pro **V1/chat.example.com**, não pro meta-api → **latente enquanto o inbound não for roteado à meta-api** (override por-WABA); **vivo para consumer de app dedicado**. **~6h** (uniqueIndex + re-drive de deliveries + wrap do enqueue).

**CRÍT-2 · es-1 — secret do Meta App (compartilhado com V1) + tokens → spans OTel** (cat. d/j) · SURVIVES · CONFIRMED-no-código, PROVÁVEL-INERTE-em-prod [secrets + completeness + orq]
Ver B4. Defeito de código CONFIRMADO (2 fontes); egress de prod **provavelmente bloqueia** (:4318 fora da allowlist, confirmado definitivo). Latente-crítico: 1 edição de manifesto o torna vivo. Gate: *traces no Tempo/Grafana?* Fix ~3-4h fecha na origem.

**CRÍT-3 · Cross-app PII misdelivery (f/g/d) — migration-gated-LIVE** (cat. a/i/j) · **ELEVADO** · CONFIRMED [tenant-scope]
Ver B3. `wabas/repository.ts:84-91,187-203`; `ig/repository.ts:60-67`; `bindings.ts:111-113`; `phone-numbers/repository.ts:37-46`; consumido em `inbound/service.ts:204,212,348`. PII inbound entregue ao app/tenant errado + disconnect cross-app + tokens órfãos vivos. **LIVE durante a janela de migração bevox-direct** (overlap de identificador Meta). **~3h + migration + testes de regressão.**

**CRÍT-4 · MA-012 — postura LGPD `Status: Proposta`, 0/4 critérios, DSR não implementado** (cat. e) · SURVIVES · [orq — canon]
`$BEVOX_KNOWLEDGE_PATH/30_adr/bevox-meta-api/MA-012-…:3` (`Proposta`), `:7` ("Bloqueia: go-live de produção"). Critério de Aceita (`:177-182`): parecer de advogado externo + RoPa OT-19 (ADR-019/020) + PRD §12 atualizado + carimbo `Aceita` — **nenhum dos 4 marcado**. DSR `POST /admin/dsr` (`:170-172`, "iteração 1.1") **não implementado** — existe só um helper de erasure-cascade não-wired (`media-storage.ts:86`, comentário). **Base legal (§114: "audit log, retenção, PII redaction — tudo já implementado") minada** por I8 (audit forjável/best-effort), es-1 (latente) e os gaps de retenção (abaixo). README: `bevox-backend` coberto pelo MSA → operação atual defensável; **onboarding novo bloqueado**. **Eng-prereqs ~7h + jurídico ~24h.**

> Nenhum CRÍTICO refutado. A5/es-1/MA-012 intactos; cross-app **elevado** por migration-liveness; GOV-1 é o novo framing dominante.

### ALTO (bloqueia GA; pilot-HIGH em blip de infra — decidir aceite)

1. **NN1 — ordem de shutdown INVERTIDA na API** (cat. h) · SURVIVES · CONFIRMED [orq 1ª mão + completeness] · **melhor ROI**
   `index.ts:28-33` registra `fastify→queues→event-bus→postgres→redis→telemetry`; `shutdown.ts:50` executa **LIFO** → `fastify.close()` roda **por ÚLTIMO**, depois de PG/Redis fechados (inverso do próprio docstring `shutdown.ts:4-9`). Requests na janela de drain: 500, **ou** re-init lazy do pool (`db/client.ts:64`) / Redis (`redis.ts:35`) — inclusive um **novo** `pool.on('error')` (compõe N1). **Dispara em TODO rollout.** Fix: inverter a ordem de registro. **~15min.**

2. **N1 + NN-9a — `pool.on('error')` → crash (API) ou zumbi-silencioso (worker)** (cat. h/d) · SURVIVES + **REFRAME · CONFIRMED [completeness + orq]**
   `db/client.ts:51-53`; **nenhum** `process.on("uncaughtException")` (grep: o único é o próprio emit). Ver B1. API-com-Sentry → `process.exit(1)`; workers → **zumbi invisível**. **~1h (N1: logar em vez de emit) + ~S (`initTelemetry()` nos workers).**

3. **NN3 — worker deployments sem probes k8s** (cat. g/h) · SURVIVES · CONFIRMED [completeness]
   `deployment-workers.yaml` (linhas 16/85/144/203/262) = **0 probes** nos 5 workers (API tem 3, `deployment-api.yaml:59-74`). `GET /healthz:9090` pronto (`worker-metrics-server.ts:74`) mas não-wired. Singletons `replicas:1` (`:150/:209/:272`) travados = outage silencioso. **~XS** (add `livenessProbe`).

4. **N2/N4/NN5-inv/NN-9E — ciclo de vida do job outbound: double-send Meta / job preso / 500-pós-envio** (cat. a/h/k/j) · SURVIVES · CONFIRMED [invariants + orq] · **path VIVO do piloto**
   `messages/service.ts:181` send Meta **antes** do `insertOutboundJob` (`:203`); worker bypassa o plugin HTTP (`outbound-dispatcher.ts`); `attempts:5` (`queues.ts:31`). Lost-ack/SIGKILL → **reenvio** (WhatsApp não deduplica). Insert pós-send colide no unique (`operations.ts:68`) → job `failed` **apesar de 2 msgs entregues** (NN-9E: `onConflictDoNothing` em `idempotency/repository.ts:46` mascara a corrida → observável = "2 envios Meta + um 500"). N4: `unsealOutboundJobSecrets` antes do try → unseal lança → row preso em `sending` p/ sempre → consumer poll infinito. **~6-8h o cluster.**

5. **I2 + NN1-inv — idempotência: corrida read-then-write (sync) + replay CROSS-TENANT** (cat. a/h) · SURVIVES · CONFIRMED [invariants + orq 1ª mão]
   `idempotency.ts:98` find e só em `onSend` (`:135`) save; **sem reserva in-flight** → dois concorrentes dão miss → **envio dobrado sync**. **NN1-inv:** identidade `(app_id, key)` (`:86`) + hash do `req.body` (`:97`); **tenant vive no header**, não no body → mesmo app+key+body+tenant diferente → tenant B recebe a resposta cacheada de A (`:101-112`) e o envio de B some. **LATENTE** (precisa ≥2 tenants/app). **NN5-inv:** resposta ≥300 não cacheada (`:127`) → retry re-atinge Meta. **~4-6h.**

6. **NN-9A — mutações admin NÃO carregam `Idempotency-Key`** (cat. a) · **NET-NEW · CONFIRMED [invariants]**
   Plugin `throw` sem `req.auth` consumer (`idempotency.ts:82-85`) → `/admin/apps` create (`apps/routes.ts:24`), rotate-key (`:35`), deactivate (`:44`), dead-letter replay (`webhooks/routes.ts:58`) **não aceitam idempotência**. Double-submit rotate-key → 2 keys válidas; replay duplo → re-entrega. Viola §4.2. **~2-3h.**

7. **undici ≥8.10.2 + fastify-core ≥5.12.5 + fast-uri ≥3.1.5 — CVEs ALCANÇÁVEIS no request-path** (cat. d/h) · **DELTA [pnpm audit + completeness]**
   Ver B2/Parte D. Bumps minor sem breaking (CLAUDE.md §8 "atualizar"). O fastify-core "auth bypass" é **novo** e ataca as invariantes §4. **~1-2h bump coordenado** (bloqueado pela imagem pinada `:dbe9fd6` `pullPolicy:Never` → exige rebuild).

8. **Ausência do fluxo `register` de phone number** (cat. a/g/h) · SURVIVES · CONFIRMED [orq 1ª mão + completeness]
   grep `register|request_code|verify_code|two_step` em `src/` = **0**; `meta-client.ts` sem método register. Número novo exige `POST /{phone_number_id}/register` (PIN 2FA) antes do 1º envio. **Escala a CRÍTICO se o piloto onboardar número novo/migrado via ES puro.** **~6h.**

9. **I8/N8/NN4-inv — durabilidade+integridade do audit (pré-req de MA-012)** (cat. e) · SURVIVES · CONFIRMED [invariants + orq]
   `audit-log.ts:60-61` lê `X-Tenant-Id` cru (**forjável**; `app_id :89` vem do JWT); `void logAudit` (`:82`) + `lib/audit.ts:45` catch que só `warn` → best-effort; só audita **2xx-3xx** (`:50`); `metadata.body` sempre `[REDACTED]`; create com `resourceId:null` (`:39-42`); imutabilidade de DB é **TODO** (`db/schema/audit.ts:8`). **NN4-inv:** `audit_logs.tenant_id` é FK (`audit.ts:28`) preenchida do header cru → UUID inexistente → FK violation → `logAudit` engole → **mutação não-auditada**. **~5h.**

10. **NN-9B / NN-9C — read IDOR cross-tenant + tenant soft-deleted via GET** (cat. a) · **NET-NEW · CONFIRMED [invariants + tenant-scope]**
    **NN-9B:** `findOutboundJob` escopa só `app_id` (`messages/repository.ts:48-55`); `GET /v1/jobs/:id` e `/v1/messages/:id` passam só `appId` (`routes.ts:83,101`) → portador do JWT do app lê job/msg de **qualquer** tenant do app. Defense-in-depth (dentro do trust-boundary do consumer), **vivo se ≥2 tenants/app**. **NN-9C:** `getTenant` (`tenants/service.ts:62-66`) → `findTenantById` (sem filtro `deletedAt`, `repository.ts:32-39`) retorna **200** com tenant deletado (update/list/delete filtram; getTenant é o furo). **~2h.**

11. **Outbound HMAC — callback async pode sair NÃO-ASSINADO + sem anti-replay + 2 esquemas incompatíveis** (cat. i) · SURVIVES · CONFIRMED [webhook-hmac]
    `deliverCallback` (`outbound-dispatcher.ts:48-53`): body-only, header `x-bevox-signature-256`, **sem timestamp**; `callback_url`/`callback_secret` opcionais sem `.refine()` (`messages/schemas.ts:55-56`) → `if (secret)` (`:50`) falha → **webhook sai NÃO-assinado** (viola diretamente I9 "sem HMAC = drop"). `webhook-delivery.ts:71-76` usa `t=,v1=` + `x-bevox-signature` + re-assina no retry → **consumer precisa de 2 verificadores**. LIVE no eixo outbound assim que qualquer consumer usar `callback_url`. **~2h** (alinhar `deliverCallback` ao `signPayload` canônico + `.refine()` url↔secret).

12. **Contrato §3f — OpenAPI publicado factualmente incorreto + armadilha do guia** (cat. b/f) · SURVIVES · CONFIRMED [contract-guardian]
    `openapi.yaml` (repo `:1202-1233`, canon `:1172-1210`) exige `channel/to/type` top-level + chaves por tipo (8 tipos) + `from_phone_number_id`; código (`messages/schemas.ts:28-41`) exige `from` + chave única **`content`** discriminada, só **text|template|image**. Cliente gerado de **qualquer** spec → **400 em todo send**. A **resposta** também diverge (NN-1 do contract-guardian). **Armadilha:** o único exemplo de send do guia canônico (`:145`) está **truncado** (`{channel,to,type:"template",...}`, sem `content`) → engenheiro completando o `...` cai no 400. Bloqueia onboarding-via-spec (GA), não o piloto guide-first. **Convergência: canon→código** (código em prod, congelado) = breaking-fix + bump major + ADR. **~2d.**

13. **SSRF outbound (oráculo de verify-on-create + callback http) — egress-mitigado a 443** (cat. g/h/i) · SURVIVES · CONFIRMED [webhook-hmac]
    Oráculo síncrono `undiciVerifier.verify` (`webhooks/service.ts:63`) ecoa `reason` ao caller (`:112-115`) → enumera rede interna **https-only** (schema `webhooks/schemas.ts:11`); `callback_url` aceita `http://` (`messages/schemas.ts:55`) → SSRF cega (erro só logado). **Nuance de egress:** NetworkPolicy só 443 → http/metadata bloqueado → blast radius menor. **Pilot: accept-with-note** (consumer same-org). **~4h.**

14. **NN-1 hmac — HMAC inbound + verify-token são um secret GLOBAL, não per-Meta-app** (cat. i) · SURVIVES · CONFIRMED [webhook-hmac]
    `verifySignature` lê `META_WEBHOOK_APP_SECRET` global (`inbound/routes.ts:46`; `env.ts:69`); verify-token idem (`:91`). **Não há** coluna `meta_apps.app_secret`. 2º Meta app = **webhooks 401**. **LATENTE** (os 2 consumer-apps provisionados são rows `consumer_apps`, não Meta Apps; o único Meta App roteia pro V1). **~1-2d.**

15. **rlq-2 + obs-1/2/3 — 429 Meta não retentado + métricas-chave cegas** (cat. k, MA-007) · SURVIVES · CONFIRMED [orq]
    `meta-client.ts:261` retenta só `status>=500||0` → **429 terminal** (async morre sem retry). Nenhum circuit breaker. `metaRequestDuration`/`tokenRefreshTotal`/`queueSize` = **0 call-sites** → alertas do PRD §13.4 cegos. **~3h.**

### MÉDIO (degrada qualidade)

16. **NN4 — Redis sem `maxmemory`/eviction (fila durável × cache efêmero na mesma instância)** (cat. h/j) · SURVIVES · CONFIRMED [completeness] · `redis.yaml:32-35` sem `--maxmemory`/`--maxmemory-policy`, limit 1Gi (`:54`); BullMQ 7d (`queues.ts:33`) + efêmeros juntos. `noeviction` → writes falham; `allkeys-lru` → **perda de job**. Staging idem (`docker-compose.prod.yml:42`). **~S** (`--maxmemory`+`noeviction`+alerta+separar DB index).

17. **es-1 corolário — traces de prod provavelmente dropados** (cat. k, MA-007) · SURVIVES · CONFIRMED [completeness] · egress :4318 bloqueado → OTLP não alcança collector → MA-007 silenciado. **~0.5h** (adicionar 4318 ao egress **junto** com o scrub de es-1 — nunca um sem o outro).

18. **NN5 — cleanup nunca poda `webhook_deliveries` nem `audit_logs` (retenção ADR-020)** (cat. e/h) · SURVIVES · CONFIRMED [completeness + orq] · `cleanup/repository.ts` poda só idempotency/`inbound_events`(90d)/`outbound_jobs`(30d). `webhook_deliveries` cresce **ilimitado** (bug agudo) no volume CNPG 20Gi; `audit_logs` cresce por design (5a) mas **sem hard-delete-após-5a** (ADR-020 `:40`) nem partição. DSR erasure não-wired. Sem alerta de disco PG. **~S-M.**

19. **N5/NN-9d — media OOM** (cat. h/j) · SURVIVES · CONFIRMED [completeness] · `meta-client.ts:750` `arrayBuffer()` sem cap; guard só por metadata `file_size` de chamada Meta separada (`media-download.ts:61`) × concurrency 10 × limit 512Mi. **~M.**

20. **N6/NN-9e — `readyz` não checa S3; superfície de readiness desalinhada do CVE** (cat. g/h) · SURVIVES · CONFIRMED [completeness] · `health.ts:108-113` = PG+Redis+KMS; S3 falha lazy → readyz verde com mídia quebrada. KMS gateado arrasta grpc/protobuf (altas) ao hot-path de decrypt. **~P.**

21. **N9 — `/webhooks/meta` sem override de bodyLimit 1MB** (cat. i/h) · SURVIVES · CONFIRMED [webhook-hmac + orq 1ª mão] · `server.ts:102` global 1MB, sem override na rota → batch Meta >1MB = **413 pré-HMAC** → Meta retenta idêntico → drop permanente. **~P.**

22. **N11 — Redis `enableOfflineQueue:true` sem `commandTimeout`** (cat. h) · SURVIVES · CONFIRMED [completeness] · `redis.ts:22` → comandos bufferam ilimitado em partição. **~P.**

23. **es-1 vetor secundário — redação incompleta (22 sinks `{err}`)** (cat. d/j) · SURVIVES · CONFIRMED [secrets] · `serializeErrorRedacted` **não** é `serializers.err` no root logger nem no Fastify nem nos **22 sinks** enumerados → token em `err.message` vazaria (latente). `redact()` casa lowercased-exato (`logger.ts:151`) — não cobre `accessToken`/`client_secret`/`app_secret`/`dek`/`system_user_access_token`. **~2h fecha tudo.** Net-new menores: NN-s1 (`scrubSentryEvent` não cobre `event.extra`/`contexts`), NN-s2 (`console.error` de boot `index.ts:48`).

24. **N1-secrets — label de rota 404 com cardinalidade ilimitada** (cat. k) · SURVIVES · CONFIRMED [secrets] · `server.ts:155` → `metrics.ts:26,34`: em rota 404 o pathname cru vira label Prometheus. **~0.5h** (clampar p/ `"unmatched"`).

25. **E.164 sem máscara em repouso + `error.details`/`from` cru na response** (cat. e) · SURVIVES · CONFIRMED [secrets] · `messages/service.ts:177/241` `redact(input.body)` mantém `to`/`from` em `outbound_jobs.payload_json` (30d); `error-handler.ts:69` ecoa `details` (hoje só escalares — `from`/`tenantId`, sem token). PII-at-rest/response, relevante a MA-012. **~0.5h.**

26. **NN-9b/NN-9c-completeness — staging workers "unhealthy" + dead_letter terminal-silencioso** (cat. h) · **NET-NEW [completeness]** · `Dockerfile:107` HEALTHCHECK `wget :3000` mas workers escutam `:9090` → todo worker "unhealthy" em staging. `webhook-delivery.ts:210-211` não re-throw no terminal + "emitir `webhook.dead_letter`" é **TODO** → eventos estacionados sem sinal proativo. **~P-M.**

27. **NN-worker-1/2 — UPDATE/SELECT sem `app_id` em tabelas que têm `app_id`** (cat. a) · **NET-NEW · CONFIRMED [tenant-scope]** · `messages/repository.ts:73,82`, `wabas/repository.ts:257`, `webhooks/repository.ts:137,169` (UPDATE `WHERE id`); `webhooks/repository.ts:20-27`, `inbound/repository.ts:39-42` (SELECT). Worker-only + admin-replay gated → defense-in-depth. O worker não reverifica `subscription.app_id == inbound_event.app_id` antes de entregar (compõe f). **~2h.**

### BAIXO (higiene)

28. **CVE crítico `fast-jwt` (2) — dep MORTA (remover `@fastify/jwt`)** (cat. d) · SURVIVES · [pnpm audit + orq] · `@fastify/jwt@10.0.0 > fast-jwt@6.2.2` (2 críticas: empty-HMAC bypass + incomplete-patch), mas **nunca importado** (`package.json:44`; grep `src/`=0; JWT via `jose`). **Não-alcançável.** Remover fecha as 2 críticas + reduz superfície. **~15min.**

29. **NN-9f-lint — `pnpm lint` exit 1** (`queues.ts:174` real + 4 snippets + `.mjs` untracked) · SURVIVES · **~1h** (+ remover o `.mjs`).

30. **NN7 — imagem `:dbe9fd6` `pullPolicy:Never` + Dockerfile embarca dev-deps** · SURVIVES · CONFIRMED [completeness] · `Dockerfile:96` runtime usa node_modules do stage `deps` (sem `--prod`) → vitest/testcontainers/drizzle-kit/eslint na imagem prod; stage `prod-deps` (`:33-42`) existe mas **não é usado**. **~M.**

31. **N10 — `@types/node@20` vs `engines>=22.19`; `@types/uuid@11` vs `uuid@14`** · SURVIVES · **~0.5h.**

32. **N12/N13 — cron re-tica no rollout + "3am UTC" falso; HPA só API; PDB ausente p/ tok/cleanup/media** (cat. g) · SURVIVES · CONFIRMED [completeness] · `cleanup.ts:71` boot+`setInterval 24h`; comentário "3am UTC" (`:9`) falso; `token-refresh.ts:172` boot+6h; `hpa.yaml` só API; `pdb.yaml` só api/out/in. **~2h.**

33. **Contrato — drift repo↔canon (mesmo `1.2.0`, conteúdos diferentes) + 5 renomes + handlers-fora-do-spec + `private_key_pem` em response (exceção não-marcada) + skill** (cat. b/f) · SURVIVES · CONFIRMED [contract-guardian] · Ver Parte C#12 + matriz do contract-guardian. `private_key_pem` em 201/rotate é **by-design** (chave RSA do próprio consumer, admin-only, MA-002) mas **trip a regra literal** → precisa sign-off humano documentado. `sync-contracts.sh` nunca fechou o loop. **~2d convergência.**

34. **F8/F7-SSE/JWT-clamp** — `hub.verify_token` `===` não-constant-time (`inbound/routes.ts:91`, M-baixo: handshake de setup, token estático); fan-out SSE ilimitado; `JWT_MAX_AGE_SECONDS.max(900)` (`env.ts:78`) vs I5 ≤300 (default 300, compliant). · SURVIVES menores.

35. **Doc-drift** — consumer guide + go-live-checklist **ausentes do repo** (`docs/architecture/` só tem `openapi.yaml`; README `:21,:63` linka path inexistente; vivem só no canon); README "249 testes" (`:9,:78`) vs **443**; guia "6 tentativas" (`:267`) vs `WEBHOOK_DELIVERY_MAX_RETRIES:8`; **MA-015 `Proposta` mas já em prod** (inversão de processo); **MA-016 (analytics) não-implementado** (bloqueia sub-projeto Cleanup do bevox-direct, não o piloto). · SURVIVES menores.

---

## Parte D — Varredura de CVE de dependências (delta: 65 → 116)

`pnpm audit --prod` @ HEAD `96b9194`: **116 vulns** (grafo de produção: **2 críticas · 51 altas · 55 moderadas · 8 baixas**), vs **65 (1 crít · 26 altas)** em 2026-07-22. **+51 totais, com lockfile congelado.**

| Sev | Pacote | Vetor | Alcançável? | Ação |
|---|---|---|---|---|
| **CRÍTICO ×2** | `fast-jwt@6.2.2` (via `@fastify/jwt`) | empty-HMAC auth bypass + incomplete-patch CVE-2026-34950 | **NÃO** — `@fastify/jwt` nunca importado; JWT via `jose` travado | **Remover `@fastify/jwt`** (dep morta) — zera as 2 críticas |
| **ALTO** | `undici@8.1.0` (direta) | TLS validation bypass; WS DoS; cross-user disclosure; cross-origin routing | **SIM** — cliente de toda chamada Meta + entrega outbound | **Bump ≥8.10.2** (minor) |
| **ALTO (NOVA)** | `fastify@5.8.5` (core) | **auth bypass**; request/header-validation bypass; body replacement | **SIM** — request-path; mina §4 | **Bump ≥5.12.5** — headline |
| **ALTO (NOVA, ×9)** | `fast-uri@3.1.0` (via fastify/ajv) | SSRF; host-confusion; path-traversal | **SIM** — parse de URI de todo request | **Bump ≥3.1.5** |
| ALTO | `@grpc/grpc-js@1.14.3` + `protobufjs` (via `@google-cloud/kms`, OTel) | DoS / code-injection / proto-pollution | **Baixa** — resposta confiável GCP | Bump transitivo (grpc ≥1.14.5) |
| — | `@fastify/static`, `find-my-way`, `@opentelemetry/*`, `joi`, `brace-expansion` | route-guard / HTTP2-DDoS / prom-exporter crash / ReDoS | **REFUTADAS** — swagger off em prod; HTTP1; OTLP push + egress block; transitivos | monitorar |

**Observações:**
- A dobra (49→116 no grafo prod) é **puro acúmulo temporal** — CVEs divulgadas depois do freeze de 2026-06-09. Valida "freeze não é neutro".
- **Trava:** imagem pinada `:dbe9fd6` `imagePullPolicy:Never` → patch **não** chega a prod sem rebuild+re-import (procedimento em `prod-deploy-procedure`).
- **Nenhum gate** (`pnpm audit` fora do CI; `build-image.yml` é **build-only**, sem test/lint/typecheck/audit; sem Dependabot/Renovate). O número **sobe sozinho**. Recomendação: `pnpm audit --prod --audit-level=high` + `pnpm typecheck`/`lint`/`test` em PR + Dependabot.

---

## Parte E — Placar das 11 invariantes (CLAUDE.md §4/§5) — byte-idêntico a 07-22

| Inv | Status | Evidência-âncora (HEAD 96b9194) |
|---|---|---|
| **I1** UUIDv7 | **PASS** | `db/schema/_shared.ts:73`; `uuid.ts:17`; zero serial/uuidv4. |
| **I2** Idempotência | **PARTIAL** (FAIL na garantia) | Header enforced no path consumer; corrida read-then-write (`idempotency.ts:98→135`) + Meta antes do insert (`messages/service.ts:181`) → double-send sync; **replay cross-tenant** (NN1-inv); **admin sem idempotência** (NN-9A). |
| **I3** app/tenant-scope | **PARTIAL / DRIFT** | Plugin `tenant-scope` **inexistente** (`server.ts:147` "futuro"; sem claim `tenant_id`); **`app_id` é fronteira dura e está íntegra**; `tenant_id` é defense-in-depth. Gaps cross-app (f/g/d) + NN-9B/NN-9C + NN-worker-1/2. |
| **I4** tokens fora de log | **PASS (WARN es-1)** | Núcleo sólido; **VIOLADO no sink de traces** (es-1, query→span) mas **egress bloqueia** (provável inerte). redact() key-list incompleta (latente). |
| **I5** JWT RS256+kid+TTL | **PASS (WARN)** | `auth-jwt-consumer.ts:93,145` (jose, RS256 travado, kid obrigatório). WARN: `env.ts:78` `.max(900)` (default 300). |
| **I6** PII redaction | **PASS** | `logger.ts:57,136` redige content/text/body; raw inbound nunca logado. Gaps em PII-at-rest/response (E.164, `error.details`). |
| **I7** soft-delete | **PARTIAL (defensável)** | `tenancy`/`bindings` têm soft-delete; `deleteTemplate` hard (`templates/repository.ts:84`) — espelho da Meta (atenuante). NN-9C: `getTenant` vaza soft-deleted. |
| **I8** audit em mutação | **PARTIAL** (FAIL na durabilidade) | Hook audita admin HTTP; mas tenant forjável, `void logAudit`+swallow, só 2xx-3xx, body `[REDACTED]`, create `resourceId:null`, imutabilidade TODO, CLI não audita, NN4-inv (FK forjável dropa audit). |
| **I9** HMAC webhooks | **PASS inbound / PARTIAL outbound** | Inbound constant-time antes do parse (`inbound/routes.ts:58,112-121`). Outbound: callback async pode sair **não-assinado** + sem anti-replay + 2 formatos (Parte C#11). |
| **I10** multi-WABA | **PARTIAL** | `bindings.ts:138` unique `(tenant_id, meta_ig_id)`; resolução sem orderBy (tenant-a10) + F4/F6. |
| **I11** transações ≥2 escritas | **PASS (WARN)** | Multi-row em `db.transaction()` (wabas/ig/apps). WARN: envio síncrono grava `outbound_jobs`+`idempotency_records` **não-atômico** (alimenta NN5-inv). |

> Nenhuma invariante virou verde→vermelho ou vermelho→verde vs o baseline congelado.

---

## Parte F — LEDGER DE DECISÃO (o entregável para a revisão humana)

Para cada item congelado, a **decisão** que amanhã precisa produzir. **Não repita o Ledger de 07-22 sem adjudicá-lo — ele não moveu um commit em 91 dias.**

| # | Item | Fix | Aceitar p/ piloto? | Risco residual se aceitar |
|---|------|-----|--------------------|---------------------------|
| **GOV-1** | **9 audits / 0 fixes / CVE dobrou** | decisão | **N/A — decidir o processo** | Série de audits vira ritual; postura degrada sozinha |
| **NN1** | **shutdown invertido** | ~15min | **NÃO — fechar já** (dispara todo deploy) | 500/reconexão espúria em cada rollout |
| ALTO-2 | **N1 + NN-9a** (crash API / zumbi worker) | ~1.5h | **Recomendo fix** (barato) | Worker-zumbi invisível (tok/cleanup/media) + crash em failover CNPG |
| ALTO-3 | **NN3** (workers sem probe) | ~XS | **NÃO — fechar já** | Singleton travado sem restart, invisível |
| CRÍT-2 | **es-1** | ~3-4h | **Só com o gate:** traces no Grafana? **Não** → aceitável (egress bloqueia; corrigir observabilidade). **Sim** → **NÃO** (secret do V1 vazando) | Exposição contínua de `META_APP_SECRET`+tokens a quem lê Grafana |
| CRÍT-1 | **A5+A5b** | ~6h | **Latente enquanto webhook aponta pro V1.** Aceitar só com RPO + monitor de gap de `meta_event_id` | Inbound do cliente perdido/não-entregue em failover, invisível |
| CRÍT-3 | **cross-app f/g/d** | ~3h+migration | **NÃO durante a janela de migração bevox-direct** | PII inbound entregue ao app errado; disconnect cross-app |
| ALTO-4 | **N2/N4/NN5-inv** (double-send outbound) | ~6-8h | **Aceitável com nota** se volume async baixo (path VIVO) | Cliente recebe 2×; job preso; 500 pós-envio |
| ALTO-5 | **I2 + NN1-inv** (idempotência) | ~4-6h | **Aceitável** (1 consumer, key server-minted) | Double-send sob concorrência; replay cross-tenant se ≥2 tenants |
| ALTO-6 | **NN-9A** (admin sem idempotência) | ~2-3h | **Aceitável com nota** (admin confiável) | Rotate-key dobrado = 2 keys; replay dobrado |
| ALTO-7 | **supply-chain** (undici/fastify/fast-uri + drop @fastify/jwt) | ~1-2h + rebuild | **Trivial exceto pela imagem pinada — fechar** | CVEs alcançáveis no request-path acumulam sem patch |
| ALTO-8 | **register phone** | ~6h | **Só se o piloto NÃO onboardar número novo/migrado.** Confirmar com produto | 1º envio a número novo falha |
| ALTO-9 | **I8/N8** (audit) | ~5h | **Aceitável p/ piloto**, mas **pré-req de MA-012** | Trilha 5a incompleta/forjável |
| ALTO-10 | **NN-9B/NN-9C** (IDOR read + soft-del via GET) | ~2h | **Aceitável** (defense-in-depth, 1 tenant), tripwire no 2º | Leitura cross-tenant dentro do app; tenant deletado via GET |
| ALTO-11 | **HMAC outbound não-assinado** | ~2h | **NÃO se o piloto usar `callback_url`** (viola I9) | Webhook sem HMAC / replayável / 2 formatos |
| ALTO-12 | **Contrato §3f + guia** | ~2h (guia) / ~2d (canon) | **Aceitável p/ piloto guide-first** **se** patchar o exemplo do guia + smoke | Onboarding-via-spec (GA) 100% quebrado |
| MÉDIO | **NN4** (Redis eviction) | ~S | **Setar `noeviction` já** | writes falham em OOM; ou perda de job se `allkeys-lru` |
| MÉDIO | **NN5** (retenção webhook_deliveries/audit) | ~S-M | **Aceitável p/ piloto** (meses), fechar p/ GA | Crescimento ilimitado no volume 20Gi; ADR-020 hard-delete ausente |
| CRÍT-4 | **MA-012** (jurídico) | eng ~7h + jurídico ~24h | **Decisão jurídica.** Operação atual sob MSA; onboarding novo **NÃO** | Exposição regulatória; base legal minada |

**Mínimo defensável para o piloto continuar:** **NN1** (~15min) + **NN3 + N1/NN-9a** (~2h) + **NN4 `noeviction`** (~15min) + **supply-chain bump + drop @fastify/jwt** (~1-2h + rebuild) + **rodar o gate de es-1** (traces no Grafana?) + **decisão de aceite-de-risco sobre A5/A5b e cross-app durante migração** — **~4-6h de engenharia** + a decisão jurídica MA-012 + o gate diagnóstico. **GA** exige o resto + register-phone + E2E real contra Meta sandbox + convergência de contrato (canon→código) + supply-chain gate em CI.

---

## Itens-de-fechamento ordenados por valor/esforço (top 10)

| # | Item | Esforço | Destrava |
|---|------|---------|----------|
| 1 | **NN1** — inverter ordem de registro de hooks em `index.ts` (Fastify.close primeiro) | ~15min | Para o 500/reconexão espúria em **todo rollout** — melhor ROI |
| 2 | **NN3 + N1 + NN-9a** — `livenessProbe` nos 5 workers; `db/client.ts` loga em vez de `process.emit`; `initTelemetry()` nos workers | ~2h | Fecha o worker-zumbi invisível + crash em failover CNPG |
| 3 | **Supply chain** — bump `fastify`≥5.12.5 + `undici`≥8.10.2 + `fast-uri`≥3.1.5; remover `@fastify/jwt`; **gate `pnpm audit/test/lint` em CI** + Dependabot | ~2h + rebuild | Fecha as altas alcançáveis + as 2 críticas-mortas + a causa-raiz de governança |
| 4 | **NN4 + N11 + NN5** — Redis `--maxmemory`+`noeviction`+alerta; `commandTimeout`; cleanup de `webhook_deliveries` | ~2h | Fecha data-loss de fila, hang de comando, crescimento ilimitado |
| 5 | **es-1** — SpanProcessor/hook undici que apaga `url.full`/`url.query` p/ hosts Meta + adicionar 4318 ao egress **junto** | ~4h | Fecha o CRÍTICO na origem **e** restaura observabilidade |
| 6 | **A5 + A5b** — `uniqueIndex` em `meta_event_id` **E** re-drive de deliveries no caminho de duplicata + wrap do enqueue | ~6h | Bloqueador #1 de inbound para consumer de app dedicado |
| 7 | **cross-app f/g/d** — `orderBy` determinístico + scope de app/tenant em `disconnectWabaByMetaWabaId` + não re-parentear phone no upsert | ~3h + testes | Fecha PII-misdelivery migration-gated-live (janela bevox-direct) |
| 8 | **Idempotência atômica + fim do double-send + tenant na key + admin idempotente (NN-9A)** | ~7h | Para double-send sync/async, replay cross-tenant e mutação admin não-idempotente |
| 9 | **Audit síncrono (I8) + NN-9B/NN-9C** — logAudit no service p/ admin, validar `X-Tenant-Id`, scope de tenant em `findOutboundJob`, filtro `deletedAt` em `getTenant` | ~5h | Fecha trilha forjável (pré-req MA-012) + IDOR read + soft-del leak |
| 10 | **Convergência de contrato (canon→código)** + patchar exemplo do guia + MA-012 + RoPa OT-19 | ~2d + jurídico | Desbloqueia onboarding-via-spec (GA) + go-live legal + fecha a armadilha do guia |

---

## Dependências cruzadas

- **es-1 / observabilidade** → `configmap.yaml:50` seta 4318; a `NetworkPolicy` (enforçada pelo k3s default) **não** permite egress em 4318. **Gate diagnóstico:** traces no Tempo/Grafana. O fix de scrub (es-1) e o de egress (observabilidade) vão **juntos**.
- **MA-012 / DSR / durabilidade+integridade do audit (I8/N8) / retenção (NN5)** → advogado externo + RoPa **OT-19** (ADR-019/020). Os gaps de engenharia **minam a base legal** declarada em MA-012 §114 — são pré-requisito registral.
- **Contrato (§3f, renomes, drift repo↔canon, skill, guia)** → PRs em `bevox-knowledge` (SoT por ADR-005; §8 "Parar — PR"). **Convergência é canon→código** (código em prod/congelado). **Não mudar** `signing_secret`/`event_id`/formato HMAC `t=,v1=` sem coordenar com `bevox-backend`.
- **cross-app f/g/d** → **depende da janela de migração bevox-backend→bevox-direct** (overlap de identificador Meta). Coordenar o fix com o cronograma da migração (ver [[bevox-direct-migration-to-meta-api]]).
- **register-phone, ES/COEX, IG, MA-015 override** → dependem do Meta App **compartilhado "Bevox Solutions"** + Meta App Review + smoke/e2e contra sandbox. Webhook a nível de app aponta pro V1 → meta-api depende de override por-WABA.
- **A5/A5b, N1/NN-9a, NN1-NN4, durabilidade do audit, infra-4** → **compõem no mesmo gatilho** (blip de PG/Redis, rollout). A decisão de infra (aceitar single-node com RPO explícito **ou** adicionar réplica CNPG/Redis) é a de **maior alavancagem** — muda o *quando* de todos.
- **Supply chain (116 CVEs)** → sobe com o freeze; sem Dependabot/CI gate; imagem pinada bloqueia o patch. `undici`/`fastify`/`fast-uri` são alcançáveis.
- **MA-016 (analytics)** → bloqueia sub-projeto **Cleanup** da migração bevox-direct, não o piloto.

---

## Delta vs auditoria anterior (2026-07-22)

**Código:** BYTE-IDÊNTICO (src/db desde `dbe9fd6`; k8s desde `5516c2a`). 91 dias e **0 commits** entre 07-22 e hoje.

- **FIXED: 0.** Nada fechou por engenharia (9ª consecutiva).
- **SURVIVES: ~todos.** 6ª+ equipe independente re-derivando do código: anchors CRÍTICO/ALTO resolvem na linha citada, **0 refutado, 0 drift material**. Placar das 11 invariantes idêntico.
- **CORREÇÕES ao corpus (delta honesto): 3.** (a) **NN2 "crash duro" REFUTADO** → substituído por **NN-9a "worker-zumbi silencioso"** (emit sem listener é engolido, verificado em Node v22.23.3) — pior e invisível; (b) **NN6 REFUTADO** (`resolveOtlpTracesUrl` mitiga a regressão em código; moot via egress); (c) **CVEs refutadas por alcançabilidade** (`@fastify/static` inerte com swagger-off em prod; `find-my-way` HTTP1).
- **REBALANCEAMENTOS:** **es-1** inalterado (código-CRÍTICO/prod-inerte), agora confirmado por 2 fontes; **cross-app (d/f/g) ELEVADO a CRÍTICO migration-gated-live** (tenant-scope-auditor); **firehose/findOutboundJob cross-tenant REBAIXADOS** a defense-in-depth (I3 reframe NN-I3: plugin tenant-scope nunca existiu, tokens app-scoped).
- **NET-NEW verificado:** **supply-chain 65→116** (+fastify-core auth-bypass, +fast-uri 9 altas — alcançáveis, request-path); **NN-9A** (admin sem idempotência); **NN-9B** (read IDOR cross-tenant); **NN-9C** (tenant soft-deleted via GET); **NN-9D** (hard-delete template); **NN-9E** (onConflictDoNothing mascara double-send); **NN-9F** (drift doc×código: `meta-api-modules.md` diz "Redis SET NX", mas idempotência de mutação é Postgres read-then-insert); **NN-worker-1/2** (UPDATE/SELECT sem app_id); net-new de infra (NN-9b staging unhealthy, NN-9c dead_letter silencioso); **GOV-1** (framing: 9 audits/0 fixes).
- **Saldo:** o alvo não se moveu por 134 dias e 9 auditorias. O ganho líquido desta é **(1)** a **dobra mensurável do supply-chain** (a 1ª evidência quantitativa da tese "freeze não é neutro" ao longo do tempo), com net-new alcançáveis (fastify-core, fast-uri); **(2)** o **reframe NN-9a** (worker-zumbi > crash); **(3)** a **elevação cross-app migration-gated-live** ligada à migração bevox-direct em curso; **(4)** o **reframe estrutural NN-I3** (tenant-scope nunca existiu → §3 descreve máquina inexistente) com rebaixamento honesto dos cross-tenant; **(5)** net-new de invariante na superfície admin (NN-9A/B/C); e **(6)** **GOV-1** — a constatação de que o gargalo é 100% decisório. **A tese de 07-21/07-22 não só se mantém — ela agora tem número: o custo de não decidir dobrou.**

---

## Notas de método

**Calibração.** Como em 07-17..07-22, esta passada reconheceu o **código congelado**: re-descoberta do zero tem valor marginal ~nulo. O foco foi **(a)** ground-truth em primeira mão **incluindo `pnpm audit --prod` (delta temporal)**; **(b)** 6ª+ verificação independente dos anchors de maior severidade **com mandato de refutar** — produzindo 3 correções reais ao corpus; **(c)** net-new dirigido a superfícies sub-cobertas (admin idempotency, reachability de CVE, liveness da migração); **(d)** síntese **decisória** (Ledger) + o framing GOV-1.

**Orquestração.** Fan-out via **Agent tool**, read-only, 6 agentes via `subagent_type` (`secrets-redaction-auditor`, `webhook-hmac-auditor`, `invariants-auditor`, `tenant-scope-auditor`, `contract-guardian`, `general-purpose` completeness-critic), cada um instruído a **re-derivar do CÓDIGO**, retornar CONFIRMED/DRIFTED/REFUTED com `file:linha` atual, tentar **refutar** os anchors, caçar net-new default-cético, e avaliar liveness (2º consumer-app). Verificação adversarial dos candidatos de maior severidade feita pelo **orquestrador via leitura direta** — não delegada.

**Leitura direta [orq]** (HEAD 96b9194, Node v22.23.3): `index.ts` (NN1 ordem), `shutdown.ts` (LIFO), `db/client.ts` (N1/re-init lazy), `telemetry.ts` (es-1 chain), `idempotency.ts` (I2/NN1-inv/NN5-inv), `inbound/routes.ts` (HMAC A4/N9) + `inbound/service.ts` (A5/A5b estrutura), `networkpolicy.yaml`+`configmap.yaml` (es-1 egress), `cleanup/repository.ts` (NN5/retenção), `.github/workflows/build-image.yml` (CI build-only), k8s HA (`cnpg-cluster.yaml:21` instances:1, `redis.yaml:18` replicas:1, `pdb.yaml`, `deployment-workers.yaml` singletons), MA-012 + ADR-020 (canon), guia consumer canônico §3f (`:145` truncado, `:267` 6-vs-8). Executado: `pnpm typecheck` VERDE, `pnpm lint` VERMELHO (6), `pnpm test` **443/443**, `pnpm audit --prod` **116 vulns**.

**Limitações.** (a) **es-1/observabilidade landing não confirmado em runtime** — sem acesso a prod nesta sessão; a análise egress/NP é prova estática forte (confirmada 2×) mas o cluster vivo pode ter regra out-of-band. O **gate diagnóstico** (traces no Tempo/Grafana?) exige SSH a prod — fora do escopo autônomo; deixado p/ a revisão humana. (b) `test:integration`/`test:e2e` não re-executados (byte-idêntico). (c) `repository.ts` segue 0% unit — scoping (I3) verificado por leitura estática. (d) **Contagem de tenants por consumer-app não é observável pelo código** — os achados cross-tenant ficam marcados LATENTE/VIVO-se-≥2-tenants, não resolvidos aqui. (e) Consumer guide + go-live-checklist **não existem no repo** (só no canon) — usou-se a versão canônica. (f) `pnpm audit` reflete o snapshot de advisories de hoje — o número sobe sozinho com o freeze.

**Restrição respeitada:** nenhum arquivo de produto foi modificado — este relatório é o único artefato produzido.
