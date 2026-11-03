# bevox-meta-api — Plano de Go-Live de PRODUÇÃO (para Claude Code no servidor)

> **Para o agente (Claude Code rodando no servidor Hetzner):** este é um plano de
> deploy de **produção real**. Execute por fases, **na ordem**. Pare e peça ao
> humano nos blocos marcados **🙋 HUMANO** (login interativo, segredos, DNS, Meta
> App, DPO). Verifique cada fase antes de avançar. NÃO faça push/merge nos repos
> sem go explícito do founder. Leia o §1 (gotchas) ANTES de começar — eles foram
> descobertos num dry-run e vão te poupar horas.

**Alvo:** `bevox-meta-api` em produção, k3s no Hetzner, domínio `meta-api.example.com`,
`NODE_ENV=production`, KMS gerenciado (GCP, via WIF), observabilidade self-hosted.

**Validação:** este plano foi derivado de um dry-run completo em k3s (ver
`docs/runbooks/` + hub `docs/superpowers/plans/2026-05-25-bevox-meta-api-go-live.md`).
O Go-Live Checklist canônico é `$BEVOX_KNOWLEDGE_PATH/40_roadmap/bevox-meta-api/2026-04-25-bevox-meta-api-go-live-checklist-v1.md`.

---

## §0. Inputs que o HUMANO deve fornecer ANTES de começar

| Input | Para quê | Fase |
|---|---|---|
| `gcloud auth login` feito + projeto `my-gcp-project` | KMS / WIF | §5 |
| `META_APP_SECRET` (app `<META_APP_ID>`) | secrets Meta | §6 |
| Meta App **aprovado p/ produção** (WABA embed signup) | §10 | §10 |
| Conta Cloudflare com zona `example.com` + `cloudflared` login | tunnel/DNS | §9 |
| GHCR PAT (`write:packages`) ou registry alternativo | imagens | §8 |
| **S3 https** p/ backup Postgres (bucket+keys) | backup §3 | §3 |
| **S3 https** p/ mídia (bucket+keys) — pode ser o mesmo provider | MEDIA_S3 §4 | §4 |
| Slack webhook / PagerDuty key | alertas §12 | §12 |
| **OK do DPO** sobre região US do KMS (LGPD/MA-012) | gate §15 | §15 |
| **MA-012** `Proposta`→`Aceita` (parecer jurídico) | gate §15 | §15 |

> Sem `META_APP_SECRET` o app **sobe** (Meta só é exercido em chamadas reais), mas o
> go-live de verdade precisa dele. Sem os demais, a fase correspondente trava.

---

## §1. Gotchas conhecidos (LEIA ANTES — descobertos no dry-run)

1. **Node 22 obrigatório p/ pnpm.** O host pode default p/ Node 20, que quebra o
   runner (rolldown native binding). Rode tudo via `fnm exec --using=v22.22.2 pnpm ...`
   (ou garanta Node ≥22.19 no PATH). Confirme com `node -v`.
2. **`NODE_ENV=production` + `KMS_PROVIDER=local` é BLOQUEADO** pelo app
   (`src/config/env.ts:152`, MA-008). Em prod **tem que ser `gcp`** (KMS já
   provisionado — ver Apêndice). Não use `local` em prod.
3. **`MEDIA_S3_*` é obrigatório em produção** e o endpoint **deve ser https**
   (`env.ts:167-187`). Não está no `.env.example` original. Provisione S3 https (§4).
4. **`deployment-workers.yaml` roda via tsx, não dist.** A imagem runtime tem CMD
   `node --import tsx/esm src/index.ts` e **não contém `dist/`**. Os comandos dos 4
   workers devem ser `node --import tsx/esm src/workers/<X>.ts` (NÃO `node dist/...`).
   Verifique/corrija antes de aplicar (§8).
5. **`readOnlyRootFilesystem: true` exige `emptyDir`** em `/tmp` (socket IPC do tsx)
   e no cache do corepack para o `job-migrate` e os workers/api. Adicione os volumes (§8/§11).
6. **Dockerfile faz `COPY docs/architecture/openapi.yaml`** que pode não existir
   (OpenAPI M5 deferred) → build falha. Garanta o arquivo (copie de
   `docs/contracts/` ou do canon `20_architecture/bevox-meta-api/openapi.yaml`) ou
   remova/condicione o COPY (§8).
