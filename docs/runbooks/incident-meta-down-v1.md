# Incident — Meta APIs Upstream Unavailable — V1

**Status:** ativo
**Última atualização:** 2026-05-20
**Owner (mantém doc):** SRE rotation (quarterly review per [`incident-response-playbook-v1.md`](./incident-response-playbook-v1.md) §8)
**Executor (durante incident):** oncall (PagerDuty rotation) + IC declarado per [`incident-response-playbook-v1.md`](./incident-response-playbook-v1.md) §2.
**Severidade:** CONDITIONAL — **P2** (latency-only, Meta p99 > 5s por 15min per Go-Live Checklist V1 §4:73) / **P1** (HTTP 5xx outage em outbound per checklist §4:72 OR todos consumers impactados).
**Tempo estimado de resolução:** depende-de-Meta (15min–vários horas; bevox-meta-api é downstream consumer e NÃO pode acelerar fix Meta-side).
**Última revisão exercitada em staging:** 2026-05-20 (initial publish; tabletop drill agendar dentro 30d).
**Próxima revisão programada:** 2026-08-20 (quarterly).

## 0. Prerequisites / Access

Mesmos prerequisites do entry-point process — ver [`incident-response-playbook-v1.md`](./incident-response-playbook-v1.md) §0 (Vault profile, kubectl context, Grafana role, PagerDuty, Slack channels, status page admin).

