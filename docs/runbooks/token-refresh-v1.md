# Token Refresh — V1

**Status:** ativo
**Última atualização:** 2026-05-20
**Owner (mantém doc):** SRE rotation (quarterly review per `incident-response-playbook-v1.md#8-quarterly-review-process`)
**Executor (durante incident):** oncall rotation (PagerDuty)
**Severidade:** P2 default (1 tenant impactado) / P1 se ≥10 tenants disconnect simultaneous
**Tempo estimado de resolução:** 30-90min
**Próxima revisão programada:** 2026-08-20 (quarterly).

## 0. Prerequisites / Access

Antes de iniciar este runbook, oncall precisa de:

- Vault profile: `<PLACEHOLDER-VAULT-PROFILE-BEVOX-META-API>` (acesso a secrets `bevox-meta-api/*`, incluindo KEK `waba-tokens/v1`).
- kubectl context: `<PLACEHOLDER-K8S-CONTEXT-PROD>` (cluster prod, namespace `bevox-meta-api`).
- Grafana role: `<PLACEHOLDER-GRAFANA-ROLE-BEVOX-META-API>` (dashboards `token-refresh` + `meta-api-overview`).
- KMS console access: `<PLACEHOLDER-KMS-CONSOLE-WABA-TOKENS>` (apenas para Cenário C — KEK decrypt failure).
- PagerDuty access: `<PLACEHOLDER-PAGERDUTY-SERVICE>` (service bevox-meta-api; ack + escalation).
- SQL read access: `<PLACEHOLDER-DB-RO-PROFILE>` (read-only role em DB prod).

Se faltar qualquer prerequisite → **NÃO iniciar runbook**. Escalar imediatamente via `incident-response-playbook-v1.md#5-escalation-matrix` para obter access (potential P-bump devido tempo de espera).

## 1. Trigger / Symptom

Este runbook é disparado quando:

- **PagerDuty alert** `Token refresh outcome=disconnected` (Go-Live Checklist V1 §4:76 → P2 default).
- **Sintomas observáveis:**
  - Outbound 401 from Meta em tenants específicos (logs api Pod com `META_REJECTED` ou `META_UNAUTHORIZED` errors).
  - Consumer reports de eventos `waba.connection_changed` com `status=disconnected` chegando inesperadamente.
  - Worker `worker-token-refresh` logging refresh failures repetitive para mesmo `waba_connection_id`.
- **Metric authoritative:**
  - `bevox_meta_api_token_refresh_total{outcome=disconnected}` crescendo (per `src/lib/metrics.ts:77`; label `outcome` per linha 79 — values `refreshed | failed | disconnected`).
  - Cross-ref `bevox_meta_api_token_refresh_total{outcome=failed}` para distinguir transient retries vs hard disconnect.

Cross-runbook: se ≥10 tenants disconnect simultâneos, suspeitar Meta API outage e cruzar com `incident-meta-down-v1.md`.

## 2. Diagnosis

Ordem dos comandos do mais barato (logs) para o mais caro (KMS console manual decrypt).

### 2.1 Worker logs

```bash
kubectl logs -n bevox-meta-api -l app=worker-token-refresh --tail=500 \
  | grep -E "refresh.*fail|disconnect|META_(REJECTED|UNAUTHORIZED)"
```

Expected: linhas com `waba_connection_id=<uuid>` + error reason (Meta error code, KMS decrypt error, network timeout).

### 2.2 DB state via JOIN `waba_connections ⋈ waba_tokens`

Disconnect state NÃO vive em `tenants` table — vive em `waba_connections.disconnected_at` + `waba_tokens.refresh_at` (per `db/schema/bindings.ts:54` + `:84`).

```sql
SELECT
  wc.id              AS waba_connection_id,
  wc.tenant_id,
  wc.meta_waba_id,
  wc.disconnected_at,
  wt.refresh_at      AS last_refresh_at
FROM waba_connections wc
LEFT JOIN waba_tokens wt ON wc.id = wt.waba_connection_id
WHERE wc.disconnected_at IS NOT NULL
ORDER BY wc.disconnected_at DESC
LIMIT 20;
```

Expected: lista de connections recém-disconnectadas. Se `wt.refresh_at` é NULL ou stale (>30d), tokens nunca refreshed ou worker está atrás.

### 2.3 Counter de cleanup deletions (correlacionar com KMS rotation)

```promql
bevox_meta_api_cleanup_deleted_total{table="waba_tokens"}
```

Se rate spike imediatamente antes do alert disconnect, suspeitar KEK rotation que deletou rows não-decryptable → Cenário C abaixo.

### 2.4 Decision tree

