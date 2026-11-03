# Dead-letter Replay — V1

**Status:** ativo
**Última atualização:** 2026-05-20
**Owner (mantém doc):** SRE rotation (quarterly review per [`incident-response-playbook-v1.md`](./incident-response-playbook-v1.md) §8).
**Executor (durante incident):** oncall (IC pode handoff a engineer de plantão de webhook delivery).
**Severidade:** P2 default (per Go-Live Checklist V1 §4:74 — dead-letter total crescendo). P3 se replay foi consumer-requested sem real service degradation (ticket queue cadence).
**Tempo estimado de resolução:** 15-60min (triage 5-15min + replay 10-45min).
**Próxima revisão programada:** 2026-08-20 (quarterly).

## 0. Prerequisites / Access

Antes de iniciar replay, o executor precisa de:
- Vault profile: `<PLACEHOLDER-VAULT-PROFILE-BEVOX-META-API>` (admin tokens para CLI + DB credentials).
- kubectl context: `<PLACEHOLDER-K8S-CONTEXT-PROD>` (cluster prod; logs + admin-CLI exec).
- Grafana role: `<PLACEHOLDER-GRAFANA-ROLE-BEVOX-META-API>` (PromQL derivation; ver §4).
- SQL access read+write em `webhook_deliveries` via admin policy (Cenário B requer `UPDATE … SET status='wontfix'`). Read-only em `webhook_subscriptions` (consultar estado).
- Acesso ao admin-CLI: rodar `pnpm cli` dentro de pod api ou de host com credentials prod (per `scripts/admin-cli/index.ts:118`).

Se faltar prerequisite → escalar per [`incident-response-playbook-v1.md`](./incident-response-playbook-v1.md)#5-escalation-matrix.

## 1. Trigger / Symptom

Este runbook dispara quando:
- Alert Grafana `dead-letter total crescendo` (per PRD V1 §13 + Go-Live Checklist V1 §4:74 → P2 default).
- Consumer admin abre support ticket "evento perdido / não recebi `message.received`" (sub-case P3 — replay consumer-requested sem degradation real).
- Scheduled audit periódico de dead-letter queue (sub-case P3 — housekeeping).
- Cross-runbook reference de [`incident-response-playbook-v1.md`](./incident-response-playbook-v1.md) §3 (entry-point process).

Sintomas observáveis:
- `webhook_deliveries WHERE status='dead_letter'` row count cresce além baseline.
- Consumer reports queda em event ack rate (consumer-side metric).
- Bursts de `last_error` semelhantes (mesmo HTTP status, mesma URL, mesmo subscription_id) sugerem failure mode unificado.

## 2. Diagnosis (triage)

Triage SQL queries (per spec §12 Drift 9 — tabela real é `webhook_deliveries WHERE status='dead_letter'`, NÃO `dead_letter_events`; subscription state em `webhook_subscriptions`, NÃO `subscriptions`):

```sql
-- Counts por subscription (top 20 candidatos para replay).
SELECT subscription_id, COUNT(*) AS dead_letter_count
FROM webhook_deliveries
WHERE status = 'dead_letter'
GROUP BY subscription_id
ORDER BY dead_letter_count DESC
LIMIT 20;

-- Breakdown de failure mode (drives Cenário A vs B vs C).
SELECT last_error, COUNT(*) AS occurrences
FROM webhook_deliveries
WHERE status = 'dead_letter'
GROUP BY last_error
ORDER BY occurrences DESC;

-- Cross-ref subscription state (status + URL + last_delivery_at).
SELECT id, app_id, status, url, last_delivery_at
FROM webhook_subscriptions
WHERE id = '<subscription_id>';
```

Logs Pino para validar últimas tentativas:

```bash
kubectl logs -n bevox-meta-api -l app=worker-webhook --tail=1000 \
  | grep -E "dead_letter|delivery_failed" | head -50
```