7. **kube-prometheus-stack exige `fs.inotify.max_user_instances ≥ 512`** no host,
   senão Prometheus/Alertmanager ficam `Init:Error` (§2).
8. **admin-cli (`scripts/admin-cli`) quebra resolução `@/` fora de `src/`.**
   Provisione ConsumerApps via **HTTP** `POST /admin/apps` (JWT admin HS256 assinado
   com `ADMIN_API_KEY`, `aud=bevox-meta-api-admin`), NÃO via `pnpm cli` (§13).
   Rota real = `/admin/apps` (não `/v1/admin/apps`).
9. **Backup RPO:** em DR drill rode `SELECT pg_switch_wal()` antes de restaurar
   (o último WAL pode não ter sido arquivado). `archive_timeout ≤ alvo de RPO`.

---

## §2. Bootstrap do ambiente

🙋 **HUMANO** (k3s install é `curl|sudo sh`, gate de segurança):
```bash
curl -sfL https://get.k3s.io | sudo sh -s - --disable=traefik --disable=servicelb --write-kubeconfig-mode=644
sudo sysctl -w fs.inotify.max_user_instances=512
sudo sysctl -w fs.inotify.max_user_watches=524288
printf "fs.inotify.max_user_instances=512\nfs.inotify.max_user_watches=524288\n" | sudo tee /etc/sysctl.d/99-inotify.conf
```
Agente, depois:
```bash
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml   # use em TODO comando kubectl
kubectl get nodes -o wide                      # 1 nó Ready
# Helm 3 (não 4 — charts assumem v3):
HELM3=v3.17.3
curl -fsSL "https://get.helm.sh/helm-${HELM3}-linux-amd64.tar.gz" -o /tmp/helm3.tgz
tar -xzf /tmp/helm3.tgz -C /tmp && sudo install -m0755 /tmp/linux-amd64/helm /usr/local/bin/helm
helm version   # v3.17.3
```
**Verify:** nó `Ready`, `helm version` = v3.x, sysctl persistido.

---

## §3. Data layer — Postgres (CloudNativePG) + Redis

🙋 **HUMANO:** forneça bucket S3 **https** + creds para backup.

```bash
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
kubectl apply -f k8s/namespace.yaml
kubectl create namespace monitoring && kubectl label ns monitoring bevox-internal=true --overwrite
# CNPG operator
helm repo add cnpg https://cloudnative-pg.github.io/charts && helm repo update
helm upgrade --install cnpg cnpg/cloudnative-pg -n cnpg-system --create-namespace --wait
# backup creds (S3 https REAL — não MinIO http do dry-run)
kubectl create secret generic cnpg-backup-creds -n bevox-meta-api \
  --from-literal=ACCESS_KEY_ID='<S3_KEY>' --from-literal=ACCESS_SECRET_KEY='<S3_SECRET>'
```
Edite `k8s/cnpg-cluster.yaml`: `barmanObjectStore.destinationPath` + `endpointURL`
(**https**) para o bucket real. Então:
```bash
kubectl apply -f k8s/cnpg-cluster.yaml
kubectl wait --for=condition=Ready cluster/bevox-meta-api-pg -n bevox-meta-api --timeout=600s
# Redis
kubectl apply -f k8s/redis.yaml
kubectl rollout status statefulset/redis -n bevox-meta-api --timeout=120s
```
**Verify:** cluster `healthy`, `ContinuousArchiving=True`; `redis-0` Running.
DATABASE_URL = `bevox-meta-api-pg-app` secret (`.data.uri`); REDIS_URL da `redis-secret`.

> `k8s/cnpg-cluster.yaml`, `k8s/redis.yaml`, `k8s/minio.yaml`, `k8s/observability/*`
> estão no branch **`ops/go-live`** (PR #1). Faça merge dele em `main` (com go do
> founder) OU use esse branch. **Ajuste para prod**: backup S3 https real (não MinIO),
> e veja §4 para a mídia.

---

## §4. Media storage (S3 https — obrigatório em prod)

🙋 **HUMANO:** bucket S3 **https** + creds para mídia (WhatsApp/IG media). Pode ser o
mesmo provider do §3, bucket separado (ex.: `bevox-media`).