| Sinal                                                                    | Cenário likely     |
|--------------------------------------------------------------------------|--------------------|
| Worker pods em CrashLoopBackOff OU sem logs recentes                     | A (worker crash)   |
| Meta retorna 401 reproduzível via curl direto com decrypted token        | B (Meta-side)      |
| KMS decrypt errors em logs OR `cleanup_deleted_total` spike correlacionado| C (KMS/KEK issue) |

## 3. Remediation

Três cenários — escolher conforme decision tree §2.4.

### Cenário A — Worker crash / não está consumindo

Worker `worker-token-refresh` parou de processar (deploy bug, OOM, panic).

```bash
kubectl rollout restart deployment/worker-token-refresh -n bevox-meta-api
kubectl rollout status  deployment/worker-token-refresh -n bevox-meta-api --timeout=120s
```

Expected: novo Pod Ready em ≤2min. Monitorar logs por 5min para garantir nenhum CrashLoopBackOff:

```bash
kubectl logs -n bevox-meta-api -l app=worker-token-refresh -f --tail=50
```

> **NOTE:** rascunhos antigos referenciavam um comando admin-CLI no namespace `tenants` para refresh manual. Esse namespace **NÃO existe** em `scripts/admin-cli/index.ts` — apenas namespaces `apps` e `dead-letter` estão implementados. Refresh manual hoje é via worker restart acima; expansão admin-CLI para refresh por tenant é FUTURE V2 (out-of-scope V1 per spec §9).

### Cenário B — WABA disconnectado Meta-side (revocation, plan downgrade, phone disabled)

Worker está OK, mas Meta rejeita o token (consumer revogou no Business Manager, plano caiu, número desabilitado por qualidade).

1. **NÃO refresh via worker** — token está válido cripto, mas inválido Meta-side. Refresh loop só vai gerar mais `outcome=disconnected`.
2. **Notificar consumer** via canal usual (`<PLACEHOLDER-CONSUMER-SLACK-CHANNEL>` ou consumer-comm team).
3. **Consumer re-autoriza** via embedded signup OAuth flow do app (Meta Login for Business). Novo token chega no callback endpoint `POST /v1/oauth/whatsapp/callback`.
4. **Validar** que evento `waba.connection_changed` com `status=connected` é emitido para o consumer após callback.

Detalhe específico de "phone number disabled" (qualidade Meta) → ver `waba-disconnect-recovery-v1.md` §3 Cenário C.

### Cenário C — KMS / KEK decrypt failure (KEK rotation gone wrong)

Worker logs mostram `KMS decrypt failed` para `waba-tokens/v1` KEK. Tokens em DB estão cifrados com KEK antiga que foi rotacionada sem re-encrypt.

1. **STOP** worker imediatamente para não deletar tokens não-decryptable adicionais (cleanup-cron):
   ```bash
   kubectl scale deployment/worker-token-refresh -n bevox-meta-api --replicas=0
   ```
2. **Rollback KEK** seguindo `disaster-recovery-v1.md#3-remediation` Cenário B (KEK rollback procedure).
3. Após KEK rollback validado, re-escalar worker:
   ```bash
   kubectl scale deployment/worker-token-refresh -n bevox-meta-api --replicas=1
   ```
4. Se rollback KEK não é possível (KEK destruída), tokens são unrecoverable → tratar como Cenário B (consumer re-auth para cada tenant afetado).

Cross-runbook: rotação KEK programada segue `jwt-key-rotation-v1.md#6-rollback` (mesmo padrão de grace period aplica a KEKs).

## 4. Verification

Critérios para considerar incident resolvido:

- **Métrica primária:** `bevox_meta_api_token_refresh_total{outcome=refreshed}` retomou rate ≥ baseline (verificar Grafana panel `token-refresh-outcome`).
- **Métrica de saúde:** `bevox_meta_api_token_refresh_total{outcome=disconnected}` rate ≈ 0 sustentado por 15min após remediation.
- **DB check:** `waba_tokens.refresh_at` para connections previamente afetadas tem timestamps recentes (≤ janela de refresh esperada, tipicamente ~30d window):
  ```sql
  SELECT wc.id, wt.refresh_at
  FROM waba_connections wc
  JOIN waba_tokens wt ON wc.id = wt.waba_connection_id
  WHERE wc.id = ANY('<PLACEHOLDER-AFFECTED-CONNECTION-IDS>'::uuid[]);
  ```
- **Smoke outbound:** consumer-side test message succeeds (consumer team confirma OR via REST endpoint autenticado).
- **Logs limpos:** `kubectl logs -n bevox-meta-api -l app=worker-token-refresh --tail=200` sem novos `META_REJECTED` para connections recém-recuperadas.
- **Observation window:** monitorar 15min após remediation antes de fechar incident (per `incident-response-playbook-v1.md#4-verification-incident-closed-criteria`).