Adicional específico desta runbook:
- Acesso ao **Meta Developer status page** (https://metastatus.com) para confirmar outage upstream.
- Acesso a Twitter/X para acompanhar `@Meta` / `@MetaforDevelopers` outage acknowledgments (heuristic, não SoT).
- (Se outage > 2h) Contato comercial Meta business support / account manager — `<PLACEHOLDER-META-ACCOUNT-MANAGER-CONTACT>`.

Se faltar qualquer prerequisite → escalar imediatamente per [`incident-response-playbook-v1.md`](./incident-response-playbook-v1.md#5-escalation-matrix) (P-bump possível durante espera).

## 1. Trigger / Symptom

Esta runbook dispara quando bevox-meta-api detecta degradação ou indisponibilidade do upstream Meta (Graph API v22.0). Triggers concretos:

- **Alert Grafana / PagerDuty:** `Meta latency p99 > 5s por 15min` (per Go-Live Checklist V1 §4:73 → P2 default).
- **Alert Grafana / PagerDuty:** `HTTP 5xx rate > 5%` em outbound contra Graph API (per checklist §4:72 → P1).
- **Status page Meta confirma outage:** https://metastatus.com mostra incident ativo em "WhatsApp Business Platform" ou "Graph API".
- **Spike correlacionado:** múltiplos `waba.connection_changed` events com `status=disconnected` firing simultaneous para tenants distintos (cross-link [`waba-disconnect-recovery-v1.md`](./waba-disconnect-recovery-v1.md) §1) — heurística forte de outage upstream, NÃO problema por-tenant.
- **Consumer support escalation:** múltiplos consumers reportando "mensagens não enviam" sem mudança recente client-side.

Se trigger é único tenant isolado, NÃO é esta runbook — usar [`waba-disconnect-recovery-v1.md`](./waba-disconnect-recovery-v1.md) ou [`token-refresh-v1.md`](./token-refresh-v1.md).

## 2. Diagnosis (triage)

Confirmar que o symptom é Meta-side (não bug interno):

1. **Probe direto Graph API** a partir de um worker pod (medir latência + status):
   ```bash
   kubectl exec -n bevox-meta-api -l app=worker-out -- \
     curl -sS -o /dev/null -w "%{http_code} %{time_total}\n" \
       -I https://graph.facebook.com/v22.0/me
   ```
   Esperado em outage: 5xx, timeout, ou tempo > 5s sustentado.

2. **Métrica de erro Meta** (per Drift 11 — `meta_client_error_total` NÃO existe; derive do histogram count com label `outcome="error"` em `src/lib/metrics.ts:43`):
   ```promql
   sum(rate(bevox_meta_api_meta_request_duration_seconds_count{outcome="error"}[5m]))
     /
   sum(rate(bevox_meta_api_meta_request_duration_seconds_count[5m]))
   ```
   Outage: razão sobe > 0.5 sustentado. Latência p99 via mesma família:
   ```promql
   histogram_quantile(0.99, sum(rate(bevox_meta_api_meta_request_duration_seconds_bucket[5m])) by (le))
   ```

3. **Cross-check status page externo** (Meta Developer status page + Twitter/X `@Meta`). Outage acknowledgment Meta-side confirma escopo.

4. **Confirmar scope interno:** quantos tenants/consumers impactados via logs:
   ```bash
   kubectl logs -n bevox-meta-api -l app=worker-out --tail=2000 \
     | grep -E "META_UNAVAILABLE|RATE_LIMITED|status=5[0-9]{2}"
   ```
   Se errors distribuídos em todos os WABAs → outage upstream confirmed. Se errors em 1 WABA isolado → re-classify para [`waba-disconnect-recovery-v1.md`](./waba-disconnect-recovery-v1.md).

5. **Queue depth** (esperado swell durante outage; per `src/lib/metrics.ts:55`):
   ```promql
   bevox_meta_api_queue_size{queue="outbound"}
   ```

## 3. Remediation

**NÃO TENTAR REMEDIAR META-SIDE.** bevox-meta-api é downstream consumer e NÃO pode acelerar fix Meta-side. A remediation desta runbook é **defensiva** — proteger queue + consumers + comunicação.

### 3.1 Confirmar retry/backoff ativada

Outbound jobs com `META_UNAVAILABLE` ou `RATE_LIMITED` são re-throwed em `src/workers/outbound-dispatcher.ts:112` para que BullMQ aplique backoff exponencial (per MA-005 retry-exp policy). Confirmar:

```bash
kubectl logs -n bevox-meta-api -l app=worker-out --tail=500 \
  | grep -E "Re-throw para que BullMQ|status=\"queued\""
```

Esperado: jobs voltam a `status=queued` com `lastError` preenchido; BullMQ reprocessa com backoff. **NÃO há circuit breaker implementado em `meta-client.ts`** — o pattern atual é retry/backoff na fila (per spec §12 Drift 10; FUTURE V2 candidate em risks). Se logs mostram que jobs estão `status=failed` em vez de `queued`, é bug — abrir issue + escalate per §5.

### 3.2 Aceitar queue depth swell

`bevox_meta_api_queue_size{queue="outbound"}` vai crescer durante outage — comportamento esperado. **NÃO drenar manualmente**, **NÃO mover para dead-letter**: jobs reprocessam quando Meta volta. Monitor depth via Grafana e estimar drain time (~throughput pós-recovery × backlog).

Se queue depth aproxima limite de BullMQ memory (Redis OOM risk), escalate per §5 — considerar pausar enqueue de novos jobs como medida temporária (founder go required).

### 3.3 Notificar consumers (comunicação externa)

- **Status page bevox-meta-api:** post inicial em `<PLACEHOLDER-STATUS-PAGE-URL>` indicando "upstream Meta degraded — outbound paused/retried" (IC approves draft). Per [`incident-response-playbook-v1.md`](./incident-response-playbook-v1.md#5-escalation-matrix) §5 Communication block — P1 imediato, P2 se > 30min.
- **Slack `#engineering`** + `<PLACEHOLDER-CONSUMER-SLACK-CHANNEL>` cross-post para customer-comm awareness.
- **Customer email blast:** P0/P1 only, executado por customer-comm team com IC approval. Conteúdo: scope (WhatsApp outbound), root cause externa (Meta), workaround N/A (downstream).

### 3.4 Engage Meta business support (outages prolongadas)

Se outage > 2h sem resolution path público, IC contata `<PLACEHOLDER-META-ACCOUNT-MANAGER-CONTACT>` para abrir ticket business support. Anexar: timestamps + escopo + Graph API endpoints afetados + correlation IDs (X-FB-Trace-ID se Meta retornou em headers).

## 4. Verification (incident closed criteria)

Esta runbook NÃO declara incident closed sozinha — segue critérios gerais de [`incident-response-playbook-v1.md`](./incident-response-playbook-v1.md) §4 plus o seguinte específico:

- **Meta latency p99 < 1s sustentado por 15min** (via `bevox_meta_api_meta_request_duration_seconds`):
  ```promql
  histogram_quantile(0.99, sum(rate(bevox_meta_api_meta_request_duration_seconds_bucket[5m])) by (le)) < 1
  ```
- **Outbound 200s resumem** (taxa de erro < 1%):
  ```promql
  sum(rate(bevox_meta_api_meta_request_duration_seconds_count{outcome="error"}[5m]))
    /
  sum(rate(bevox_meta_api_meta_request_duration_seconds_count[5m])) < 0.01
  ```
- **Queue depth drena** (`bevox_meta_api_queue_size{queue="outbound"}` retorna a baseline pré-incident) dentro de SLA (~1h post-recovery, dependendo de backlog).
- **Sem novos `waba.connection_changed` com `status=disconnected`** correlacionados ao outage window.
- **Status page atualizado para "resolved"** + Slack `#engineering` notification de closure.
- **Postmortem agendado dentro de 24h** per [`incident-response-playbook-v1.md`](./incident-response-playbook-v1.md#7-postmortem-template).

## 5. Escalation

Referência canônica: [`incident-response-playbook-v1.md`](./incident-response-playbook-v1.md#5-escalation-matrix) (P0/P1/P2/P3 matrix + page mechanism + channel naming + communication block).

Específicos desta runbook:
- **Start P1** se trigger é HTTP 5xx outage (checklist §4:72) OU todos consumers impactados — não aguardar bump.
- **P2 → P1 bump** se outage prolonga > 30min e queue depth cresce > 10x baseline OR > 5 consumers reportam impacto.
- **P1 → P0 bump** se data loss detectado (jobs `failed` sem retry, perda de eventos não-replicáveis) — engage DPO per ANPD-72h clock.
- **Outage > 2h sem ETA Meta pública** → engage Meta business support (account manager); manter consumers atualizados a cada 60min via status page.
- **Cross-runbook:** se ≥5 tenants `waba.connection_changed disconnected` simultaneous correlacionados ao outage window, vincular [`waba-disconnect-recovery-v1.md`](./waba-disconnect-recovery-v1.md) — recovery individual de tenant **após** Meta voltar.

## 6. Rollback

N/A. NÃO existe rollback aplicável — bevox-meta-api é downstream consumer e NÃO controla Meta. Operações defensivas em §3 (retry/backoff aceito + queue swell aceito + comunicação) não precisam de rollback: backoff é idempotente, queue se auto-drena, status page é desfazível por post-update.

Se durante incident o oncall executar mudança operacional adicional (ex: pausar enqueue temporariamente), o rollback é simétrico: resume enqueue. Documentar em postmortem.

## 7. Postmortem

Template canônico: [`incident-response-playbook-v1.md`](./incident-response-playbook-v1.md#7-postmortem-template) (Impact + Timeline UTC + External comm + Root cause + Remediation + What went well + Cost + Action items).

Artefatos específicos para anexar nesta runbook:
- **Meta status page snapshot** (screenshot ou archived URL) durante o outage window — confirma scope e timing externo.
- **Outage duration externa vs internal detection lag** (alert fired – page acked – IC declared) para calibrar MTTD em alerts §4:72/73.
- **Queue-drain timeline** pós-recovery (`bevox_meta_api_queue_size{queue="outbound"}` graph) + tempo até retorno a baseline.
- **Consumer-impact survey** (quantos consumers + quantos jobs afetados + houve data loss? — input para LGPD assessment se P0).
- **Meta correlation IDs** coletados durante diagnosis (X-FB-Trace-ID headers) para business support follow-up.
- **Action items prováveis:** (a) circuit breaker FUTURE em `meta-client.ts` (V2 candidate per spec §10 risks), (b) `bevox_meta_api_meta_error_total{code}` metric dedicada (Drift 11 — atualmente derive via histogram count), (c) alerta dedicado para queue depth saturation.

## Referencias

- Spec: `docs/superpowers/specs/2026-05-20-bevox-meta-api-runbooks-v1-design.md` (hub `d1a9369`).
- Plan: `docs/superpowers/plans/2026-05-20-bevox-meta-api-runbooks-v1-plan.md` (hub).
- Foundational runbook: [`incident-response-playbook-v1.md`](./incident-response-playbook-v1.md) (process + escalation matrix + postmortem template).
- Cross-runbook: [`waba-disconnect-recovery-v1.md`](./waba-disconnect-recovery-v1.md) (recovery por-tenant pós-Meta).
- PRD V1: `prds/bevox-meta-api-prd-v1.md` §13 (Observabilidade — Meta latency alert).
- ADRs: MA-005 (retry-exp policy webhook + outbound), MA-007 (observabilidade).
- Go-Live Checklist V1: `40_roadmap/bevox-meta-api/2026-04-25-bevox-meta-api-go-live-checklist-v1.md` §4:72 (HTTP 5xx outage → P1) + §4:73 (latency p99 > 5s → P2).
- Código autoritativo: `src/workers/outbound-dispatcher.ts:112` (retry/backoff — re-throw para BullMQ backoff; NÃO circuit breaker per Drift 10), `src/lib/metrics.ts:43` (`bevox_meta_api_meta_request_duration_seconds` histogram com label `outcome`), `src/lib/metrics.ts:55` (`bevox_meta_api_queue_size` gauge).