Classificar `last_error`:
- HTTP 5xx / connection refused / timeout → **Cenário A** (endpoint down + agora back).
- HTTP 401 / signature mismatch → **Cenário B** (signing_secret rotated consumer-side).
- HTTP 4xx body validation / schema_version mismatch → **Cenário C** (payload schema drift).

## 3. Remediation

Três cenários canonical. Confirme classificação em §2 antes de executar; se mixed-mode (vários `last_error` distintos), executar replay incremental por subscription.

### Cenário A — Consumer endpoint temporariamente down + agora back

Comando real (per `scripts/admin-cli/index.ts:118`):

```bash
# Dry-run primeiro (NÃO muta — imprime o que faria).
pnpm cli dead-letter replay --subscription-id <subscription_id> --dry-run

# Replay efetivo após dry-run conferido.
pnpm cli dead-letter replay --subscription-id <subscription_id>
```

Equivalente HTTP via admin endpoint (per `src/modules/webhooks/routes.ts:57-59`):

```bash
curl -X POST \
  -H "Authorization: Bearer <admin_jwt>" \
  https://meta-api.example.com/admin/subscriptions/<subscription_id>/replay
```

Verificar replay attempt count cresce (re-rodar query §2; rows devem deixar `status='dead_letter'` conforme worker reprocessa).

### Cenário B — Consumer signing_secret rotated client-side (HMAC mismatch)

Quando consumer rotaciona seu signing_secret sem coordenar, todas as deliveries em-vôo falham HMAC. O consumer DEVE re-registrar a subscription (nova subscription = novo signing_secret server-side). Dead-letters antigas, assinadas com o secret antigo, NÃO podem ser entregues; marcá-las como `wontfix` para sair da fila.

> **NOTA:** NÃO existe `pnpm cli dead-letter ack` (per spec §12 Drift 8 — comando fictitious). Ack-equivalent é SQL UPDATE direto.

```sql
-- Marcar dead-letters antigas como wontfix (assinatura nunca vai bater).
UPDATE webhook_deliveries
SET status = 'wontfix'
WHERE subscription_id = $1
  AND status = 'dead_letter';
```

Sequência operacional:
1. Confirmar com consumer (ticket ou Slack) que o rotation foi intencional.
2. Consumer cria nova subscription via API (recebe novo signing_secret).
3. Rodar o UPDATE acima na subscription antiga.
4. Opcionalmente, desativar subscription antiga (`pnpm cli apps deactivate-subscription` se aplicável; senão SQL `UPDATE webhook_subscriptions SET status='disabled'`).

### Cenário C — Payload schema-version drift (forward-compat unsupported)

Consumer rejeita schema version >= N que ainda não suporta. Duas vias:

- **C.1 — Consumer atualiza primeiro:** consumer deploya update que aceita o schema. Em seguida, executar replay via Cenário A.
- **C.2 — Marcar wontfix (consumer não vai atualizar):** consumer confirma desinteresse; aplicar SQL UPDATE do Cenário B (mesmo statement, mesmo critério).

Em ambos os casos, registrar no postmortem qual schema_version causou o drift — input para future-compat policy V2.

## 4. Verification

Após remediation, verificar:

- **Dead-letter row count decrementa.** Re-rodar SQL §2 (`SELECT … COUNT(*) … WHERE status='dead_letter' GROUP BY subscription_id`); a subscription tratada deve sair do top-N ou zerar.
- **Consumer-side ack.** Consumer confirma recebimento dos events replayed (consumer-side metric ou ticket update).
- **Success ratio retorna ao baseline.** NÃO existe metric `webhook_delivery_success_rate` (per spec §12 Drift 11). Derivar via PromQL no Grafana:

  ```
  sum(rate(bevox_meta_api_webhook_delivery_total{outcome="success"}[5m]))
    / sum(rate(bevox_meta_api_webhook_delivery_total[5m]))
  ```

  Esperado: ≥0.95 sustained 15min post-replay (baseline V1).