## 5. Escalation

**Referência canônica:** `incident-response-playbook-v1.md#5-escalation-matrix`. NÃO duplicar process aqui.

Runbook-specific bumps:

- **P2 → P1** se ≥10 tenants disconnect simultâneos: suspeitar Meta API outage; abrir paralelo `incident-meta-down-v1.md`.
- **P2 → P1** se ≥30min sem identificar cenário (A/B/C) — escalar CTO para decisão (engage Meta business support? bulk consumer notification?).
- **P2 → P0** se KMS decrypt failure se confirma como key compromise (Cenário C com indicadores de leak) — engage DPO + Legal (LGPD ANPD-72h clock pode aplicar).

### Communication

- **Status page update:** `<PLACEHOLDER-STATUS-PAGE-URL>` se P2→P1 (impact ≥10 tenants); P2 single-tenant não requer status page externo.
- **Consumer-comm:** Slack `<PLACEHOLDER-CONSUMER-SLACK-CHANNEL>` para Cenário B (consumer re-auth required) — consumer-comm team executa outreach.
- **Templates:** ver `incident-response-playbook-v1.md#5-escalation-matrix` Communication block.

## 6. Rollback

Se remediation piorou a situação:

- **Cenário A rollback:** se rollout restart causou pior estado (deploy version bad), revert para previous deployment image:
  ```bash
  kubectl rollout undo deployment/worker-token-refresh -n bevox-meta-api
  ```
- **Cenário B rollback:** N/A — re-auth via consumer OAuth flow é one-way; novo token substitui o velho.
- **Cenário C rollback:** procedimento de KEK rollback é o próprio rollback (ver cross-ref `jwt-key-rotation-v1.md#6-rollback` e `disaster-recovery-v1.md#3-remediation` Cenário B). Se KEK rollback falhar, escalar P0 (data integrity risk) per §5.

Em qualquer cenário, NÃO fechar incident até verification (§4) confirmar. Reabrir incident channel se metric `bevox_meta_api_token_refresh_total{outcome=disconnected}` voltar a crescer dentro de 1h pós-fechamento.

## 7. Postmortem

**Template canônico:** `incident-response-playbook-v1.md#7-postmortem-template`. NÃO duplicar aqui.

Runbook-specific artifacts a coletar para o postmortem:

- **Worker logs:** `kubectl logs -n bevox-meta-api -l app=worker-token-refresh --since=<incident-start>` salvo em `<PLACEHOLDER-INCIDENT-ARTIFACTS-BUCKET>`.
- **DB snapshot pre/post:** rows de `waba_connections` + `waba_tokens` para connections afetadas (anonimizar `meta_waba_id` se postmortem for shared além do core team).
- **KMS audit log:** apenas para Cenário C — export `<PLACEHOLDER-KMS-CONSOLE-WABA-TOKENS>` audit log da janela do incident.
- **Metric timeline:** screenshot Grafana panel `token-refresh-outcome` cobrindo janela `incident-start - 30min` até `incident-close + 30min`.
- **Cenário identificado (A/B/C)** + decision tree path documentado em `## Root cause`.
- **Action items candidates:** se cenário A recorrente → revisar worker resource limits / HPA; se B recorrente → revisar consumer onboarding docs (token expiry expectations); se C recorrente → revisar KEK rotation procedure.

## Referencias

- PRD V1 §13 (Observabilidade) — alerta `Token refresh outcome=disconnected`.
- ADR MA-008 — Token encryption (KEK `waba-tokens/v1`).
- ADR MA-007 — Observabilidade (metric naming + outcome label).
- ADR MA-005 — Webhook delivery (event `waba.connection_changed` emission).
- Go-Live Checklist V1 §4:76 — alert severity P2 default.
- Source canon:
  - `src/workers/token-refresh.ts` (refresh loop + emission `waba.connection_changed`).
  - `src/lib/metrics.ts:77` — `bevox_meta_api_token_refresh_total{channel,outcome}`.
  - `db/schema/bindings.ts:54,84` — `waba_connections.disconnected_at` + `waba_tokens.refresh_at`.
  - `scripts/admin-cli/index.ts` — surface real (namespaces `apps` + `dead-letter`; `tenants` NÃO existe).
- Spec: `docs/superpowers/specs/2026-05-20-bevox-meta-api-runbooks-v1-design.md` (hub `d1a9369`).
- Última revisão exercitada em staging: 2026-05-20 (initial publish; tabletop drill agendar dentro 30d).
- Próxima revisão programada: 2026-08-20 (quarterly per `incident-response-playbook-v1.md#8-quarterly-review-process`).
