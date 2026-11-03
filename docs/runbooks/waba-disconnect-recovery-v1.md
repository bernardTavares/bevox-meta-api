# WABA Disconnect Recovery — V1

**Status:** ativo
**Última atualização:** 2026-05-20
**Owner (mantém doc):** SRE rotation (quarterly review per `incident-response-playbook-v1.md#8-quarterly-review-process`)
**Executor (durante incident):** oncall rotation (PagerDuty)
**Severidade:** P2 default / P1 se ≥5 tenants disconnect simultaneous (cross-link `incident-meta-down-v1.md`)
**Tempo estimado de resolução:** 1-3h (depende do tenant + Meta).

## 0. Prerequisites / Access

Antes de iniciar este runbook, oncall precisa de:
- Vault profile: `<PLACEHOLDER-VAULT-PROFILE-BEVOX-META-API>` (acesso a secrets `bevox-meta-api/*`, incluindo KEK `waba-tokens` para decrypt manual).
- kubectl context: `<PLACEHOLDER-K8S-CONTEXT-PROD>` (cluster prod; namespace `bevox-meta-api`).
- Grafana role: `<PLACEHOLDER-GRAFANA-ROLE-BEVOX-META-API>` (dashboards observabilidade-meta-api).
- AWS/GCP KMS console access: read-only suficiente para decrypt manual de token em diagnosis.
- PagerDuty paging-permission para escalar P2→P1 se ≥5 tenants simultaneous.
- Status page admin (`<PLACEHOLDER-STATUS-PAGE-URL>`) para post update se cross-link `incident-meta-down-v1.md` for ativado.

Se faltar qualquer prerequisite → **NÃO iniciar runbook**; escalar imediatamente via `incident-response-playbook-v1.md#5-escalation-matrix` para obter access (potential P-bump devido ao tempo de espera).

## 1. Trigger / Symptom

Este runbook se aplica quando WABA específica perde conexão Meta-side. Dispara por:
- Evento `waba.connection_changed` com `status=disconnected` published para consumer via SSE/webhooks (per `src/workers/token-refresh.ts:104`).
- Outbound Meta API retorna `META_REJECTED` para WABA específica (per `src/lib/errors.ts:21`; HTTP 422 ao consumer per `src/lib/errors.ts:36`).
- Outbound retorna `META_UNAVAILABLE` recorrente para mesma WABA (per `src/lib/errors.ts:20`; pode indicar disconnect intermitente).
- Consumer manual support escalation (consumer admin observou silêncio em tenant específico).
- Multiple disparos concorrentes (≥5 tenants) → suspeitar Meta-side outage; cross-link `incident-meta-down-v1.md`.

## 2. Diagnosis

Comandos ordenados do mais barato ao mais caro (logs → DB → Meta API direct):

Inspecionar estado da conexão WABA (per spec §12 Drift 9 — disconnect state vive em `waba_connections.disconnected_at`, NÃO em `tenants.disconnect_reason`):

```sql
SELECT id, tenant_id, meta_waba_id, disconnected_at, verified_status
FROM waba_connections
WHERE id = '<connection_id>';
```

Cross-ref refresh state em `waba_tokens` (per `db/schema/bindings.ts`):

```sql
SELECT wt.waba_connection_id, wt.refresh_at, wt.disconnected_at
FROM waba_tokens wt
WHERE wt.waba_connection_id = '<connection_id>';
```

Timeline de event-emission via api logs (pino):

```bash
kubectl logs -n bevox-meta-api -l app=api --tail=1000 | grep "waba.connection_changed"
```

Worker-tok logs para confirmar tentativas de refresh:

```bash
kubectl logs -n bevox-meta-api -l app=worker-tok --tail=500 | grep -E "refresh.*fail|disconnect"
```

Teste Meta API direto (requer token decrypted manualmente via KMS console; uso forense apenas):

```bash
curl -H "Authorization: Bearer <token>" https://graph.facebook.com/v22.0/<waba_id>
```

Decision tree:
- Token expirado (`refresh_at` > 60d atrás OU resposta Meta `OAuthException`): **Cenário A**.
- Meta retorna `WABA not found` / `permission revoked`: **Cenário B**.
- Meta retorna phone-number-quality flag / phone disabled: **Cenário C**.

