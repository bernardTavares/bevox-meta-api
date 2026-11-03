# Disaster Recovery — V1

**Status:** ativo
**Última atualização:** 2026-05-20
**Owner (mantém doc):** SRE rotation (quarterly review per [`incident-response-playbook-v1.md`](./incident-response-playbook-v1.md) §8)
**Executor (durante incident):** oncall rotation (PagerDuty) + CTO awareness from start
**Severidade:** P1 default (catastrophic — service down ou dado perdido) / P0 se PII data loss confirmado
**Tempo estimado de resolução:** RTO < 4h ; RPO < 15min (per Go-Live Checklist V1 §2:28 — wins over PRD V1 §14.2:793 24h drift per spec Drift 7)
**Próxima revisão programada:** 2026-08-20 (quarterly).

## 0. Prerequisites / Access

Antes de iniciar este runbook, oncall precisa de:

- Vault profile: `<PLACEHOLDER-VAULT-PROFILE-BEVOX-META-API>` (acesso a secrets `bevox-meta-api/*`, inclusive KMS material).
- kubectl context: `<PLACEHOLDER-K8S-CONTEXT-PROD>` (cluster prod, **cluster-admin** scope — DR pode exigir re-criar namespace + workloads).
- Cloud console: `<PLACEHOLDER-CLOUD-ACCOUNT-PROD>` com IAM role `<PLACEHOLDER-IAM-ROLE-DBA>` (RDS/Aurora ou Cloud SQL snapshot restore) + `<PLACEHOLDER-IAM-ROLE-KMS>` (KMS para KEKs `waba-tokens`, `ig-tokens`, `webhook-secrets/v1` per spec Drift 5).
- Container registry: `<PLACEHOLDER-CONTAINER-REGISTRY>` (ECR / Artifact Registry — pull imagem da API + workers para cluster rebuild).
- Cloudflare dashboard: `<PLACEHOLDER-CLOUDFLARE-ACCOUNT>` (Tunnel `<PLACEHOLDER-CF-TUNNEL-NAME>` + DNS para `meta-api.example.com`).
- Grafana role: `<PLACEHOLDER-GRAFANA-ROLE-BEVOX-META-API>` (dashboards observabilidade — confirmar saúde pós-recovery).
- PagerDuty service: `<PLACEHOLDER-PAGERDUTY-SERVICE>` (escalation policy permite paging CTO direto).
- Status page admin: `<PLACEHOLDER-STATUS-PAGE-URL>` (comunicação durante outage prolongado).