ConfigMap vars (§7): `MEDIA_S3_ENDPOINT=https://...`, `MEDIA_S3_REGION`, `MEDIA_S3_BUCKET`.
Secret vars (§6): `MEDIA_S3_ACCESS_KEY`, `MEDIA_S3_SECRET_KEY`.
> O dry-run usou MinIO http (NODE_ENV=staging). Em prod, `env.ts` **exige https**.

---

## §5. Finalizar GCP KMS via WIF (chaves já provisionadas)

As chaves/SA/pool **já existem** (Apêndice). Falta o **provider OIDC** + binding,
que precisam do **OIDC do ESTE cluster k3s**. Truque: use `--jwk-json-path` (entrega
a JWKS do cluster ao Google) — assim o cluster **não precisa de OIDC público**.

🙋 **HUMANO:** garanta `~/google-cloud-sdk/bin/gcloud` autenticado (`gcloud auth login`
em terminal real) + `gcloud config set project my-gcp-project`.

Agente:
```bash
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
GC=~/google-cloud-sdk/bin/gcloud
PN=<GCP_PROJECT_NUMBER>   # project number my-gcp-project
# 1. extrair issuer + JWKS do cluster
ISS=$(kubectl get --raw /.well-known/openid-configuration | python3 -c "import sys,json;print(json.load(sys.stdin)['issuer'])")
kubectl get --raw /openid/v1/jwks > /tmp/cluster-jwks.json
echo "issuer: $ISS"
# 2. provider OIDC (sem exigir issuer público — usa a JWKS entregue)
$GC iam workload-identity-pools providers create-oidc bevox-meta-api-k3s \
  --location=global --workload-identity-pool=bevox-k8s --project=my-gcp-project \
  --issuer-uri="$ISS" --jwk-json-path=/tmp/cluster-jwks.json \
  --attribute-mapping="google.subject=assertion.sub" \
  --allowed-audiences="https://kubernetes.default.svc"   # = audience do projected token (§11)
# 3. criar SA k8s dedicada p/ os pods que tocam KMS
kubectl create serviceaccount bevox-meta-api-kms -n bevox-meta-api
# 4. binding: a SA k8s impersona a GCP SA
$GC iam service-accounts add-iam-policy-binding bevox-meta-api-kms@my-gcp-project.iam.gserviceaccount.com \
  --project=my-gcp-project --role=roles/iam.workloadIdentityUser \
  --member="principal://iam.googleapis.com/projects/$PN/locations/global/workloadIdentityPools/bevox-k8s/subject/system:serviceaccount:bevox-meta-api:bevox-meta-api-kms"
# 5. cred-config (ADC; não-segredo) → ConfigMap
$GC iam workload-identity-pools create-cred-config \
  projects/$PN/locations/global/workloadIdentityPools/bevox-k8s/providers/bevox-meta-api-k3s \
  --service-account=bevox-meta-api-kms@my-gcp-project.iam.gserviceaccount.com \
  --credential-source-file=/var/run/secrets/gcp-tokens/token --credential-source-type=text \
  --output-file=/tmp/gcp-wif-credential.json
kubectl create configmap gcp-wif-credential -n bevox-meta-api --from-file=wif-credential.json=/tmp/gcp-wif-credential.json
```
**Verify:** provider criado; binding listado em `gcloud iam service-accounts get-iam-policy`.
Validação real do WIF acontece no boot do app (§11).
> Detalhe completo + rollback: `docs/runbooks/gcp-kms-provisioning-v1.md`.

---

## §6. Secrets (todos reais)

