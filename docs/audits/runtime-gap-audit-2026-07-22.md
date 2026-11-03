# Gap Analysis — bevox-meta-api — 2026-07-22

## Resumo executivo

Estado geral: **V1 em produção servindo `bevox-backend` (piloto MVP Hetzner). Código de produto BYTE-IDÊNTICO desde `dbe9fd6` (2026-06-09) — freeze de 43 dias.** HEAD é `03c1af6` (só docs de auditoria desde `5516c2a`); `git diff dbe9fd6..HEAD -- src db` = **vazio** (k8s teve o último toque em `5516c2a`, 2026-06-22, 30 dias). Esta é a **6ª auditoria consecutiva contra o mesmo alvo**. Como nas 5 anteriores, **zero achados fecharam por engenharia**; o corpus foi re-derivado do código por **6 auditores independentes** (5 especializados do repo + 1 completeness-critic) + verificação em primeira mão do orquestrador — **0 anchor refutado, 0 drift de linha** nos CRÍTICO/ALTO; o downgrade de A5 foi **re-refutado**.

**O que esta passada faz que as 5 anteriores NÃO fizeram** (o valor marginal):

1. **es-1 muda de "CRÍTICO-vivo-em-prod" (07-21) para "CRÍTICO-no-código, PROVAVELMENTE-INERTE-em-prod".** Cross-referência inédita: a `NetworkPolicy` (aplicada por runbook, enforçada pelo controlador default do k3s — o install `curl|sh` **não** passa `--disable-network-policy`) permite egress só em **53/443/5432/6379**. O collector OTLP está em **`:4318`** (`configmap.yaml:50`). **4318 não está na allowlist → egress bloqueado → os spans com secret não saem do pod.** Corolário net-new: **os traces de prod estão provavelmente sendo dropados no egress** (MA-007 quebrado; o "fix A18" que garantia traces está derrotado pela própria egress-policy). O defeito de código é real e latente; **basta 1 edição de manifesto** (adicionar 4318, o override de Secret NN6, ou subir o collector em 443) para virar vivo. Gate diagnóstico de 5 min afiado: **os traces aparecem no Tempo/Grafana?** Se sim → egress aberto → es-1 vivo; se não → es-1 inerte **e** observabilidade quebrada.
2. **Primeira varredura de CVE de dependências da série** (`pnpm audit`): **65 vulnerabilidades** (grafo de produção: **1 crítica, 26 altas, 20 moderadas, 2 baixas**). A crítica (`fast-jwt` — bypass de auth por HMAC-secret-vazio) **NÃO é alcançável** (o pacote `@fastify/jwt` está no `package.json` mas **nunca é importado**; ambos os paths JWT usam `jose` com algoritmo travado) → vira item de higiene (remover dep morta). As reais são `undici@8.1.0` (bypass de validação TLS — cliente de **toda** chamada Meta) e `@hapi/wreck` (leak de header de credencial em redirect, no path OAuth). **Tese net-new: freeze não é neutro — a postura degrada** enquanto o código fica idêntico (a árvore travada acumula CVEs; muitas divulgadas *depois* do freeze), e **não há gate de CI/Dependabot/`pnpm audit`**.
3. **Cluster net-new de fragilidade worker/infra** (completeness-critic): **NN1 — ordem de shutdown INVERTIDA na API** (LIFO → Fastify fecha por ÚLTIMO, depois de PG/Redis; dispara em **todo rollout**; fix ~15min, melhor ROI da auditoria), **NN2 — workers sem Sentry/OTel** (amplifica N1 a crash duro), **NN3 — workers sem probes k8s** (singleton travado = outage silencioso), **NN4 — Redis sem `maxmemory`/eviction** (noeviction→writes falham; allkeys-lru→**perda de jobs BullMQ**). Compõem com o cluster N1-N4 de 07-20/07-21.
4. **Achados net-new de tenancy/idempotência**: **replay cross-tenant de idempotência** (identidade `(app_id, key)` ignora o tenant do header → tenant B recebe a resposta cacheada de A e o envio de B some), **firehose de inbound sem isolamento de tenant** (omitir `X-Tenant-Id` retorna eventos de **todos** os tenants do app), **audit dropado silenciosamente por FK de header forjável**.
5. **Correções ao corpus** (delta honesto): **N8 é mais fraco do que 07-21 pintou** — o path admin **canônico** de prod é HTTP `POST /admin/apps` (CLAUDE.md §11 + gotcha §1.8 do go-live marcam o `pnpm cli` como quebrado), e o hook de audit **audita** mutações admin HTTP (`audit-log.ts:31-34,65-67`); o path sem trilha é o CLI (desencorajado). **es-1 escopo:** workers **não** iniciam OTel → só GETs do processo API são sinks. **Labels de métrica:** a correção "rule-compliant" de 07-21 vale para rotas **casadas**; o path **404** (`server.ts:155`) vaza o pathname cru como label (cardinalidade ilimitada).

**Riscos para piloto/GA (ordenados):**

1. **Classe "perda/corrupção silenciosa + crash em blip de Postgres/Redis/rollout"** — **NN1 (shutdown invertido, dispara todo deploy)** + A5/A5b (inbound perdido/sub-entregue) + N1/N2/N3/N4 (crash-loop, double-send, job preso) + NN2 (workers cegos ao Sentry) + NN3 (workers sem probe) + NN4 (Redis sem eviction → perda de job). Todos **compõem com infra-4** (CNPG `instances:1` + Redis `replicas:1`, sem HA física — as 2 réplicas de API no mesmo node) → o blip é *quando*, não *se*.
2. **es-1 (CRÍTICO no código, provavelmente inerte em prod)** — o secret do Meta App **`<META_APP_ID>` ("Bevox Solutions", compartilhado com o V1)** + tokens de tenant vão a span OTel em claro; **provavelmente bloqueado no egress hoje**, mas latente. Gate diagnóstico acima. Fix ~3-4h.
3. **MA-012 (jurídico)** — `Status: Proposta`, bloqueia go-live/onboarding. Não fecha por engenharia. **A base legal declarada (MA-012 §114 "audit log, retenção, PII redaction — tudo já implementado") é minada** pelos gaps I8/N8/es-1/redação — esses pré-requisitos de engenharia devem avançar antes do carimbo.
4. **Governança sem rede + supply-chain à deriva** — `pnpm lint` = exit 1 (6 problemas idênticos aos de 07-19/20/21), **sem gate de CI em PR**, e agora **65 CVEs sem monitoramento**. Congelado através de 6 auditorias.

**Tese central (governança, não descoberta):** o alvo não se moveu por 43 dias e 6 auditorias, mas **o custo de NÃO decidir compõe**: a árvore de dependências acumula CVEs e cada evento de ops rotineiro (deploy, failover CNPG, blip Redis) bate no mesmo cluster de fragilidade worker/infra que cresce com o volume do piloto. **A revisão humana de amanhã deve produzir uma DECISÃO por item — fix, ou aceite-de-risco explícito com mitigação — não mais achados.** A **Parte F (Ledger de Decisão)** é o entregável de maior valor.

> **Nota de confiança.** Ground-truth executado pelo orquestrador (Node **v22.23.1**, HEAD `03c1af6`). Fan-out via **Agent tool** (não Workflow), read-only, 6 agentes re-derivando do CÓDIGO (não do relatório anterior), default-cético, instruídos a **refutar** os anchors de maior severidade: `secrets-redaction-auditor`, `webhook-hmac-auditor`, `invariants-auditor`, `tenant-scope-auditor`, `contract-guardian`, + 1 `general-purpose` completeness-critic (workers/lib/config/k8s/Dockerfile). Leitura em **primeira mão** do orquestrador: `telemetry.ts` (íntegro), `auth-jwt-consumer.ts`, `auth-admin.ts`, `audit-log.ts`, `apps/routes.ts`, `k8s/*` (configmap/secret/networkpolicy/pdb/deployment-api/deployment-workers/observability), `Dockerfile`, MA-012 + ADR-020 (canon), go-live plan §0-§1, runtime-topology (canon), + `pnpm audit`/`pnpm test`/`pnpm typecheck`/`pnpm lint` executados. Nenhum arquivo de produto foi modificado.

---

## Parte A — Ground-truth (orquestrador, Node v22.23.1, HEAD 03c1af6)

| Verificação | Resultado 2026-07-22 | vs 2026-07-21 |
|---|---|---|
| `git diff dbe9fd6..HEAD -- src db` | **vazio** (byte-idêntico) | igual |
| `pnpm typecheck` | **VERDE** (exit 0) | igual |
| `pnpm lint` | **VERMELHO** (exit 1) — `src/lib/queues.ts:174` (`import()` type annotation, único de produto) + 4 snippets em `skills/bevox-meta-api-consumer/snippets/` (`parserOptions.project`) + `.claude/tmp-gap-audit-workflow.mjs:194` (**artefato de auditoria untracked**, não-produto) = **6 problemas** | **igual** (byte-idêntico) |
| `pnpm test` (unit) | **443/443 VERDE** (45 arquivos, run limpo isolado, sem flake; 16.1s) | igual |
| `pnpm audit` | **VERMELHO** (exit 1) — **65 vulns** (grafo prod: 1 crítica, 26 altas, 20 mod, 2 baixas) | **NET-NEW (nunca rodado antes)** |
| Freeze | **43 dias** (`dbe9fd6` = 2026-06-09); k8s 30 dias (`5516c2a`) | +1 dia |

