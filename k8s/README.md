# bevox-meta-api — manifests Kubernetes (V1)

Manifests básicos para deploy do bevox-meta-api em um cluster Kubernetes
interno do grupo Bevox.

## Arquivos

| Arquivo | Propósito |
|---|---|
| `namespace.yaml` | Namespace `bevox-meta-api` |
| `configmap.yaml` | Env não-secreto (NODE_ENV, LOG_LEVEL, etc) |
| `secret.yaml` | Template para Secret — **gerar via `kubectl create secret` ou ESO** |
| `job-migrate.yaml` | Job one-shot para aplicar migrations (rodar antes do rollout) |
| `deployment-api.yaml` | API Fastify (2 replicas + probes) |
| `deployment-workers.yaml` | 4 workers: outbound dispatcher, webhook delivery, token refresh, cleanup |
| `service.yaml` | ClusterIP service (interno) |
| `hpa.yaml` | HorizontalPodAutoscaler (CPU 70% / mem 80%) |
| `pdb.yaml` | PodDisruptionBudget (minAvailable=1) para api e workers críticos |
| `networkpolicy.yaml` | Restringe ingress aos apps Bevox + cloudflared local |
| `cloudflared.yaml` | Cloudflare Tunnel — expõe `meta-api.example.com` publicamente |

## Deploy inicial

```bash
# 1. Crie o namespace
kubectl apply -f k8s/namespace.yaml

# 2. Crie o Secret com valores reais (NUNCA commitar)
kubectl create secret generic bevox-meta-api-secret \
  -n bevox-meta-api \
  --from-literal=DATABASE_URL='postgresql://...' \
  --from-literal=REDIS_URL='redis://...' \
  --from-literal=META_APP_ID='...' \
  --from-literal=META_APP_SECRET='...' \
  --from-literal=META_WEBHOOK_VERIFY_TOKEN='...' \
  --from-literal=META_WEBHOOK_APP_SECRET='...' \
  --from-literal=ADMIN_API_KEY='...' \
  --from-literal=WEBHOOK_DELIVERY_SIGNING_SECRET='...' \
  --from-literal=JWT_PUBLIC_KEYS_JSON='{"kid-1":"-----BEGIN PUBLIC KEY-----..."}'

# 3. ConfigMap antes dos workloads
kubectl apply -f k8s/configmap.yaml

# 4. (Apenas no primeiro deploy / quando há migrations novas) aplicar migrations
#    via Job. Aguardar conclusão antes de rolar deployments.
kubectl apply -f k8s/job-migrate.yaml
kubectl wait --for=condition=complete --timeout=300s -n bevox-meta-api \
  job/bevox-meta-api-migrate

# 5. Cloudflare Tunnel (pré-req: criar tunnel no CF + Secret cloudflared-credentials)
#    Veja instruções no topo do k8s/cloudflared.yaml.
kubectl apply -f k8s/cloudflared.yaml

# 6. Workloads + rede
kubectl apply -f k8s/deployment-api.yaml
kubectl apply -f k8s/deployment-workers.yaml
kubectl apply -f k8s/service.yaml
kubectl apply -f k8s/pdb.yaml
kubectl apply -f k8s/hpa.yaml
kubectl apply -f k8s/networkpolicy.yaml
```

## Observações

- **Imagem**: o tag `latest` é placeholder. Em prod use digest imutável
  (`@sha256:...`) e pipeline de CI atualiza por commit. Há 2 imagens:
  - runtime: `docker build --target runtime -t ghcr.io/bevox/bevox-meta-api:<sha>`
  - migrator: `docker build --target migrator -t ghcr.io/bevox/bevox-meta-api:migrator-<sha>`
- **Migrations**: rodar `job-migrate.yaml` ANTES de fazer rollout de
  novos deployments. Idempotente via `__drizzle_migrations`.
- **HPA workers**: V1 não escala workers automaticamente — capacidade é
  controlada pela concurrency interna (BullMQ) + replica count fixo.
  Adicionar HPA por queue depth quando volume justificar.
- **NetworkPolicy**: assume cloudflared rodando no mesmo namespace, com
  label `bevox-meta-api/role: ingress`. Para apps consumidores em outros
  namespaces, rotular o namespace com `bevox-internal: "true"`.
  Cilium/Calico podem precisar ajustes.
- **Postgres/Redis**: assumimos managed (RDS/Aurora, ElastiCache) — se
  rodando in-cluster, adicionar manifests próprios + StatefulSet + PVCs.
- **TLS / Exposição pública**: feita por Cloudflare Tunnel (cloudflared.yaml).
  CF termina TLS no edge; nenhum Ingress/cert-manager necessário no cluster.