## 3. Remediation

Três cenários mutuamente exclusivos. Identificar via diagnosis decision tree antes de aplicar.

**Cenário A — token expirado (60d Meta expiry):**

O worker `token-refresh` deve renovar tokens proativamente; falha aqui sugere worker travado ou job perdido. Disparar restart controlado:

```bash
kubectl rollout restart deployment/worker-token-refresh -n bevox-meta-api
kubectl rollout status deployment/worker-token-refresh -n bevox-meta-api
```

Monitorar metric `bevox_meta_api_token_refresh_total{outcome=refreshed}` (per `src/lib/metrics.ts:77`; spec §12 Drift 1+2) crescendo nas próximas execuções. Pre-condition: KEK `waba-tokens` operacional (se KMS falhar, escalar para `disaster-recovery-v1.md` §3 Cenário B). **NÃO** invocar `pnpm cli tenants refresh-token` — comando FICTITIOUS (per spec §12 Drift 8; namespace `tenants` não existe em `scripts/admin-cli/index.ts`; refresh é responsabilidade do worker BullMQ).

**Cenário B — WABA revoked Meta-side:**

Admin do tenant (consumer) revogou a WABA via Meta Business Suite, ou Meta revogou por plan change / policy violation. Não há remediation técnica server-side; consumer precisa re-autenticar:

1. Notificar consumer via `<PLACEHOLDER-CONSUMER-SLACK-CHANNEL>` (ou ticket inbound) que tenant precisa re-conectar WABA.
2. Consumer dispara embedded signup OAuth flow no seu produto (UI do consumer; fora da fronteira deste runbook).
3. Callback recebido em `POST /v1/oauth/whatsapp/callback` persiste novo token cifrado em `waba_tokens` e zera `waba_connections.disconnected_at` (per spec §4.3).
4. Worker emite evento `waba.connection_changed` com `status=connected` (per `src/workers/token-refresh.ts:104`).

Sem path automático server-side; consumer-driven por construção (princípio MA-005 — consumer detém autoridade sobre tenants próprios).

**Cenário C — phone number disabled (regulatory / Meta quality):**

Meta desabilitou o phone number da WABA por quality rating low, política de spam, ou ação regulatória. Não há remediation técnica em V1:
1. Notificar consumer com snapshot do `verified_status` + última resposta Meta capturada em logs.
2. Consumer escalona com Meta Business Support diretamente (fora da fronteira meta-api).
3. Documentar incident; phone-number-quality runbook dedicado é FUTURE V2 (per spec §9 deferred runbooks list — depende de telemetria que ainda não existe em `src/lib/metrics.ts`).

## 4. Verification

Confirmar resolução **somente após** os 3 critérios abaixo:

- Outbound test message succeeds:
  - Via REST endpoint canônico (consumer chama `POST /v1/messages/whatsapp` com mensagem template short).
  - OU consumer-side test via UI/automação própria.
  - **NÃO** `pnpm cli messages send-test` — comando FICTITIOUS (per spec §12 Drift 8; namespace `messages` não existe em `scripts/admin-cli/index.ts`).
- Evento `waba.connection_changed` com `status=connected` published e ack-ado pelo consumer (cross-check via dashboard webhook delivery + log consumer-side).
- `waba_connections.disconnected_at IS NULL` após re-auth (Cenário B) ou após refresh-loop completar (Cenário A):

```sql
SELECT id, tenant_id, disconnected_at
FROM waba_connections
WHERE id = '<connection_id>';
```

Tempo mínimo de observation pós-fix: **15min** sem novos `META_REJECTED` no log api para o mesmo `meta_waba_id`. Metric `bevox_meta_api_token_refresh_total{outcome=refreshed}` deve mostrar incremento em Cenário A (per Drift 1 — code-wins prefix `bevox_meta_api_*`).

## 5. Escalation

**Referência ao `incident-response-playbook-v1.md#5-escalation-matrix`.** NÃO duplicar process aqui.