- **Cobertura unit não re-medida** (código byte-idêntico; cito 07-20: ~69.57%/61.5%/60.88%/72.47%). `repository.ts` de **todos** os 12 módulos segue **0% unit** — predicados de scoping (I3) verificados só por leitura estática.
- **`test:integration`/`test:e2e` não re-executados** (byte-idêntico; 07-20 rodou integração 9/9 em infra real).
- Working tree: 4 untracked não-produto (`.claude/tmp-gap-audit-workflow.mjs` = o 6º erro de lint; `docs/superpowers/specs/…`; `scripts/check-meta-app.mjs`; `scripts/provision-bevox-direct-consumer.js`). **Os dois scripts não têm secret hardcoded** (leem `META_*`/`ADMIN_API_KEY` do env); `provision-bevox-direct-consumer.js` minta um JWT admin HS256 e imprime o `private_key_pem` uma vez em `/tmp/bevox-direct-app.json` (nota de higiene op: esse arquivo `/tmp` carrega uma chave privada).

**Pontos sólidos re-confirmados em primeira mão (não-achados):** I1 UUIDv7 (`db/schema/_shared.ts:73`); HMAC inbound constant-time **antes** do `JSON.parse` (`inbound/routes.ts:73-78,108-121` + `timingSafeEqual :58`, A4 anti-DoS sólido); MA-008 envelope KEK/DEK; **JWT via `jose` com algoritmo travado nos dois paths** (consumer RS256 `auth-jwt-consumer.ts:93,144`; admin HS256 `auth-admin.ts:52-53`) — **imune ao CVE crítico de `fast-jwt`**; config fail-fast no boot (`env.ts` superRefine: KMS local proibido em prod, TLS obrigatório no S3); **hardening de pod exemplar** (`runAsNonRoot`, `readOnlyRootFilesystem`, `drop ALL caps`, `allowPrivilegeEscalation:false`, uid 1001) em API **e** workers; `secret.yaml` é template limpo (`REPLACE_ME`, sem valor real commitado); Dockerfile roda como não-root com `tini` + `HEALTHCHECK`; SSRF allowlist de host aplicada ao egress de token WABA na baixa de mídia (`meta-client.ts:46-58,731`); envelope de erro canônico Bevox (sem RFC7807); migration/schema íntegros (1 migration, 16 tabelas).

---

## Parte B — Os dois reenquadramentos desta passada

### B1 · es-1 rebalanceado: CRÍTICO-no-código, PROVAVELMENTE-INERTE-em-prod

**Cadeia de código (CONFIRMADA em primeira mão + secrets-auditor):**
1. `k8s/configmap.yaml:50` seta `OTEL_EXPORTER_OTLP_ENDPOINT: http://otel-collector.monitoring.svc.cluster.local:4318`.
2. `k8s/deployment-api.yaml:53-55` `envFrom` esse configmap + o Secret.
3. `src/lib/telemetry.ts:71` ativa o `NodeSDK` com `getNodeAutoInstrumentations` (`:96`, só `instrumentation-fs` off → **undici ON**), **sem** SpanProcessor nem hook de scrub. `redactStringSecrets` roda **só** no `beforeSend` do Sentry (`:65`→`:166`), nunca em spans. `@opentelemetry/instrumentation-undici@0.25.0` grava `ATTR_URL_FULL` (`undici.js:166`, URL+query) e `ATTR_URL_QUERY` (`:168`) sem redação.
4. Sinks (todos GET via `metaGet`, secret na query string): `meta-client.ts:364-367` debug_token `access_token=${META_APP_ID}|${META_APP_SECRET}` + `input_token=<token de tenant>`; `:313-319` exchangeCode (`client_secret`+`code`); `access_token=<token de tenant>` em `:391/423/474/498/548/611` (discovery/phone/template/COEX).
5. **Dado exposto:** `META_APP_SECRET` do app **`<META_APP_ID>`** (confirmado no go-live plan §0 — o app **"Bevox Solutions" compartilhado com o Bevox V1**), `code` OAuth, e o `access_token` WABA de **cada tenant**.