Se faltar qualquer prerequisite → **NÃO iniciar runbook**; escalar imediatamente via [`incident-response-playbook-v1.md#5-escalation-matrix`](./incident-response-playbook-v1.md#5-escalation-matrix) para obter access. DR é P1 desde o início — tempo de espera por access conta direto contra RTO < 4h.

## 1. Trigger / Symptom

Este runbook se aplica quando o falha NÃO é remediável pelos runbooks scenario-específicos (token-refresh, dead-letter-replay, etc), ou seja, escopo é infra-side / data-side catastrófico:

- **Região indisponível:** outage do provedor (AWS/GCP) na região primária; multiple AZ impactadas simultaneamente.
- **DB corrompido / perdido:** corruption confirmada, `TRUNCATE` acidental, deleção lógica em massa, falha de storage no managed DB.
- **Cluster K8s hard-failure:** control plane perdido, multiple node groups offline, namespace `bevox-meta-api` evaporou.
- **Cloudflare Tunnel total outage:** DNS resolve mas tunnel está offline; consumer-apps recebem timeouts em `meta-api.example.com`.
- **Cross-runbook bump:** outro runbook escalou para DR (ex: KMS decrypt total failure cross-link de [`token-refresh-v1.md`](./token-refresh-v1.md) §3 Cenário C).

## 2. Diagnosis

Triage flow inicial (15min cap — depois deste prazo, executar Remediation §3 mesmo com diagnosis incompleto, dado RTO < 4h):

1. **Confirm scope:** app-side, infra-side ou data-side? Decision tree:
   - Pods Healthy + DB Healthy + tunnel down → Cenário D.
   - Pods evicted + nodes NotReady + control plane responsivo → Cenário C.
   - DB connection refused + cloud console mostra storage error → Cenário B.
   - Cloud console region-wide alarm → Cenário A.
2. **Confirm managed DB status:**
   ```bash
   # AWS RDS exemplo
   aws rds describe-db-instances --db-instance-identifier <PLACEHOLDER-RDS-PROD-NAME> \
     | jq '.DBInstances[].DBInstanceStatus'
   # GCP Cloud SQL exemplo
   gcloud sql instances describe <PLACEHOLDER-CLOUDSQL-PROD-NAME> --format='value(state)'
   ```
3. **Confirm Cloudflare Tunnel:** dashboard `<PLACEHOLDER-CLOUDFLARE-ACCOUNT>` → Zero Trust → Networks → Tunnels → estado de `<PLACEHOLDER-CF-TUNNEL-NAME>`.
4. **Confirm latest backup window:**
   ```bash
   aws rds describe-db-snapshots --db-instance-identifier <PLACEHOLDER-RDS-PROD-NAME> \
     --snapshot-type automated \
     | jq '.DBSnapshots | sort_by(.SnapshotCreateTime) | reverse | .[0:3] | .[] | {id: .DBSnapshotIdentifier, t: .SnapshotCreateTime}'
   ```
   Snapshot ≤ 15min de idade → RPO target hold; > 15min → documentar gap no postmortem (RPO miss).
5. **Inspect cluster state:**
   ```bash
   kubectl get nodes
   kubectl get pods -n bevox-meta-api
   kubectl get events -n bevox-meta-api --sort-by='.lastTimestamp' | tail -20
   ```

## 3. Remediation

Quatro cenários independentes (executar apenas o(s) cenário(s) que diagnosis aponta). Idempotência: cada cenário pode ser repetido sem efeito colateral até verification §4 passar.

### Cenário A — Region failover

V1 é **single-region** (per spec §9 deferred — multi-region é V2 candidate):

- **Single-region V1 (atual):** wait + monitor cloud provider status page `<PLACEHOLDER-CLOUD-PROVIDER-STATUS-URL>`. Notify consumers via status page + Slack. NÃO há failover infra V1.
- **Multi-region (futuro V2):** DNS flip via Cloudflare API:
  ```bash
  curl -X PATCH "https://api.cloudflare.com/client/v4/zones/<PLACEHOLDER-CF-ZONE-ID>/dns_records/<PLACEHOLDER-CF-RECORD-ID>" \
    -H "Authorization: Bearer <PLACEHOLDER-CF-API-TOKEN>" \
    -H "Content-Type: application/json" \
    --data '{"content":"<PLACEHOLDER-DR-REGION-TUNNEL-CNAME>"}'
  ```

### Cenário B — DB restore (data loss / corruption)

Restore from latest snapshot via cloud provider. Target RTO < 4h, RPO < 15min (per checklist §2:28 — Drift 7 fix).

1. **Stop writes:** scale workers para zero para evitar dirty writes contra DB restaurado:
   ```bash
   kubectl scale deployment/api-deployment --replicas=0 -n bevox-meta-api
   kubectl scale deployment/workers-deployment --replicas=0 -n bevox-meta-api
   ```
2. **Trigger restore** (AWS RDS exemplo; ajustar para GCP Cloud SQL):
   ```bash
   aws rds restore-db-instance-from-db-snapshot \
     --db-instance-identifier <PLACEHOLDER-RDS-PROD-NAME>-restored \
     --db-snapshot-identifier <PLACEHOLDER-RDS-LATEST-SNAPSHOT-ID>
   ```
3. **Update Secret** `bevox-meta-api-secret` (key `DATABASE_URL`) para apontar ao endpoint restaurado:
   ```bash
   kubectl create secret generic bevox-meta-api-secret -n bevox-meta-api \
     --from-literal=DATABASE_URL='postgresql://<PLACEHOLDER-RESTORED-DB-ENDPOINT>' \
     --dry-run=client -o yaml | kubectl apply -f -
   ```
4. **Verificar KEKs ainda decifram waba-tokens / ig-tokens** (KMS está fora do DB; KEKs `waba-tokens`, `ig-tokens`, `webhook-secrets/v1` persistem per spec Drift 5). Se KMS também perdeu o KEK material → escalate to vendor support + customer re-auth obrigatório (consumer-side embedded signup).
5. **Restart workloads** (Cenário C steps 6-7 below) e validar via §4.
6. **Documentar data-loss window** para postmortem: `(snapshot_create_time .. incident_detect_time)` em minutos; comparar contra RPO < 15min.

### Cenário C — Cluster rebuild

Cluster K8s perdido total ou namespace `bevox-meta-api` foi removido. Re-apply order canon per [`k8s/README.md`](../../k8s/README.md):

1. **Namespace:**
   ```bash
   kubectl apply -f k8s/namespace.yaml
   ```
2. **Secret** (real values via Vault / External Secrets Operator — **NÃO** o template `k8s/secret.yaml`):
   ```bash
   kubectl create secret generic bevox-meta-api-secret -n bevox-meta-api \
     --from-literal=DATABASE_URL='<PLACEHOLDER-DB-URL>' \
     --from-literal=REDIS_URL='<PLACEHOLDER-REDIS-URL>' \
     --from-literal=META_APP_ID='<PLACEHOLDER-META-APP-ID>' \
     --from-literal=META_APP_SECRET='<PLACEHOLDER-META-APP-SECRET>' \
     --from-literal=META_WEBHOOK_VERIFY_TOKEN='<PLACEHOLDER-META-WEBHOOK-VERIFY-TOKEN>' \
     --from-literal=META_WEBHOOK_APP_SECRET='<PLACEHOLDER-META-WEBHOOK-APP-SECRET>' \
     --from-literal=ADMIN_API_KEY='<PLACEHOLDER-ADMIN-API-KEY>' \
     --from-literal=WEBHOOK_DELIVERY_SIGNING_SECRET='<PLACEHOLDER-WEBHOOK-SIGNING-SECRET>' \
     --from-literal=JWT_PUBLIC_KEYS_JSON='<PLACEHOLDER-JWT-PUBLIC-KEYS-JSON>'
   ```
3. **ConfigMap:** `kubectl apply -f k8s/configmap.yaml`.
4. **Migrations job + wait:**
   ```bash
   kubectl apply -f k8s/job-migrate.yaml
   kubectl wait --for=condition=complete --timeout=300s -n bevox-meta-api \
     job/bevox-meta-api-migrate
   ```
5. **Cloudflare Tunnel:** `kubectl apply -f k8s/cloudflared.yaml` (pré-req: Secret `cloudflared-credentials` criado per top do manifest).
6. **Deployments API + workers:**
   ```bash
   kubectl apply -f k8s/deployment-api.yaml
   kubectl apply -f k8s/deployment-workers.yaml
   ```
7. **Service / PDB / HPA / NetworkPolicy:**
   ```bash
   kubectl apply -f k8s/service.yaml
   kubectl apply -f k8s/pdb.yaml
   kubectl apply -f k8s/hpa.yaml
   kubectl apply -f k8s/networkpolicy.yaml
   ```

Order é canônica per `k8s/README.md` (namespace → secret → configmap → job-migrate → cloudflared → deployments → service/pdb/hpa/networkpolicy). Pular passo gera failure-mode conhecido (ex: deployment antes do Secret = CrashLoopBackOff).

### Cenário D — Cloudflare Tunnel down

Pods + DB Healthy, mas `meta-api.example.com` retorna timeout / 522.

1. **Restart cloudflared deployment:**
   ```bash
   kubectl rollout restart deployment/cloudflared -n bevox-meta-api
   kubectl rollout status deployment/cloudflared -n bevox-meta-api --timeout=120s
   ```
2. **Verificar credentials Secret** (`cloudflared-credentials`): se invalidado (token rotacionado Cloudflare-side), recriar via dashboard + `kubectl create secret`.
3. **Fallback degraded mode:** se Cloudflare control plane está fora globalmente → não há mitigation app-side; aceitar outage + comunicar via status page + Slack (consumer-apps NÃO devem expor `meta-api.example.com` direto via NLB; ingress alternativo seria V2 — flagged em [`incident-response-playbook-v1.md#5-escalation-matrix`](./incident-response-playbook-v1.md#5-escalation-matrix) Communication block).

## 4. Verification

Pré-condições para fechar incident DR:

1. **Smoke test passa** (script real per `package.json:36` = `"smoke": "tsx scripts/smoke-test.ts"`):
   ```bash
   BEVOX_META_API_URL=https://meta-api.example.com pnpm smoke
   ```
   Expected output substring: `smoke OK`.
2. **HPA min replicas restored:**
   ```bash
   kubectl get hpa -n bevox-meta-api
   # CURRENT REPLICAS >= MIN REPLICAS, sem condições "AbleToScale=False"
   ```
3. **Cloudflared `Connection registered`** em logs:
   ```bash
   kubectl logs -n bevox-meta-api -l app.kubernetes.io/name=cloudflared --tail=200 \
     | grep "Connection registered"
   ```
4. **Consumer-app JWT-protected GET works:** consumer-side ou via teste manual com app JWT mint válido — request retorna 200 OK contra endpoint protegido.
5. **Metrics core voltam a healthy thresholds** (prefix `bevox_meta_api_*` per spec Drift 1):
   - `bevox_meta_api_queue_size` drenando, não crescendo.
   - `bevox_meta_api_meta_request_duration_seconds_count{outcome="error"}` rate baixa.
   - `bevox_meta_api_webhook_delivery_total{outcome="success"}` rate retomando.
6. **Observation window mínima:** 15min sem regression antes de fechar incident.

## 5. Escalation

Referenciar [`incident-response-playbook-v1.md#5-escalation-matrix`](./incident-response-playbook-v1.md#5-escalation-matrix). **NÃO duplicar process aqui.**

Runbook-specific:

- **P1 from start** (catastrophic — service down OR dado perdido). CTO + CEO awareness imediato (business continuity).
- **Bump P0 imediato se PII data loss confirmado** (Cenário B com snapshot > 15min idade OU rows com PII perdidas além do RPO window): page DPO + Legal; clock ANPD-72h aplicável per canon ADR-019. Cross-link [`incident-response-playbook-v1.md#5-escalation-matrix`](./incident-response-playbook-v1.md#5-escalation-matrix) §P0.
- **Outage > 2h sem progress path:** engage vendor business support (AWS/GCP TAM, Cloudflare priority support per `<PLACEHOLDER-CF-SUPPORT-CONTRACT-ID>`).

### Communication

- **Status page** `<PLACEHOLDER-STATUS-PAGE-URL>`: post imediato pós-IC declaration (P1 mandatory).
- **Consumer-comm Slack** `<PLACEHOLDER-CONSUMER-SLACK-CHANNEL>`: notificar customer-comm team pré-broadcast aos consumer-apps Bevox.
- **Email blast:** se DR > 1h ou dado perdido confirmado, customer-comm dispara email aos consumer-apps via template canônico [`incident-response-playbook-v1.md#5-escalation-matrix`](./incident-response-playbook-v1.md#5-escalation-matrix).

## 6. Rollback

**N/A** — DR **é** o rollback path. Se DR falhar:

- Cenário B falhou (snapshot corrupto / restore não termina dentro de RTO): escalar para cloud vendor support; documentar o gap; investigar PITR (point-in-time recovery) como alternativa se feature está habilitada no managed DB.
- Cenário C falhou (manifests não aplicam / pods CrashLoopBackOff persistente): re-verificar Secret values + container image tag em `<PLACEHOLDER-CONTAINER-REGISTRY>`; última safe-known image tag em `<PLACEHOLDER-LAST-KNOWN-GOOD-IMAGE-TAG>`.
- Cenário D falhou (Cloudflare control plane global outage): aceitar degraded mode; sem fallback infra-side V1.

**NÃO** abrir new incident — manter incident DR aberto até resolução ou vendor escalation accept.

## 7. Postmortem

Referenciar [`incident-response-playbook-v1.md#7-postmortem-template`](./incident-response-playbook-v1.md#7-postmortem-template). **NÃO duplicar template aqui.**

Runbook-specific artifacts mandatory para postmortem DR:

- **RTO actual vs target:** `(incident_close_time - incident_detect_time)` em horas; comparar com RTO < 4h.
- **RPO actual vs target:** `(incident_detect_time - last_snapshot_create_time)` em minutos; comparar com RPO < 15min.
- **Data loss assessment:** zero / parcial (quais tabelas, quantas rows) / total. Se rows com PII perdidas → trigger DSR + ANPD-72h notification track via DPO.
- **Vendor SLA review:** AWS/GCP/Cloudflare SLA compliance check; credit claim if applicable (timing + valor estimado).
- **K8s manifests divergence:** se Cenário C revelou drift entre `k8s/*.yaml` vs realidade pré-DR, listar em action items + flag canon edit (`k8s/README.md` apply order).
- **KEK availability:** se KMS material esteve em risco (Cenário B), documentar status dos 3 KEKs (`waba-tokens`, `ig-tokens`, `webhook-secrets/v1` per spec Drift 5).

## Referencias

- Spec: `docs/superpowers/specs/2026-05-20-bevox-meta-api-runbooks-v1-design.md` (hub `d1a9369`).
- Go-Live Checklist V1 §2:28 (RTO < 4h, RPO < 15min — canônico, supersedes PRD §14.2:793 24h drift per spec §12 Drift 7).
- PRD V1 §13 (Observabilidade), §14 (Operação).
- ADRs: MA-005 (webhook delivery), MA-007 (observabilidade), MA-008 (token encryption + KEKs).
- Canon ADR-019: LGPD ANPD-72h notification clock (P0 bump se PII loss).
- K8s manifests: `k8s/*.yaml` (10 files + `k8s/README.md` apply order canon — verificado em T0 setup).
- Smoke test: `scripts/smoke-test.ts` (real script per `package.json:36`).
- Cross-runbooks: [`incident-response-playbook-v1.md`](./incident-response-playbook-v1.md), [`token-refresh-v1.md`](./token-refresh-v1.md), [`incident-meta-down-v1.md`](./incident-meta-down-v1.md).
- Última revisão exercitada em staging: 2026-05-20 (initial publish; tabletop drill agendar dentro 30d).
- Próxima revisão programada: 2026-08-20 (quarterly).