- **Alert `dead-letter total crescendo` clears** em Grafana após observação ≥15min (per [`incident-response-playbook-v1.md`](./incident-response-playbook-v1.md) §4 — 15min observation post-fix).

## 5. Escalation

Reference [`incident-response-playbook-v1.md`](./incident-response-playbook-v1.md)#5-escalation-matrix para matriz canônica P0/P1/P2/P3 + channel naming + page mechanism.

Runbook-specific:
- **Bump P2 → P1** se ≥1000 events por subscription dead-lettered OR ≥10 subscriptions afetadas simultaneamente (suspeita de bug server-side no worker de delivery; engage CTO).
- **Bump P2 → P0** se inspeção do `last_error` revelar exposure de PII em log payload (LGPD ANPD-72h clock conforme [`incident-response-playbook-v1.md`](./incident-response-playbook-v1.md)#5-escalation-matrix; engage DPO).
- **Stay P3** se o replay foi consumer-requested isolado (1 subscription, < 100 events, sem degradation observada em alert).

## 6. Rollback

N/A. Replay é additive — re-entrega events sem mutar payload original. Replays falhos voltam para `status='dead_letter'` automaticamente (retry policy MA-005 linhas 99-101). Não há estado novo a reverter.

Em Cenário B/C, o `UPDATE … SET status='wontfix'` é semanticamente uma marcação de queue (não destrutiva: row persiste para audit). Se aplicada por engano, reverter via:

```sql
UPDATE webhook_deliveries
SET status = 'dead_letter'
WHERE subscription_id = $1
  AND status = 'wontfix'
  AND last_attempt_at > NOW() - INTERVAL '1 hour';
```

Em seguida re-avaliar conforme §2.

## 7. Postmortem

Reference [`incident-response-playbook-v1.md`](./incident-response-playbook-v1.md)#7-postmortem-template para template canônico (Detection lag + External communication timeline + What went well + Cost + Action items).

Runbook-specific artifacts a anexar:
- Sample (≤20 rows) de `webhook_deliveries` rows tratadas, com `last_error` + `subscription_id` + timestamps.
- Consumer ack rate timeline (consumer-side metric, se disponível) durante janela do incident.
- Audit log dos comandos admin-CLI executados (quem, quando, qual subscription_id) — ler do shell history do pod ou audit central.
- Breakdown final por cenário (quantos events resolvidos via A vs B vs C).
- Se Cenário C: anotar `schema_version` envolvida — input para forward-compat policy V2.

## Referencias

- Spec: `docs/superpowers/specs/2026-05-20-bevox-meta-api-runbooks-v1-design.md` (hub `d1a9369`).
- PRD V1: `prds/bevox-meta-api-prd-v1.md` §13 (Observabilidade — alert dead-letter total).
- ADRs: MA-005 (webhook delivery + retry policy, linhas 99-101), MA-007 (observabilidade).
- Go-Live Checklist V1: `40_roadmap/bevox-meta-api/2026-04-25-bevox-meta-api-go-live-checklist-v1.md` §4:74 (P2 default).
- Código autoritativo:
  - CLI: `scripts/admin-cli/index.ts:118` (`pnpm cli dead-letter replay`).
  - Admin endpoint: `src/modules/webhooks/routes.ts:57-59` (`POST /admin/subscriptions/:id/replay`).
  - Schema: `db/schema/operations.ts:108` (`webhookSubscriptions`), `db/schema/operations.ts:144` (`webhookDeliveries`).
- Foundational: [`incident-response-playbook-v1.md`](./incident-response-playbook-v1.md) (escalation matrix, postmortem template, quarterly review).
- Última revisão exercitada em staging: 2026-05-20 (initial publish; tabletop drill agendar dentro 30d).
- Próxima revisão programada: 2026-08-20 (quarterly).