🙋 **HUMANO** fornece os valores Meta. Agente gera o resto:
```bash
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
# JWT RS256 (kid-1): gerar par; pública no Secret, privada → cofre do consumer (bevox-backend)
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:4096 -out /tmp/jwtpriv.pem
openssl rsa -in /tmp/jwtpriv.pem -pubout -out /tmp/jwtpub.pem
JWTJSON=$(python3 -c "import json;print(json.dumps({'kid-1':open('/tmp/jwtpub.pem').read()}))")
DB=$(kubectl get secret bevox-meta-api-pg-app -n bevox-meta-api -o jsonpath='{.data.uri}'|base64 -d)
RPW=$(kubectl get secret redis-secret -n bevox-meta-api -o jsonpath='{.data.REDIS_PASSWORD}'|base64 -d)
kubectl create secret generic bevox-meta-api-secret -n bevox-meta-api \
  --from-literal=DATABASE_URL="$DB" \
  --from-literal=REDIS_URL="redis://:$RPW@redis.bevox-meta-api.svc.cluster.local:6379" \
  --from-literal=META_APP_ID='<META_APP_ID>' \
  --from-literal=META_APP_SECRET='<HUMANO>' \
  --from-literal=META_WEBHOOK_VERIFY_TOKEN="$(openssl rand -hex 24)" \
  --from-literal=META_WEBHOOK_APP_SECRET='<HUMANO: = META_APP_SECRET>' \
  --from-literal=ADMIN_API_KEY="$(openssl rand -hex 32)" \
  --from-literal=WEBHOOK_DELIVERY_SIGNING_SECRET="$(openssl rand -hex 32)" \
  --from-literal=JWT_PUBLIC_KEYS_JSON="$JWTJSON" \
  --from-literal=SENTRY_DSN='<HUMANO ou vazio>' \
  --from-literal=MEDIA_S3_ACCESS_KEY='<HUMANO>' --from-literal=MEDIA_S3_SECRET_KEY='<HUMANO>'
# NOTA (fix A18, audit 2026-06-02): OTEL_EXPORTER_OTLP_ENDPOINT NÃO vai mais
# aqui — vive em k8s/configmap.yaml (§7) com valor base
# `http://otel-collector.monitoring.svc.cluster.local:4318` (sem sufixo
# `/v1/traces`). Antes, o valor incluía `/v1/traces` e o código também
# acrescentava o sufixo, resultando em URL duplicada `/v1/traces/v1/traces`
# (404 silencioso) — 100% dos traces de produção iam para o vácuo. Override
# por ambiente: edite a entrada `OTEL_EXPORTER_OTLP_ENDPOINT` no ConfigMap.
# NÃO inclua KMS_LOCAL_MASTER_KEY (prod usa gcp). Guarde /tmp/jwtpriv.pem no cofre e shred.
mv /tmp/jwtpriv.pem ~/.bevox-secrets/ 2>/dev/null; shred -u /tmp/jwtpub.pem
```
**Backup offline** de ADMIN_API_KEY + tokens num cofre (checklist §3, rotação 60d).

---

## §7. ConfigMap (produção)

Edite `k8s/configmap.yaml` para PROD (≠ dry-run, que era staging+local+http):
```yaml
  NODE_ENV: production
  LOG_LEVEL: info
  PORT: "3000"
  KMS_PROVIDER: gcp
  KMS_KEY_ID: "projects/my-gcp-project/locations/us-east4/keyRings/bevox-meta-api"
  GOOGLE_APPLICATION_CREDENTIALS: /var/secrets/gcp/wif-credential.json
  MEDIA_S3_ENDPOINT: "https://<S3_HTTPS_ENDPOINT>"
  MEDIA_S3_REGION: "<region>"
  MEDIA_S3_BUCKET: "bevox-media"
  META_GRAPH_API_VERSION: v21.0
  OAUTH_CALLBACK_BASE_URL: https://meta-api.example.com
  OTEL_SERVICE_NAME: bevox-meta-api
  OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf"
  # base do collector; o exporter acrescenta `/v1/traces` (fix A18).
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel-collector.monitoring.svc.cluster.local:4318"
  JWT_ISSUER: bevox-meta-api
  JWT_AUDIENCE: bevox-meta-api
  JWT_MAX_AGE_SECONDS: "300"
  WEBHOOK_DELIVERY_MAX_RETRIES: "8"