**Correções de escopo (delta honesto):**
- **Só o processo API é sink** — `initTelemetry()` é chamado **apenas** em `src/index.ts:23`; os 5 workers sobem via `node --import tsx/esm src/workers/<X>.ts` e **nunca** importam telemetry. Logo o `fb_exchange_token` do worker de refresh **não** é sink OTel (07-20 #16 já era LATENTE por outra razão; aqui é **não-sink**). As GETs vivas são as do API: exchangeCode, debug_token, discovery, phone, template, COEX.
- **Os POST sends usam header `Authorization`** (`meta-client.ts:294`), que a instrumentação undici **não** captura → não vazam.

**O reenquadramento (net-new, evidência de manifesto):** a `k8s/networkpolicy.yaml` declara `policyTypes: [Ingress, Egress]` (`:20-22`, default-deny egress) e permite egress **só** em: DNS/53→kube-dns, `any:5432`, `any:6379`, `any:443` (`:52-71`). **A porta 4318 do collector NÃO está na allowlist.** A policy é **aplicada** (disaster-recovery-v1.md:149; ordem canônica em `k8s/README.md`) e **enforçada** — o k3s de prod usa o controlador de NetworkPolicy default (o install `curl -sfL https://get.k3s.io | sh -s - --disable=traefik --disable=servicelb …` **não** passa `--disable-network-policy`). Portanto, sob a configuração de prod mais provável, **o exporter OTLP não alcança o collector → os spans com secret não saem do pod**.

Consequências:
- **es-1 é provavelmente INERTE em prod hoje** — o egress bloqueia o vazamento. Isto **rebaixa** a elevação de 07-21 ("CRÍTICO-vivo"), com base numa referência de manifesto que nenhuma auditoria anterior fez.
- **Corolário net-new (MÉDIO, ver C-M):** os **traces de prod estão provavelmente sendo dropados no egress** → o pipeline MA-007 (traces→Tempo/Grafana) está silenciosamente quebrado; o "fix A18" (que garantia traces após corrigir `/v1/traces/v1/traces`) está **derrotado pela egress-policy**.
- **O defeito de código continua CRÍTICO e latente** — o secret compartilhado com o V1 está no caminho de egress no instante em que: (a) alguém adiciona 4318 à allowlist; (b) o override de Secret NN6 aponta o endpoint pra um host em 443; (c) o collector sobe com ingress em 443; ou (d) `--disable-network-policy` for aplicado. Fix ~3-4h (SpanProcessor/hook undici que apaga `url.full`/`url.query` p/ hosts Meta, **ou** mover secrets p/ header/POST) — **independente** do estado do egress, porque fecha o defeito na origem.

> **Humildade obrigatória:** não tenho acesso ao cluster nesta sessão. Uma regra de egress out-of-band, um ingress do collector em 443, ou `--disable-network-policy` invertem a conclusão. **Gate diagnóstico único:** *os traces aparecem no Tempo/Grafana?* Se **sim** → egress aberto → **es-1 VIVO** (tratar como CRÍTICO imediato). Se **não** → es-1 inerte **e** observabilidade quebrada (corrigir ambos).

### B2 · Freeze não é neutro — a postura de segurança degrada sozinha

As 5 auditorias anteriores trataram "código byte-idêntico → nada novo" como a história inteira. Falso em duas dimensões que **crescem** com o código parado:

1. **Supply chain.** `pnpm audit` (nunca rodado antes na série) acha **65 vulns**; **grafo de produção: 1 crítica, 26 altas, 20 moderadas, 2 baixas**. Muitas foram **divulgadas depois** do freeze de 2026-06-09 — ou seja, o número **sobe** sem uma linha mudar. **Sem gate de CI, Dependabot, ou `pnpm audit`**, ninguém observa. Detalhe na **Parte D**.
2. **Fragilidade de ops que compõe com o tráfego do piloto.** O cluster N1-N4 (07-20/21) + NN1-NN4 (esta passada) dispara em **eventos rotineiros** (deploy, failover CNPG, blip Redis) — e a probabilidade de encontrar essas janelas **cresce** conforme o piloto recebe volume real. O alvo estático esconde um risco dinâmico.

**A tese de 07-21 ("gargalo é decisão, não descoberta") se mantém e aperta: o custo de NÃO decidir compõe.**

---

## Parte C — Achados por severidade (cobrindo categorias a-l da missão)

### CRÍTICO (bloqueia piloto / vivo em prod)

**CRÍT-1 · A5 + A5b — perda/sub-entrega silenciosa de inbound em blip de Postgres/Redis** (cat. a/h/i) · SURVIVES · CONFIRMED [invariants + hmac + orq]
`inbound/service.ts:298` chama `isDuplicate(metaEventId)` (SET NX EX 24h, `:186-192`) **antes** de `insertInboundEvent()` (`:324`); **nenhum `del()` compensatório** (grep vazio). `db/schema/operations.ts:98` usa `index()` **não-único** em `meta_event_id` enquanto `uniqueIndex` está importado (`:18`) e usado p/ outbound (`:68`) — escolha deliberada; o `SET NX` no Redis é o **único** dedup. `processMetaWebhook` **não** está em try/catch (`inbound/routes.ts:129`). **A5 (perda):** insert lança (blip CNPG single-instance) → 5xx → Meta retenta → `isDuplicate=true` → 200 OK → evento nunca persistido/entregue. **A5b (sub-entrega):** `listActiveSubscriptions` (`:388`) + loop `queue.add` (`:392-411`) **não** estão em try/catch (ao contrário do media-enqueue `:363-372` e `publishEvent` `:375-386`) → throw pós-insert → 5xx → dedup suprime reprocessamento → deliveries nunca enfileiram. **Downgrade re-refutado:** "Redis durável / single WABA / re-delivery normal" não tocam o mecanismo (a falha é no insert Postgres *depois* da chave Redis; a durabilidade do Redis é o que **suprime** a retentativa da Meta). **Nuance de liveness:** para o app compartilhado "Bevox Solutions" o webhook a nível de app aponta pro V1/chat.example.com (memória) → **latente enquanto o inbound não é roteado à meta-api**; **vivo para um consumer de app dedicado** (ex.: bevox-direct). **~6h.**

**CRÍT-2 · es-1 — secret do Meta App + tokens → spans OTel** (cat. d/j) · **REBALANCEADO** (ver B1) · CONFIRMED-no-código, PROVÁVEL-INERTE-em-prod [secrets + orq]
Defeito de código CONFIRMADO; egress de prod **provavelmente bloqueia** (4318 fora da allowlist da NetworkPolicy enforçada). Latente-crítico: 1 edição de manifesto o torna vivo. Gate: *traces aparecem no Tempo/Grafana?* Fix ~3-4h fecha na origem.

**CRÍT-3 · MA-012 — postura LGPD `Status: Proposta`** (cat. e) · SURVIVES · [orq — canon]
`$BEVOX_KNOWLEDGE_PATH/30_adr/bevox-meta-api/MA-012-…:3` (`Proposta`), `:7` ("Bloqueia: go-live de produção"). Critério de Aceita (§177-182): parecer de advogado externo + **RoPa OT-19** (ADR-020) + PRD §12 atualizado — **nada feito**. DSR endpoint `POST /admin/dsr` (§170-171) **diferido a "iteração 1.1", não implementado**. **A base legal (§114-115: "TLS, cifra em repouso, audit log, retenção, PII redaction — tudo já implementado") é minada** pelos gaps I8/N8/es-1/redação. Todo PII (conteúdo cru em `inbound_events.payload_json` 90d por design de forwarding) tratado sob declaração unilateral. README: `bevox-backend` coberto pelo MSA → operação atual é **decisão jurídica**; onboarding novo **bloqueado**. **Eng-prereqs ~7h + jurídico ~24h.**

> Nenhum CRÍTICO refutado. A5/MA-012 intactos. **es-1 rebalanceado** (código-CRÍTICO, prod-provável-inerte).

### ALTO (bloqueia GA; pilot-HIGH em blip de infra — decidir aceite)

1. **NN1 — ordem de shutdown INVERTIDA na API** (cat. h) · **NET-NEW · CONFIRMED [completeness]** · **melhor ROI da auditoria**
   `index.ts:28-33` registra hooks `fastify→queues→event-bus→postgres→redis→telemetry`; `shutdown.ts:50` executa **LIFO** → ordem real `telemetry→redis→postgres→…→fastify`. **Fastify para de aceitar por ÚLTIMO — depois de Postgres/Redis já fechados** (inverso do documentado em `shutdown.ts:4-9`). Requests em voo/na janela de drain: 500, **ou** re-inicializam pool/Redis lazily (`client.ts:63-64`, `redis.ts:34-38`) — inclusive um **novo** `pool.on('error')` (compõe N1). **Dispara em todo rollout.** Fix: reverter a ordem de registro em `index.ts`. **~15min.**

2. **N1/F2 + NN2 — `pool.on("error")` → `uncaughtException` + workers sem Sentry/OTel → crash duro** (cat. h/d) · SURVIVES + **NET-NEW amplificação · CONFIRMED [completeness + orq]**
   `db/client.ts:51-53` `pool.on("error", (err) => process.emit("uncaughtException", err))`; **nenhum** `process.on("uncaughtException")` no app (só `unhandledRejection` em `index.ts:38`); o comentário "propagar ao shutdown" é **falso**. Na API (Sentry set), a integração default do `@sentry/node` v10 **termina o processo** → drop de conexão idle (rotineiro em failover CNPG `instances:1`) **derruba o pod**. **NN2 (net-new):** os 5 workers **não** chamam `initTelemetry()` → **sem** listener Sentry de `uncaughtException` → o `pool.on('error')` no worker cai no default do Node = **crash duro imediato**, pulando o drain → job em voo abandonado → redelivery → double-send (N2). Nas 2 réplicas de API no mesmo node + 1 CNPG → **crash coordenado = outage breve total** (caminho de escalada a CRÍTICO). **~1h (N1) + ~S (NN2 `initTelemetry` nos workers).**

3. **NN3 — worker deployments sem probes k8s** (cat. g/h) · **NET-NEW · CONFIRMED [completeness]**
   `k8s/deployment-workers.yaml` = **0 probes** nos 5 workers (API tem 4). O metrics-server do worker já expõe `GET /healthz` em `:9090` (`worker-metrics-server.ts:74-79`) — pronto p/ liveness, mas não-wired. Worker travado-mas-Running (conexão BullMQ morta, event-loop stall) fica `Running` p/ sempre; k8s nunca reinicia. Nos singletons `replicas:1` (tok/cleanup/media) = **outage total silencioso** daquela função. Agrava: `prometheusrule.yaml` **sem** alerta de down p/ worker-out/in/media/tok. **~XS** (add `livenessProbe: httpGet /healthz:9090`).

4. **N2/F1 + N3 + N4 + NN5-inv — ciclo de vida do job outbound: double-send / job preso / key queimada** (cat. a/h/k/j) · SURVIVES + **NET-NEW · CONFIRMED [completeness + invariants]**
   - **N2:** `messages/service.ts:181-184` send Meta **antes** do `insertOutboundJob` (`:203`); `idempotencyKey` só como valor de coluna (`:190,205`), **nunca** short-circuit pré-send; worker chama direto (`outbound-dispatcher.ts:105`, key `async:${job_id}`) bypassando o plugin HTTP; `attempts:5` (`queues.ts:31`). Lost-ack/SIGKILL → **reenvio** (WhatsApp Cloud API não deduplica). **Pior:** o insert pós-send colide no unique (`operations.ts:68`) → job reportado **`failed` apesar de 2 mensagens entregues**.
   - **N3:** `shutdown.ts:45` cap de 10s/hook; job outbound pior-caso (send 10s + deliverCallback 10s) > 10s → hook abortado → stalled → redelivery (compõe N2).
   - **N4:** `outbound-dispatcher.ts:78-85` `incrementAttempts`+`updateJobStatus("sending")`+`unsealOutboundJobSecrets` **antes** do try (`:100`). Unseal lança (blip KMS/WIF) → catch (`:121`) nunca roda → **row preso em `sending` p/ sempre**; `getMessage` mapeia `sending→"queued"` (`service.ts:317`) → consumer faz poll infinito.
   - **NN5-inv (net-new):** send falho insere job `failed` com a key (`:188-199`); resposta ≥300 → plugin **não** persiste record (`idempotency.ts:127`) → retry com a mesma key **re-atinge Meta** → insert de sucesso colide no unique → **500 após a mensagem já ter sido enviada**. **~6-8h o cluster.**

5. **I2 + NN1-inv — idempotência: corrida read-then-write (sync) + replay CROSS-TENANT** (cat. a/h) · SURVIVES + **NET-NEW · CONFIRMED [invariants]**
   - **I2:** `plugins/idempotency.ts:98` `findIdempotencyRecord` e só em `onSend` (`:136`) `saveIdempotencyRecord`; **sem reserva in-flight** → dois requests concorrentes com a mesma key ambos dão miss → ambos chamam Meta (**envio dobrado sync**); o unique `(app_id, idempotency_key)` só pega o 2º insert, após o 2º send.
   - **NN1-inv (net-new, HIGH):** a identidade da idempotência é `(app_id, key)` (PK `idempotency.ts:33`); o plugin faz hash do `req.body` (`:97`), mas o **tenant vive no header `X-Tenant-Id`, não no body**. Logo mesmo app + mesma key + mesmo body + **tenant diferente** → `requestHash` casa → **REPLAY**: tenant B recebe o `message_id`/`provider_message_id` cacheado de A, e a **mensagem de B nunca é enviada**. Contradiz I2 **e** I3. **LATENTE** (precisa ≥2 tenants/app). **~4-6h.**

6. **NN1-tenant — firehose de inbound sem isolamento de tenant** (cat. a/i) · **NET-NEW · CONFIRMED [tenant-scope]**
   `events/repository.ts` `listEventsForReplay:20-28` / `listEventsForPolling:44-55` filtram por `appId` sempre; `tenantId` é filtro **opcional** do cliente. Um caller que **omite** `X-Tenant-Id` recebe eventos inbound (conteúdo de mensagem, contatos) de **todos** os tenants do app. SSE idem (`events/routes.ts:95`). É a **maior superfície de leitura cross-tenant** (mais ampla que `findOutboundJob`). Documentado como "by design" (`events/routes.ts:5`) mas contradiz MA-003. **LIVE se ≥2 tenants/app.** **~2h** (exigir/scopar `X-Tenant-Id`).

7. **undici@8.1.0 — CVE de bypass de validação TLS no cliente de TODA chamada Meta** (cat. d/h) · **NET-NEW [pnpm audit + orq]**
   `undici@8.1.0` (dep **direta** de prod) tem CVE **HIGH** de "TLS certificate validation bypass" (+ WebSocket DoS, SOCKS5 cross-origin routing, header injection, cross-user disclosure); patched em **≥8.5.0**. undici é o cliente de **todas** as chamadas à Meta (`meta-client.ts`). Bump minor sem breaking change (CLAUDE.md §8 "atualizar"). **~15min.** Ver Parte D.

8. **Ausência do fluxo `register` de phone number** (cat. a/g/h) · SURVIVES · CONFIRMED [orq]
   `grep register|request_code|verify_code` em `phone-numbers/`+`wabas/` = **0**. Rotas são só GET-list e POST-profile. O número precisa de `POST /{phone_number_id}/register` antes do 1º envio. **Escala a CRÍTICO se o piloto onboardar número novo/migrado via ES puro.** **~6h.**

9. **SSRF outbound (3 sinks) + oráculo de verify-on-create** (cat. g/h/i) · SURVIVES com **nuance de egress** · CONFIRMED [webhook-hmac]
   Sinks sem guard de faixa privada/link-local/metadata: (1) `deliverCallback` (`outbound-dispatcher.ts:56`) — `callback_url` é `z.url()` **sem https-only** (`messages/schemas.ts:55`), aceita `http://`; (2) `deliverPost` (`webhook-delivery.ts:90`) https-only; (3) **pior — oráculo síncrono** `undiciVerifier.verify` (`webhooks/service.ts:63`): ecoa `reason` = `HTTP <status>`/`err.message` ao caller (`:112-115`) → qualquer consumer JWT enumera a rede interna no create de subscription. undici não segue redirect (default 0). **Nuance de egress (net-new):** sob a NetworkPolicy enforçada, egress é só 443 (+53/5432/6379) → SSRF via **http/porta 80** (ex.: metadata `169.254.169.254:80`) **bloqueado**; só alvos **443** alcançáveis → blast radius menor que 07-21 pintou. **Pilot: accept-with-note** (consumer same-org). **~4h.**

10. **I8/N8 — durabilidade+integridade do audit** (cat. e) · SURVIVES com **CORREÇÃO de N8** · CONFIRMED [invariants + orq]
    (a) `X-Tenant-Id` **forjável** — `audit-log.ts:60-61` lê header cru (enquanto `app_id :89` vem do JWT); (b) `void logAudit` (`:82`) + `lib/audit.ts:45` catch que só `warn` → best-effort; (c) só audita **2xx-3xx** (`:50`) → mutações negadas/falhas fora da trilha; (d) `metadata.body` sempre `[REDACTED]` (`:93`+`logger.ts:138`); (e) imutabilidade de DB é **TODO** (`db/schema/audit.ts:8`). **CORREÇÃO ao corpus (N8):** 07-21 disse "o path admin canônico não deixa trilha". Na verdade o path **canônico** de prod é HTTP `POST /admin/apps` (CLAUDE.md §11 + go-live gotcha §1.8 marcam o `pnpm cli` como quebrado fora de `src/`), e o hook `onResponse` **audita** mutações admin HTTP (`audit-log.ts:31-34` `admin:apps`; `:65-67` `actorType=admin`) — o script `provision-bevox-direct-consumer.js` minta JWT → HTTP → **auditado**. O path **sem** trilha é o `pnpm cli` (desencorajado). **Residual real:** (i) o CLI não audita; (ii) mesmo no HTTP, o create é auditado com **`resourceId: null`** (o UUID do app criado está no response, não na URL — `inferResourceId(url)` `:39-42`) → não dá pra saber **qual** app foi criado; (iii) durabilidade best-effort + só-2xx valem também pro HTTP. **~5h** (logAudit síncrono no service p/ create/rotate/deactivate/replay + validar `X-Tenant-Id`).

11. **Contrato §3f — `POST /v1/messages` diverge fundamentalmente spec×código + armadilha do guia** (cat. b/f) · SURVIVES + **NET-NEW · CONFIRMED [contract-guardian]**
    `openapi.yaml` (repo `:1204-1233`, canon `:1174-1196`) exige `from_phone_number_id` + chaves top-level por tipo, **8 tipos**; código (`messages/schemas.ts:28-41`) exige `from` + **chave única `content`** discriminada, só **`text|template|image`**. Cliente gerado do spec → **400 em todo send**. **Armadilha net-new:** o **guia consumer** (o artefato mais fiel) tem o único exemplo de send **truncado** (`guide:145`, `{channel,to,type:"template", ...}`, **sem** o wrapper `content`) → um engenheiro completando o `...` a partir do openapi/skill manda `text:{body}`/`from_phone_number_id` e **400 em toda mensagem**. **Fix barato:** 1 body completo no guia (`content:`+`from`) + `pnpm smoke` obrigatório pré-cutover. Bloqueia onboarding-via-spec (GA), não o piloto guide-first. **~2h.**

12. **NN-1 hmac — HMAC inbound + verify-token são um único secret GLOBAL, não per-Meta-app** (cat. i) · SURVIVES · CONFIRMED [webhook-hmac]
    `verifySignature` lê `META_WEBHOOK_APP_SECRET` global (`inbound/routes.ts:46`; `env.ts:69`); verify-token idem (`:91`). **Não há** coluna `meta_apps.app_secret` (grep=0). Um 2º Meta app = **webhooks 401** (Meta assina com secret diferente). Contradiz CLAUDE.md §1 "multi-app". **LATENTE** (1 Meta app). **~1-2d.**

13. **rlq-2 + obs-1/2/3 — 429 Meta não retentado + métricas-chave cegas** (cat. k, MA-007) · SURVIVES · CONFIRMED [orq]
    `meta-client.ts:261` retenta só `status>=500||0`; **429 cai fora** → `META_REJECTED` terminal → async morre sem retry. **Nenhum** circuit breaker. `metaRequestDuration`/`tokenRefreshTotal`/`queueSize` (`metrics.ts:42,116,54`) = **0 call-sites** → os alertas do PRD §13.4 (refresh, dead-letter, Meta latency) são **cegos**. **Correção (webhook-hmac):** o `webhook_signature_invalid` do rule **não existe por esse nome**, mas assinatura inválida **É** contada via `metaWebhookReceivedTotal{outcome="invalid_signature"}` (`routes.ts:113`) — sinal existe, o contrato de nome da rule é drift. **~3h.**

14. **es-1 vetor secundário — redação incompleta (LATENTES)** (cat. d/j) · SURVIVES com CORREÇÃO · CONFIRMED [secrets]
    `serializeErrorRedacted` **não** é `serializers.err` nem no root logger (`logger.ts` sem `serializers`) nem no Fastify `req.log` (`server.ts:74-79` só `{req}`) nem nos ~18 sinks `{err}` de worker/API → um token em `err.message` vazaria (hoje **LATENTE** — erros undici carregam msg fixa). `redact()` casa lowercased-exato (`logger.ts:145`) — **não** cobre `accessToken`/`privateKeyPem`/`clientSecret`/`client_secret`/`app_secret`/`dek`/`system_user_access_token`. `redact.paths` do Fastify sem wildcard `*.` (`server.ts:55-71`). `error.details` cru na response (`error-handler.ts:62-73`, hoje só escalares seguros). **~2h fecha tudo** (`serializers.err` nos 2 loggers + alinhar key-list §7.4 + espelhar wildcards).

### MÉDIO (degrada qualidade)

15. **NN4-completeness — Redis sem `maxmemory`/eviction + mistura fila durável × cache efêmero** (cat. h/j) · **NET-NEW [completeness]**
    `k8s/redis.yaml:32-35` roda `redis-server --appendonly yes --requirepass …` **sem** `--maxmemory`/`--maxmemory-policy`; limit `1Gi` (`:54`). A **mesma** instância guarda BullMQ durável (7d, `queues.ts:33-34`) **e** idempotency/rate-limit/dedup efêmeros. (a) default `noeviction` → em 1Gi **todos os writes falham** → sends/webhooks rejeitados; (b) se um operador "conserta" com `allkeys-lru` → LRU evicta keys BullMQ = **perda de jobs outbound / deliveries (data loss)**. Sem alerta de memória. **~S** (`--maxmemory` + `noeviction` + alerta + separar DB index fila/cache).

16. **Corolário es-1 — traces de prod provavelmente dropados no egress → observabilidade quebrada** (cat. k, MA-007) · **NET-NEW [orq]**
    Ver B1: sob NetworkPolicy enforçada, egress a `:4318` bloqueado → o exporter OTLP não alcança o collector → **traces silenciados em prod** (MA-007 não cumprido; A18 derrotado). Diagnóstico junto do gate es-1. **~0.5h** (adicionar 4318 ao egress **junto** com o fix de scrub de es-1 — nunca um sem o outro).

17. **NN6-completeness — `OTEL_EXPORTER_OTLP_ENDPOINT` em ConfigMap E Secret (colisão)** (cat. g) · **NET-NEW [completeness]**
    `configmap.yaml:50` tem o valor pós-A18 (sem sufixo `/v1/traces`); o template de Secret (`secret.yaml:16`) também lista a key. `envFrom` põe `configMapRef` **depois** `secretRef` (`deployment-api.yaml:53-55`) → **secretRef vence**. Se um operador popular a key no Secret (como o template instrui) com o valor antigo `/v1/traces`-sufixado → **regressão A18** (traces silenciados). Verificar o Secret vivo. **~XS** (definir em um só lugar).

18. **NN4-inv — audit dropado silenciosamente por FK de header forjável** (cat. e) · **NET-NEW · CONFIRMED [invariants]**
    `audit_logs.tenant_id` é FK p/ `tenants` (`audit.ts:28`), mas o plugin preenche do header cru (`audit-log.ts:60`). Numa rota 2xx que ignora o header (ex.: `POST /v1/events/ack`), um consumer autenticado mandando um UUID de tenant **inexistente** → violação de FK no insert → `logAudit` engole (`audit.ts:45`) → **mutação silenciosamente não-auditada**; um UUID de tenant **real de outro app** → **mis-atribui** a linha de audit. **~2h** (derivar `tenant_id` de contexto validado).

19. **NN5-completeness — cleanup nunca poda `webhook_deliveries` (nem `audit_logs`)** (cat. e/h) · **NET-NEW [completeness]**
    `cleanup/repository.ts` poda só `idempotency_records`/`inbound_events`(90d)/`outbound_jobs`(30d). `webhook_deliveries` (`delivered`+`dead_letter`) acumulam p/ sempre, sem partição, no volume CNPG de 20Gi (`cnpg-cluster.yaml:24`); `audit_logs` cresce por design (5a) mas unpartitioned. **Sem alerta de disco PG.** Lento no volume do piloto, mas ilimitado. **~S.**

20. **N1-secrets — label de rota 404 com cardinalidade ilimitada** (cat. k) · **NET-NEW · PARCIAL-CORREÇÃO [secrets]**
    `server.ts:155` → `metrics.ts:26,34`: `route` = `req.routeOptions?.url ?? req.url.split("?")[0]`; em rota **não-casada (404)** o pathname **cru controlado pelo atacante** vira label Prometheus → **cardinalidade ilimitada** (+ PII marginal de path). **Corrige parcialmente** a nota de 07-21 ("labels rule-compliant") — vale p/ rotas casadas; o path 404 é buraco. **~0.5h** (clampar p/ `"unmatched"`).

21. **hmac-F4/F5 + NN2/NN3/NN6-hmac — callback async sem anti-replay + delivery SELECT-then-INSERT + replay mislabel** (cat. i/a) · SURVIVES + **NET-NEW [webhook-hmac]**
    Divergência de 4 eixos entre `deliverCallback` (`outbound-dispatcher.ts:51`, body-only, header `x-bevox-signature-256`, sem ts) e `webhook-delivery.ts:72-75` (`t=,v1=`, `x-bevox-signature`, re-assina no retry) → consumer que usa os 2 modos implementa **2** verificadores. `callback_url`/`callback_secret` opcionais e independentes (sem `.refine()`) → url sem secret = POST **não-assinado**. `webhookDeliveries` sem unique `(subscription_id, inbound_event_id)` (`operations.ts:162-171`) + `findOrCreateDelivery` SELECT-then-INSERT sem txn (`repository.ts:29-54`) + replay jobId não-determinístico (`service.ts:199` `replay:${r.id}:${Date.now()}`) → **entrega dobrada** em replay. **NN2-hmac (net-new):** replay marca `event_type:"replay"` (`service.ts:197`→`webhook-delivery.ts:163`) → consumer perde o tipo original (`message.received` etc.) e a mitigação de dedup por `event_id` enfraquece. **~2h cada.**

22. **F4 — `phone_numbers.meta_phone_id` unique GLOBAL + upsert não re-parenta** (cat. a) · SURVIVES · **CONFIRMED [tenant-scope: STOP+ADR]**
    `bindings.ts:111-113` unique só em `metaPhoneId`; `phone-numbers/repository.ts:37-46` `onConflictDoUpdate({target: metaPhoneId})` reescreve display/verified/quality/tier mas **não** `wabaConnectionId`. Número portado app1→app2 → row segue apontando p/ WABA do app1 com metadata do app2 → **corrupção + leak de metadata cross-app**. **STOP+ADR** (§8, migration). **LATENTE** (precisa mesmo número sob 2 WABAs). **~3h + migration.**

23. **F6 + tenant-a10 + NN2-tenant — mídia usa `wabas[0]`; resolução por `meta_waba_id` sem orderBy; disconnect sem tenant** (cat. j/a) · SURVIVES + **NET-NEW [tenant-scope]**
    **F6:** `MediaDownloadJob` sem binding de WABA (`inbound/service.ts:366`); worker pega `wabas[0]` (`media-download.ts:50-51`, `orderBy asc(id)` = WABA mais antiga) → mídia da WABA #2 baixada com token da #1 → 401 → descartada → `GET /v1/media/:key` preso em 202. **tenant-a10:** `findWabaByMetaWabaId` (`wabas/repository.ts:84-90`) e `findIgByMetaIgId` (`ig/repository.ts:60-66`) `.limit(1)` **sem orderBy** → atribuição não-determinística de PII inbound se 2 tenants compartilham `meta_waba_id`. **NN2-tenant:** `disconnectWabaByMetaWabaId` (`wabas/repository.ts:187-203`) UPDATE por `meta_waba_id` sem tenant/limit → PARTNER_REMOVED desconecta ambos. **LATENTES** (multi-WABA). **~3h.**

24. **Tenancy defense-in-depth (I3) + `findOutboundJob` cross-tenant + soft-delete leak** (cat. a) · SURVIVES · CONFIRMED [tenant-scope + invariants]
    Plugin `tenant-scope` **inexistente** (`request-context.ts:43` `patchContext` = 0 call-sites; `server.ts:147` diz "futuro"); `tenant_id` **não** é claim do JWT (100% do header). Cross-**app** eficaz (`iss` assinado). Gaps intra-app: `findOutboundJob` (`messages/repository.ts:48-55`) sem `tenant_id` → `GET /v1/jobs/:id` e `/v1/messages/:id` cross-tenant; `findTenantById` (`tenants/repository.ts:32`) vaza soft-deleted. **LATENTES** (≥2 tenants). Padrão de referência a copiar: `media/service.ts:29-53` (valida `X-Tenant-Id` contra WABA real). **~2h + reconciliação doc/ADR/MA-003.**

25. **N5/N6/N9/N11 — media OOM; readyz sem S3; webhook sem override de bodyLimit; Redis sem commandTimeout** (cat. h/j) · SURVIVES · CONFIRMED [completeness]
    **N5:** `meta-client.ts:750` `arrayBuffer()` sem cap; guard só por metadata (`media-download.ts:61`) × `concurrency:10` × `512Mi` → OOM. **N6:** `readiness()` (`health.ts:108-113`) checa PG+Redis+KMS, **não** S3 → readyz verde com mídia quebrada. **N9:** `/webhooks/meta` não override `bodyLimit:1MB` (`server.ts:102`) → batch Meta >1MB = **413 pré-HMAC** → Meta retenta idêntico → drop. **N11:** `redis.ts:22` `enableOfflineQueue:true` sem `commandTimeout` → comandos bufferam ilimitado em blip. **~0.5-1h cada.**

26. **Contrato — drift repo↔canonical OpenAPI (mesmo `1.2.0`) + 5 renomes + handlers-fora-do-spec + events/ack header + skill** (cat. b/f) · SURVIVES · CONFIRMED [contract-guardian]
    Ambos openapi `1.2.0`, `package.json` `0.1.0` (bate com nenhum). Repo-only `/wabas/connect/complete` (implementado `wabas/routes.ts:43`); canon-only `/v1/media/{media_key}`+`403` (implementado `media/routes.ts:19`). 5 renomes spec↔código: `id↔event_id`, `secret↔signing_secret`, `current_kid↔current_public_key_id`, `OutboundJob.id↔job_id`, `last_error↔error`. Phantom `/wabas/connect/callback` (real `/v1/oauth/waba/callback`; o IG está certo nos 2). `delivery_mode` enum `[push,sse,polling]` over-promised (código `z.literal("push")`; sse/polling são pull endpoints). `events/ack`: spec **não** declara o header `Idempotency-Key` obrigatório (código exige, `events/routes.ts:190`) + response 204 (spec) vs 200 `{acked,requested}` (código). Handlers fora do spec repo: `/v1/media`, `/admin/apps/:id/deactivate` (ausente dos **dois** specs), `/webhooks/meta` + `/metrics` (by-design). Skill propaga o phantom callback + omite `deactivate`+`complete`. **Direção: canon é SoT (ADR-005).** **~2d convergência.**

27. **E.164 sem máscara em repouso + over-redaction do audit** (cat. e) · SURVIVES · [secrets]
    `messages/service.ts:177/241` `redact(input.body)` mantém `to`/`from` (E.164 do destinatário) em `outbound_jobs.payload_json` (30d). Não retornado/logado — **PII-at-rest only**, relevante a LGPD/MA-012. **~0.5h** (máscara `+55****1234`).

28. **@hapi/wreck + protobufjs/grpc — CVEs de prod DoS-class / leak de header OAuth** (cat. d) · **NET-NEW [pnpm audit]**
    `@hapi/wreck` (via `@fastify/oauth2 > simple-oauth2`) — **MOD/HIGH** leak de `Proxy-Authorization`/credencial em redirect cross-host (path OAuth WABA/IG). `protobufjs`/`@grpc/grpc-js` (via `@google-cloud/kms` e OTel) — HIGH code-injection/proto-pollution/DoS, mas **baixa controlabilidade** (protobuf client-side, input confiável GCP/collector). `@opentelemetry/*` Prometheus-exporter crash (se exposto). Ver Parte D. **~1-2h bump coordenado.**

### BAIXO (higiene)

29. **CVE crítico `fast-jwt` — dep MORTA (remover `@fastify/jwt`)** (cat. d) · **NET-NEW [pnpm audit + orq]**
    `@fastify/jwt@10.0.0 > fast-jwt@6.2.2` tem CVE **CRÍTICO** (bypass de auth por HMAC-secret-vazio), mas **`@fastify/jwt` nunca é importado** (grep `src/` = 0; ambos os paths JWT usam `jose`); `ADMIN_API_KEY` exige ≥8 chars (`env.ts:82`). **Não-alcançável.** Remover a dep morta fecha o CVE crítico + reduz superfície. **~15min.**

30. **NEW-lint-1** (`queues.ts:174` vivo + 4 snippets + `.mjs` untracked) = `pnpm lint` exit 1 · SURVIVES · **~1h + remover o `.mjs`** (fecha 1/6).
31. **NN7 — imagem `:dbe9fd6` `imagePullPolicy:Never` + Dockerfile embarca dev-deps** · **NET-NEW [completeness]** · node novo → `ImagePullBackOff`; runtime usa `deps` node_modules (embarca `testcontainers`/`vitest` no image de prod — superfície + os CVEs dev-only). **~S.**
32. **N10 — `@types/node@20` vs `engines>=22.19` + `@types/uuid@11` vs `uuid@14`** (cat. d) · SURVIVES · **~0.5h.**
33. **N12/N13 — cron re-tica no rollout + overlap 2-pod; HPA só na API por CPU; PDB ausente p/ tok/cleanup/media** · SURVIVES · comentário "3am UTC" falso (`cleanup.ts:29`, é boot+24h; repetido em `deployment-workers.yaml:209`). **~2h.**
34. **F8/F7-SSE/JWT-clamp/NN3-secrets** — `hub.verify_token` `===` não-constant-time (`inbound/routes.ts:91`); fan-out SSE ilimitado; `JWT_MAX_AGE_SECONDS.max(900)` (`env.ts:78`) vs I5 ≤300 (default 300, compliant); `index.ts:48` `console.error("fatal:")` cru no boot · SURVIVES/NET-NEW menores.
35. **Doc-drift** — consumer guide + go-live-checklist **ausentes do repo** (só no canon `20_architecture/bevox-meta-api/`; README §21 e mission linkam path inexistente); README "249 testes" (`:9,:78`) vs 443; guia "6 tentativas" (`:267`) vs `WEBHOOK_DELIVERY_MAX_RETRIES:8` (configmap:62); PRD §13.3 pede label `tenant_id` em métrica (contradiz `secrets-never-log.md`); **MA-015 `Proposta` mas já em prod** (inversão de processo); **MA-016 (analytics) não-implementado** (grep=0; bloqueia sub-projeto Cleanup do bevox-direct, não o piloto). · SURVIVES/NET-NEW menores.

---

## Parte D — Varredura de CVE de dependências (NET-NEW — primeira da série)

`pnpm audit` @ HEAD `03c1af6`: **65 vulns totais**; **grafo de produção: 1 crítica · 26 altas · 20 moderadas · 2 baixas** (o resto é dev-only: `testcontainers>undici@7.25.0`, `vitest>vite/esbuild`, `drizzle-kit>esbuild`, `openapi-typescript>js-yaml`).

| Sev | Pacote | Vetor | Alcançável? | Ação |
|---|---|---|---|---|
| **CRÍTICO** | `fast-jwt@6.2.2` (via `@fastify/jwt`) | bypass de auth por HMAC-secret-vazio | **NÃO** — `@fastify/jwt` nunca importado; JWT via `jose` travado; `ADMIN_API_KEY` ≥8 | **Remover `@fastify/jwt`** (dep morta) — fecha o crítico + reduz superfície |
| **ALTO** | `undici@8.1.0` (direta) | TLS validation bypass; WS DoS; SOCKS5 routing; header injection; cross-user disclosure | **SIM** — cliente de toda chamada Meta | **Bump ≥8.5.0** (minor, sem breaking) |
| MOD/ALTO | `@hapi/wreck@18.1.0` (via `@fastify/oauth2>simple-oauth2`) | leak de `Proxy-Authorization`/credencial em redirect cross-host | **SIM** — path OAuth WABA/IG | Bump (`@fastify/oauth2`/transitiva) |
| ALTO/MOD | `protobufjs` (via `@google-cloud/kms>grpc` e OTel) | code-injection / proto-pollution / DoS | **Baixa** — client-side, input GCP/collector confiável | Bump transitivo |
| ALTO | `@opentelemetry/*` (auto-instr/sdk-node/exporter-prometheus) | Prometheus-exporter crash via HTTP malformado | Condicional (se exporter exposto) | Bump OTel |
| ALTO | `@grpc/grpc-js` (via KMS) | server crash via request malformado | **Baixa** — grpc client-side | Bump transitivo |
| ALTO/MOD | `fast-uri` (via `@fastify/swagger`), `brace-expansion`, `joi` (via oauth2) | path-traversal / host-confusion / DoS | Baixa (docs/parse) | Bump transitivo |

**Observações:**
- **A crítica é ruído após adjudicação** — remover a dep morta é higiene, não emergência. **As reais são `undici` (alcançável, TODA chamada Meta) e `@hapi/wreck` (OAuth).**
- **O image de runtime embarca dev-deps** (Dockerfile stage 5 usa `deps`, não `prod-deps`) → `testcontainers`→`undici@7.25.0`, `vitest`→`vite/esbuild` **viajam pro prod** (não importados em runtime, mas em disco → superfície).
- **Nenhum gate** (`pnpm audit` não está no CI; sem Dependabot) → o número **sobe** com o freeze. Recomendação de governança: adicionar `pnpm audit --prod --audit-level=high` ao CI + Dependabot/Renovate.

---

## Parte E — Placar das 11 invariantes (CLAUDE.md §4/§5)

| Inv | Status | Evidência-âncora (HEAD 03c1af6) |
|---|---|---|
| **I1** UUIDv7 | **PASS** | `db/schema/_shared.ts:73`; `uuid.ts:12` `v7`; zero serial/uuidv4. |
| **I2** Idempotência | **PARTIAL** (orq: FAIL na garantia) | Header enforced no path consumer; corrida read-then-write (`idempotency.ts:98→136`) + Meta antes do insert (`messages/service.ts:181`) → double-send sync; **replay cross-tenant** (NN1-inv, identidade `(app_id,key)` ignora tenant do header); admin sem idempotência. |
| **I3** app/tenant-scope | **PARTIAL / DRIFT** | Plugin `tenant-scope` **inexistente**; cross-app OK (`iss` assinado); tenant 100% do header. Gaps: firehose de inbound (NN1-tenant), `findOutboundJob`, soft-delete leak, F4/F6/tenant-a10. |
| **I4** tokens fora de log | **PASS** (WARN es-1) | Núcleo sólido (zeroize `token-resolver.ts:62`). es-1 é defeito de código (query→span) mas **provavelmente bloqueado no egress** (B1); redact() key-list incompleta (latente). |
| **I5** JWT RS256+kid+TTL | **PASS** (WARN) | `auth-jwt-consumer.ts:93,144` (jose, RS256 travado). WARN: `env.ts:78` `.max(900)` (default 300). |
| **I6** PII redaction | **PASS** | `logger.ts:127` redige content/text/body; raw inbound nunca logado. |
| **I7** soft-delete | **PARTIAL (defensável)** | Só `tenancy` tem `deletedAt`; `templates/repository.ts:89` hard `.delete()` (espelho da Meta, sem coluna soft-delete — atenuante). |
| **I8** audit em mutação | **PARTIAL** (orq: FAIL na durabilidade) | Hook wired e **audita admin HTTP** (correção N8); mas tenant forjável, `void logAudit`+swallow, só 2xx-3xx, body `[REDACTED]`, create com `resourceId:null`, imutabilidade TODO, CLI não audita. |
| **I9** HMAC webhooks | **PASS** (orq: PARTIAL out) | Inbound constant-time antes do parse (`inbound/routes.ts:58,108-121`). Outbound: divergência de formato + anti-replay + SSRF (#9,#21). |
| **I10** multi-WABA | **PARTIAL** | `bindings.ts:57` unique `(tenant_id, meta_waba_id)`. Ressalva: resolução sem orderBy (tenant-a10) + F4/F6. |
| **I11** transações ≥2 escritas | **PASS** | Toda escrita multi-row em `db.transaction()` (validado em Postgres real em 07-20). |

> Nenhuma invariante virou verde→vermelho ou vermelho→verde vs o baseline congelado.

---

## Parte F — LEDGER DE DECISÃO (o entregável para a revisão humana)

Para cada item congelado, a **decisão** que amanhã precisa produzir.

| # | Item | Fix | Aceitar p/ piloto? | Risco residual se aceitar |
|---|------|-----|--------------------|---------------------------|
| **NN1** | **shutdown invertido na API** | **~15min** | **NÃO — fechar já** (dispara todo deploy, melhor ROI) | Requests 500/reconexão espúria em cada rollout |
| CRÍT-2 | **es-1** (secret Meta/tokens→OTel) | ~3-4h (scrub) | **Só com o gate:** *traces aparecem no Tempo/Grafana?* Se **não** → aceitável (egress bloqueia; mas corrigir observabilidade). Se **sim** → **NÃO aceitável** (secret compartilhado com V1 vazando) | Se traces landam: exposição contínua do `META_APP_SECRET`+tokens a quem lê Grafana/Tempo |
| CRÍT-1 | **A5+A5b** (perda inbound) | ~6h | **Fraco** p/ consumer de app dedicado (bevox-direct); latente enquanto webhook aponta pro V1. Aceitar só com RPO explícito + monitor de gap de `meta_event_id` | Mensagem inbound do cliente perdida/não-entregue em cada failover; invisível |
| ALTO-2 | **N1+NN2** (pool→crash + workers sem Sentry) | ~1h + ~S | **Aceitável com nota** (recuperável por restart), mas barato — **recomendo fix** | Crash-loop/crash-duro em cada failover CNPG single-instance; outage breve coordenado |
| ALTO-3 | **NN3** (workers sem probe) | ~XS | **NÃO — fechar já** (singleton travado = outage silencioso) | Worker tok/cleanup/media morto sem restart, invisível |
| ALTO-4 | **N2/N3/N4/NN5-inv** (job lifecycle/double-send) | ~6-8h | **Aceitável com nota** se volume async baixo | Cliente recebe mensagem 2×; job preso (poll infinito); key queimada→500 pós-envio |
| ALTO-5 | **I2+NN1-inv** (idempotência sync + replay cross-tenant) | ~4-6h | **Aceitável p/ piloto** (1 consumer, key server-minted, 1 tenant) | Envio dobrado sob concorrência; **replay cross-tenant se ≥2 tenants** |
| ALTO-6 | **NN1-tenant** (firehose de inbound) | ~2h | **Aceitável** (1 tenant), tripwire no 2º | Vazamento de todo o stream inbound entre tenants do app |
| ALTO-7 | **undici CVE** (TLS bypass) | ~15min | **Aceitável tecnicamente, mas trivial — fechar** | Superfície TLS no cliente de toda chamada Meta |
| ALTO-8 | **register phone** | ~6h | **Só se o piloto NÃO onboardar número novo/migrado.** Confirmar com produto | 1º envio a número novo falha |
| ALTO-9 | **I8/N8** (audit) | ~5h | **Aceitável p/ piloto** (consumer confiável), **mas** é pré-req de MA-012 | Trilha 5a incompleta/forjável; CLI sem trilha; create sem `resourceId` |
| ALTO-10 | **SSRF** | ~4h | **Aceitável** (same-org; egress-NP bloqueia http/metadata) | Pivot SSRF **443-only** na rede k3s se consumer comprometido |
| ALTO-11 | **NN-1 hmac** (secret Meta global) | ~1-2d | **Aceitável** (1 Meta app) | 2º Meta app = webhooks 401 |
| ALTO-12 | **Contrato §3f + armadilha do guia** | ~2h | **Aceitável p/ piloto** (guide-first, sem codegen) **se** patchar o exemplo do guia + smoke obrigatório | Onboarding-via-spec (GA) 100% quebrado; engenheiro cai na armadilha do `...` |
| MÉDIO | **NN4** (Redis sem eviction) | ~S | **Setar `noeviction` já** (barato, remove footgun de data-loss) | writes falham em OOM; ou perda de job se `allkeys-lru` |
| gov | **lint vermelho + sem CI gate + 65 CVEs sem monitor** | ~5h | **Aceitável tecnicamente, mas é a causa-raiz histórica** — recomendo fechar | Regressão vermelha + CVE novo chegam à imagem de prod sem rede |
| CRÍT-3 | **MA-012** (jurídico) | eng ~7h + jurídico ~24h | **Decisão jurídica.** README: bevox-backend coberto por MSA → operação atual defensável; onboarding novo **NÃO** | Exposição regulatória; base legal minada por I8/N8/es-1 |

**Mínimo defensável para o piloto continuar:** fechar **NN1** (~15min) + **NN3** (~XS) + **N1/NN2** (~1.5h) + **undici bump** (~15min) + **NN4 `noeviction`** (~15min) + **rodar o gate de es-1** (traces no Grafana?) + **decisão explícita de aceite-de-risco sobre A5/A5b** (ou fix ~6h) — **~3-5h de engenharia** + a decisão jurídica MA-012 (fora de eng) + o gate diagnóstico. **GA** exige o resto + IG (tok-1/2) + register-phone + E2E real contra Meta sandbox + reconciliação de contrato + supply-chain gate.

---

## Itens-de-fechamento ordenados por valor/esforço (top 10)

| # | Item | Esforço | Destrava |
|---|------|---------|----------|
| 1 | **NN1** — reverter ordem de registro de hooks em `index.ts` (Fastify.close primeiro) | ~15min | Para o 500/reconexão espúria em **todo rollout** — melhor ROI |
| 2 | **NN3 + N1 + NN2** — `livenessProbe` nos 5 workers; `db/client.ts` loga em vez de `process.emit`; `initTelemetry()` nos workers | ~2h | Fecha outage silencioso de worker + crash-loop/duro em failover CNPG |
| 3 | **Supply chain** — bump `undici`≥8.5.0; remover `@fastify/jwt` morto; `pnpm audit --prod` no CI + Dependabot | ~1h | Fecha o CVE alcançável (TLS) + o crítico-morto + o gate ausente |
| 4 | **A5 + A5b** — persist+enqueue idempotentemente re-dirigível (uniqueIndex `meta_event_id` **E** re-drive de deliveries no caminho de duplicata; wrap do enqueue como media/publish) | ~6h | Bloqueador #1 de inbound (perda **e** sub-entrega) para consumer de app dedicado |
| 5 | **es-1** — SpanProcessor/hook undici que apaga `url.full`/`url.query` p/ hosts Meta (ou secrets p/ header/POST) + adicionar 4318 ao egress **junto** (fecha o defeito **e** restaura observabilidade) | ~4h | Fecha o CRÍTICO na origem, independente do estado do egress |
| 6 | **NN4 + N11 + NN5 + NN6** — Redis `--maxmemory`+`noeviction`+alerta; `commandTimeout`; cleanup de `webhook_deliveries`; OTLP endpoint em 1 lugar só | ~3h | Fecha data-loss de fila, hang de comando, crescimento ilimitado, regressão A18 |
| 7 | **Idempotência atômica (I2) + fim do double-send async (N2/N4/NN5-inv) + tenant na key (NN1-inv)** — reserva `SET NX`/insert-pendente; dedup pré-send; `onConflictDoUpdate` no worker; dobrar tenant na identidade da key | ~7h | Para envio dobrado sync/async **e** replay cross-tenant |
| 8 | **Durabilidade+integridade do audit (I8/N8) + firehose (NN1-tenant) + FK forjável (NN4-inv)** — audit síncrono no service p/ admin; validar `X-Tenant-Id`; scopar events firehose | ~6h | Fecha trilha forjável/incompleta (pré-req de MA-012) + maior superfície cross-tenant |
| 9 | **Governança de qualidade** — gate de CI (`typecheck`+`lint`+`test`+`audit` em PR) + lint verde (`queues.ts:174` + remover `.mjs`) | ~4h | Impede regressão vermelha **e** CVE novo na imagem de prod (causa-raiz histórica) |
| 10 | **Reconciliar contrato** (canon SoT: §3f, renomes, callback path, `delivery_mode`, events/ack header, versão) + **patchar exemplo do guia** + **MA-012 + RoPa OT-19** | ~2d + jurídico | Desbloqueia onboarding-via-spec (GA) + go-live legal + fecha a armadilha do guia |

---

## Dependências cruzadas

- **es-1 / observabilidade** → `k8s/configmap.yaml:50` seta 4318; a `NetworkPolicy` (enforçada pelo k3s default) **não** permite egress em 4318 → landing depende de: (a) collector no ns `monitoring` (out-of-band), **e** (b) egress realmente permitir 4318. **Gate diagnóstico:** traces no Tempo/Grafana. O fix de scrub (es-1) e o fix de egress (observabilidade) devem ir **juntos**.
- **MA-012 / DSR / imutabilidade+durabilidade do audit (I8/N8) / retenção** → advogado externo + RoPa **OT-19** (ADR-019/020). Os gaps I8/N8/es-1/redação **minam a base legal declarada em MA-012 §114** — a parte de engenharia é pré-requisito registral.
- **Contrato (§3f, renomes, drift repo↔canon, skill, armadilha do guia)** → PRs em `bevox-knowledge` (SoT por ADR-005; §8 "Parar — PR"). **Não mudar** `signing_secret`/`event_id`/formato HMAC `t=,v1=` do webhook-delivery sem coordenar com `bevox-backend`.
- **register de phone, ES/COEX, IG, MA-015 override** → dependem do Meta App **compartilhado "Bevox Solutions" (`<META_APP_ID>`)** + Meta App Review + smoke/e2e contra sandbox. O webhook a nível de app aponta pro V1/chat.example.com (memória) → a meta-api depende do override por-WABA (`subscribeWabaApp`, wired) + `OAUTH_CALLBACK_BASE_URL` (N7, **prod-mitigado** via configmap:44) + `META_WEBHOOK_VERIFY_TOKEN`. NN-1: secret global → 2º Meta app quebra.
- **A5/A5b, N1-N4, NN1-NN4, durabilidade do audit, infra-4** → **compõem no mesmo gatilho** (blip de Postgres/Redis, rollout). A decisão de infra (aceitar single-node com RPO explícito **ou** adicionar réplica CNPG/Redis) é a de **maior alavancagem** — muda o *quando* de todos.
- **Supply chain (65 CVEs)** → sobe com o freeze; sem Dependabot/CI gate. `undici`/`@hapi/wreck` são alcançáveis; o resto DoS-class de baixa controlabilidade.
- **MA-016 (analytics)** → bloqueia sub-projeto **Cleanup** da migração **bevox-direct**, não o piloto. **MA-015** → já em prod, ADR a carimbar.

---

## Delta vs auditoria anterior (2026-07-21)

**Código:** BYTE-IDÊNTICO (src/db; k8s frozen em `5516c2a`, 30 dias). Logo:

- **FIXED: 0.** Nada fechou por engenharia (6ª consecutiva). Ground-truth idêntico (typecheck verde, lint vermelho 6, 443/443).
- **SURVIVES: ~todos.** 6ª equipe independente re-derivando do código: anchors CRÍTICO/ALTO resolvem na linha citada, **0 refutado, 0 drift**. A5 downgrade **re-refutado**. Placar das 11 invariantes consistente.
- **REBALANCEAMENTO material:** **es-1 sai de "CRÍTICO-vivo-em-prod" (07-21) para "CRÍTICO-no-código, provavelmente-INERTE-em-prod"** — via cross-referência inédita da `NetworkPolicy` (egress omite 4318, k3s enforça NP) + corolário net-new (observabilidade de prod provavelmente quebrada). É o inverso da elevação de 07-21, com base em evidência de manifesto.
- **NET-NEW verificado (17 itens):** **NN1** (shutdown invertido, ALTO, todo deploy), **NN2** (workers sem Sentry/OTel, ALTO), **NN3** (workers sem probes, ALTO), **NN4** (Redis sem eviction → data-loss, MÉDIO-ALTO), **NN5** (cleanup skip `webhook_deliveries`), **NN6** (OTLP configmap/secret collision), **NN1-inv** (replay cross-tenant de idempotência, HIGH), **NN4-inv** (audit FK forjável), **NN5-inv** (failed-send queima key), **NN1-tenant** (firehose de inbound, ALTO), **NN2-tenant** (disconnect sem tenant), **NN2-hmac** (replay event_type mislabel), **NN4-hmac** (sem audit em reject), **N1-secrets** (label 404 cardinalidade), **es-1 corolário** (traces dropados no egress), **CVE scan** (65 vulns — 1 crítica-morta, 26 altas), **armadilha do guia §3f** (exemplo truncado).
- **CORREÇÕES ao corpus: 4.** (a) **N8 mais fraco** — o path admin **canônico** é HTTP (audited); o CLI (desencorajado) é o sem-trilha; (b) **es-1 escopo** — só o processo API é sink OTel (workers não); (c) **labels** — a correção "rule-compliant" de 07-21 tem buraco no path 404; (d) **N7 prod-mitigado** — `configmap.yaml:44` seta `OAUTH_CALLBACK_BASE_URL` (latente, não live).
- **Saldo:** o alvo não se moveu por 43 dias e 6 auditorias. O ganho líquido desta é **(1)** o **rebalanceamento de es-1** por evidência de manifesto (rebaixa a exposição de prod, sobe uma questão de observabilidade); **(2)** o **cluster net-new worker/infra** (NN1-NN4) que reposiciona a superfície worker/rollout como a mais frágil e mais barata de fechar; **(3)** a **1ª varredura de CVE** e a tese "freeze não é neutro"; **(4)** achados net-new de tenancy/idempotência (replay cross-tenant, firehose); **(5)** 4 correções factuais; e **(6)** o **Ledger de Decisão atualizado**. **A tese de 07-21 aperta: o gargalo é decisório, e o custo de não decidir compõe.**

---

## Notas de método

**Calibração.** Como em 07-17/19/20/21, esta passada reconheceu o **código congelado**: re-descoberta do zero tem valor marginal ~nulo. O foco foi **(a)** ground-truth em primeira mão **incluindo `pnpm audit` (net-new)**; **(b)** 6ª verificação independente dos anchors de maior severidade **com mandato de refutar**; **(c)** net-new dirigido a superfícies sub-cobertas (**supply chain, Dockerfile, egress de k8s, ciclo de vida de shutdown**); **(d)** síntese **decisória** (Ledger).

**Orquestração.** Fan-out via **Agent tool**, read-only, 6 agentes via `subagent_type` (`secrets-redaction-auditor`, `webhook-hmac-auditor`, `invariants-auditor`, `tenant-scope-auditor`, `contract-guardian`, `general-purpose` completeness-critic), cada um instruído a **re-derivar do CÓDIGO**, retornar CONFIRMED/REFUTED/DRIFTED com `file:linha` atual, **tentar refutar** os anchors de 07-21, caçar net-new default-cético, e propor aceite-de-risco. Verificação adversarial dos candidatos de maior severidade (es-1 chain, A5, NP/egress, fast-jwt reachability, N8) feita pelo **orquestrador via leitura direta** — não delegada.

**Leitura direta [orq]** (HEAD 03c1af6, Node v22.23.1): `telemetry.ts` (íntegro — OTel init + scrubber só-Sentry), `auth-jwt-consumer.ts` + `auth-admin.ts` (jose, algoritmo travado → fast-jwt não-alcançável), `audit-log.ts` + `apps/routes.ts` (correção N8), `k8s/configmap.yaml`+`secret.yaml`+`networkpolicy.yaml`+`pdb.yaml`+`deployment-api.yaml`+`deployment-workers.yaml`+`observability/` (es-1 chain, egress/4318, sem manifesto de collector, PDBs parciais), `Dockerfile` (dev-deps no runtime, tsx, non-root), MA-012 + ADR-020 (canon, legal-basis minada), go-live plan §0-§1 (gotchas, app `<META_APP_ID>`, CLI quebrado→HTTP), runtime-topology (canon). Executado: `pnpm typecheck` VERDE, `pnpm lint` VERMELHO (6), `pnpm test` **443/443**, `pnpm audit` **65 vulns**.

**Limitações.** (a) **es-1/observabilidade landing não confirmado em runtime** — sem acesso a prod nesta sessão; a análise egress/NP é **prova estática forte** mas o cluster vivo pode ter regra out-of-band, ingress em 443, ou `--disable-network-policy`. O **gate diagnóstico** (traces no Tempo/Grafana?) fecha a última milha e **não** foi executado (exige SSH a prod — fora do escopo autônomo desta sessão; deixado p/ a revisão humana). (b) `test:integration`/`test:e2e` não re-executados (byte-idêntico). (c) `repository.ts` segue 0% unit — scoping (I3) verificado só por leitura estática. (d) Consumer guide + go-live-checklist **não existem no repo** (só no canon) — usou-se a versão canônica. (e) ADRs MA-001..MA-014 vivem no canon; só MA-015/016 estão em `docs/adr/` (ambos `Proposta`). (f) `pnpm audit` reflete o snapshot de advisories de hoje — o número **sobe** sozinho com o freeze.

**Restrição respeitada:** nenhum arquivo de produto foi modificado — este relatório é o único artefato produzido.