Runbook-specific:
- **Bump P2 → P1** se ≥5 tenants disconnect simultaneous dentro de 30min — forte indício de Meta-side outage; cross-ref `incident-meta-down-v1.md` imediatamente.
- **Bump P2 → P1** se mesmo tenant fica disconnected > 2h sem progresso visível (Cenário B aguardando consumer) — comunicar consumer-comm team que SLA pode quebrar.
- **Bump para P0** se durante diagnosis aparecer evidência de PII vazada (token logado em plaintext, credentials em logs públicos) — engage DPO imediatamente per playbook §5 P0 row.

### Communication

- **Status page update:** `<PLACEHOLDER-STATUS-PAGE-URL>` — apenas se P1 (≥5 tenants) ou se incident-meta-down for cross-linked; tenant-individual P2 normalmente não vira status page externo.
- **Consumer-comm channel:** Slack `<PLACEHOLDER-CONSUMER-SLACK-CHANNEL>` para Cenário B (consumer precisa re-autenticar) — comm é OBRIGATÓRIA, mesmo em P2.
- **Trigger thresholds para comm externa:** P1 immediate post-IC declaration; P2 individual = notificação direta ao consumer afetado (não status page).

## 6. Rollback

N/A — re-auth flow não tem revert. Novo token em `waba_tokens` substitui o anterior; old token fica unreferenced e é purgado pelo cleanup worker (per `bevox_meta_api_cleanup_deleted_total` metric).

Se Cenário A (rollout restart) piorar a situação (e.g., worker crash loop pós-restart), tratar como `token-refresh-v1.md` failure mode e seguir rollback procedure daquele runbook.

## 7. Postmortem

**Referência ao `incident-response-playbook-v1.md#7-postmortem-template`.** NÃO duplicar template aqui.

Runbook-specific artifacts a coletar pré-redação:
- Snapshot da row `waba_connections` pre/post (incluindo `disconnected_at`, `verified_status`).
- Snapshot da row `waba_tokens` pre/post (`refresh_at`, `disconnected_at`).
- Meta API audit log (se disponível via Meta Business Suite — consumer-side; pedir ao consumer se Cenário B/C).
- Event-emission timeline: greps de `waba.connection_changed` nos api logs cobrindo janela disconnect → reconnect.
- Worker-tok logs (Cenário A) ou api OAuth callback logs (Cenário B).
- Metric snapshots: `bevox_meta_api_token_refresh_total{outcome=*}` antes/durante/depois.

Patterns a investigar em "What went well" / "Root cause":
- Detecção foi suficientemente rápida? (alert `waba.connection_changed` chegou ao oncall? Detection lag medido em postmortem template.)
- Worker-tok estava em estado degradado pre-incident? (NOTE per spec §12 Drift 11 — `tokenRefreshTotal` declarado em `src/lib/metrics.ts:76` mas pode não ser emitido pelo worker; observability gap candidate.)
- Cenário B comm com consumer foi clara? (template message documentada? deadline acordada?)

## Referencias

- PRD V1 §13 (Observabilidade) + §12 (Compliance — PII em tokens cifrados).
- ADRs: MA-005 (webhook delivery + event `waba.connection_changed`), MA-008 (token encryption KEK `waba-tokens`), MA-007 (observabilidade).
- Source canon: `src/integration/meta-client.ts` (mapeamento `META_REJECTED` / `META_UNAVAILABLE`), `src/workers/token-refresh.ts` (event emission + refresh loop), `db/schema/bindings.ts` (`waba_connections.disconnected_at`, `waba_tokens.refresh_at`).
- OAuth callback canônico (per spec §4.3): `POST /v1/oauth/whatsapp/callback`.
- Cross-runbooks: `incident-response-playbook-v1.md` (foundational), `incident-meta-down-v1.md` (se ≥5 tenants simultâneos), `token-refresh-v1.md` (se Cenário A escala em worker failure), `disaster-recovery-v1.md` (se KMS-side failure bloqueia refresh).
- Spec: `docs/superpowers/specs/2026-05-20-bevox-meta-api-runbooks-v1-design.md` (hub `d1a9369`).
- Última revisão exercitada em staging: 2026-05-20 (initial publish; tabletop drill agendar dentro 30d).
- Próxima revisão programada: 2026-08-20 (quarterly).