kubectl apply -f k8s/configmap.yaml
```

---

## §8. Imagens + fixes de manifest

🙋 **HUMANO:** `docker login ghcr.io` (PAT). Agente:
```bash
cd /path/to/bevox-meta-api   # ou onde o repo está no servidor
# gotcha #6: garanta o openapi.yaml p/ o build
mkdir -p docs/architecture && cp docs/contracts/bevox-meta-api.yaml docs/architecture/openapi.yaml 2>/dev/null || true
SHA=$(git rev-parse --short HEAD)
docker build --target runtime  -t ghcr.io/bevox/bevox-meta-api:$SHA .
docker build --target migrator -t ghcr.io/bevox/bevox-meta-api:migrator-$SHA .
docker push ghcr.io/bevox/bevox-meta-api:$SHA && docker push ghcr.io/bevox/bevox-meta-api:migrator-$SHA
RUNTIME=$(docker inspect --format='{{index .RepoDigests 0}}' ghcr.io/bevox/bevox-meta-api:$SHA)
MIGRATOR=$(docker inspect --format='{{index .RepoDigests 0}}' ghcr.io/bevox/bevox-meta-api:migrator-$SHA)
```
Edite os manifests:
- `deployment-api.yaml`, `deployment-workers.yaml`: `image:` → `$RUNTIME` (digest).
- `job-migrate.yaml`: `image:` → `$MIGRATOR`.
- **gotcha #4:** os 4 workers em `deployment-workers.yaml` usam
  `command: ["node","--import","tsx/esm","src/workers/<outbound-dispatcher|webhook-delivery|token-refresh|cleanup>.ts"]`.
- **gotcha #5:** `job-migrate.yaml` + api + workers: adicionar `emptyDir` em `/tmp`
  (e `/home/bevox/.cache` no migrate) por causa de `readOnlyRootFilesystem`.
- api + workers: adicionar `serviceAccountName: bevox-meta-api-kms` + os volumes WIF
  (configmap `gcp-wif-credential` em `/var/secrets/gcp` + projected token
  `audience: https://kubernetes.default.svc` em `/var/run/secrets/gcp-tokens`).
```bash
grep -rn "bevox-meta-api:latest\|migrator-latest\|dist/workers" k8s/ || echo "OK"
```

---

## §9. Cloudflare Tunnel + DNS

🙋 **HUMANO** (login interativo):
```bash
cloudflared tunnel login
cloudflared tunnel create bevox-meta-api
cloudflared tunnel route dns bevox-meta-api meta-api.example.com
kubectl create secret generic cloudflared-credentials -n bevox-meta-api \
  --from-file=credentials.json=$HOME/.cloudflared/<TUNNEL_ID>.json
```
Agente: em `k8s/cloudflared.yaml` trocar `<TUNNEL_NAME>`→`bevox-meta-api`, pinar a
imagem `cloudflare/cloudflared` por digest. **Verify:** após deploy (§11), logs do
cloudflared mostram `Connection registered`.

---

## §10. Meta App (produção) — 🙋 HUMANO

No dashboard do app `<META_APP_ID>`:
- OAuth redirect URIs: `https://meta-api.example.com/v1/oauth/whatsapp/callback` (+ instagram).
  Confirme os paths reais: `grep -rn "/v1/oauth\|/webhooks/meta" src/`.
- Webhooks WA+IG: callback `https://meta-api.example.com/webhooks/meta`
  (path único — o handler discrimina WhatsApp vs Instagram pelo campo
  `object` no payload da Meta; ver `src/modules/inbound/routes.ts`).
  Verify token = `META_WEBHOOK_VERIFY_TOKEN`. (O handshake só passa após §11.)

  > **Fix A7 (audit 2026-06-02):** este doc anteriormente afirmava
  > `/webhooks/meta/{whatsapp,instagram}` (paths separados por canal). O
  > código sempre serviu **um** path `/webhooks/meta` — configurar a Meta
  > para `.../whatsapp` ou `.../instagram` 404 a o handshake de verificação
  > E todos os eventos inbound. Use o path único acima.

---

## §11. Deploy (ordem) + verify

```bash
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
kubectl apply -f k8s/job-migrate.yaml
kubectl wait --for=condition=complete --timeout=300s -n bevox-meta-api job/bevox-meta-api-migrate
kubectl apply -f k8s/cloudflared.yaml
kubectl apply -f k8s/deployment-api.yaml -f k8s/deployment-workers.yaml \
  -f k8s/service.yaml -f k8s/pdb.yaml -f k8s/hpa.yaml -f k8s/networkpolicy.yaml
kubectl rollout status deploy/bevox-meta-api -n bevox-meta-api --timeout=180s
for w in out in tok cleanup; do kubectl rollout status deploy/bevox-meta-api-worker-$w -n bevox-meta-api --timeout=120s; done
kubectl exec -n bevox-meta-api deploy/bevox-meta-api -- wget -qO- http://localhost:3000/readyz
```
**Verify:** `/readyz` = `{"ok":true,"checks":{"postgres":...,"redis":...}}`. Se
CrashLoop: `kubectl logs` — causas prováveis: WIF mal configurado (cheque audience do
projected token = `allowed-audiences` do provider §5), MEDIA_S3 não-https, ou env
faltando. Smoke público: `BEVOX_META_API_URL=https://meta-api.example.com pnpm smoke`
(via Node 22).

---

## §12. Observabilidade

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts && helm repo update
helm upgrade --install kube-prometheus-stack prometheus-community/kube-prometheus-stack -n monitoring \
  --set grafana.persistence.enabled=false --set prometheus.prometheusSpec.retention=15d \
  --set prometheus.prometheusSpec.serviceMonitorSelectorNilUsesHelmValues=false \
  --set prometheus.prometheusSpec.ruleSelectorNilUsesHelmValues=false --wait --timeout 10m
kubectl apply -f k8s/observability/   # servicemonitor, otel-collector, prometheusrule, grafana-dashboard
```
🙋 **HUMANO:** configurar Alertmanager (Slack/PagerDuty) + status page (checklist §8).
**Verify:** target `bevox-meta-api` UP no Prometheus; 6 alertas carregados.

---

## §13. Provisionar 1º ConsumerApp (Bevox V1)

NÃO use `pnpm cli` (gotcha #8). Use a API com um admin JWT HS256:
```bash
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
AK=$(kubectl get secret bevox-meta-api-secret -n bevox-meta-api -o jsonpath='{.data.ADMIN_API_KEY}'|base64 -d)
b64(){ openssl base64 -A|tr '+/' '-_'|tr -d '='; }
now=$(date +%s); h=$(printf '{"alg":"HS256","typ":"JWT"}'|b64)
p=$(printf "{\"sub\":\"go-live\",\"role\":\"admin\",\"aud\":\"bevox-meta-api-admin\",\"iat\":$now,\"exp\":$((now+600))}"|b64)
sig=$(printf "$h.$p"|openssl dgst -sha256 -hmac "$AK" -binary|b64); JWT="$h.$p.$sig"
kubectl port-forward -n bevox-meta-api svc/bevox-meta-api 8080:80 & PF=$!; sleep 4
curl -s -X POST http://localhost:8080/admin/apps -H "Authorization: Bearer $JWT" \
  -H 'Content-Type: application/json' -d '{"name":"Bevox V1"}'   # 201 + private_key_pem
kill $PF
```
Entregue o `private_key_pem` retornado ao cofre do consumer (bevox-backend). **Não rode `pnpm seed`.**

---

## §14. Smoke E2E + runbooks

- E2E: criar tenant → conectar WABA sandbox → enviar template → receber webhook → ack
  (precisa do Meta App + WABA real).
- Validar os 8 runbooks de `docs/runbooks/` contra o ambiente; **restore-test PITR**
  (com `pg_switch_wal()` antes — gotcha #9).

---

## §15. Gate de compliance + triple sign-off — 🙋 HUMANO

- **MA-012** LGPD `Proposta`→`Aceita` (parecer jurídico) — canon, zero-write.
- **OK do DPO** sobre região US do KMS.
- Reconciliar TODOS os P0 do Go-Live Checklist V1 (§1–§5, §7).
- **Triple sign-off** (eng + produto + jurídico) no `#bevox-meta-api-launch`.
- Sem as 3 assinaturas + MA-012 Aceita: **não vai para prod.**

---

## Apêndice — GCP KMS já provisionado (2026-05-25, `my-gcp-project`)

✅ keyRing `bevox-meta-api` (`us-east4`); cryptoKeys `waba-tokens`/`ig-tokens`/`webhook-secrets`
(rotação 90d); SA `bevox-meta-api-kms@my-gcp-project.iam.gserviceaccount.com` + IAM por-chave;
WIF pool `bevox-k8s` (project number `<GCP_PROJECT_NUMBER>`). Falta só provider+binding (§5).
⚠️ Org proíbe SA keys (`disableServiceAccountKeyCreation`) → **WIF obrigatório, sem key file.**

## Referências
- Runbook KMS: `docs/runbooks/gcp-kms-provisioning-v1.md`
- Dry-run plan + achados: hub `docs/superpowers/plans/2026-05-25-bevox-meta-api-go-live.md`, `docs/ops/go-live-findings.md`
- Spec KMS: hub `docs/superpowers/specs/2026-05-25-gcp-kms-provider-design.md`
- Issues `bernardTavares/bevox-meta-api#2..#7` · MA-008 · MA-012 · Go-Live Checklist V1
