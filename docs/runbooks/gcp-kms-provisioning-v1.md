# Runbook — Provisionamento do GCP Cloud KMS (envelope encryption, MA-008)

**Objetivo:** provisionar no GCP as chaves que o `bevox-meta-api` usa para cifrar
tokens Meta (envelope encryption, MA-008) e ligar o serviço a elas via
`KMS_PROVIDER=gcp`. Destrava `NODE_ENV=production` (com `local` o boot é proibido
por `src/config/env.ts`; ver issue #2).

**Quem executa:** founder/DevOps com `gcloud` autenticado (login interativo) e
projeto GCP com billing.

> **🔴 AUTH = Workload Identity Federation (NÃO SA key).** A org GCP do Bevox
> força `constraints/iam.disableServiceAccountKeyCreation` (enforced) — **chaves de
> service account são proibidas**. A auth ao KMS é via **WIF** (keyless): o cluster
> federa a identidade da ServiceAccount do pod com o GCP e impersona a SA
> `bevox-meta-api-kms`, sem segredo de longa duração. O código do app NÃO muda
> (`GcpKmsClient` usa ADC; WIF entrega ADC via um credential config file).

> **⚠️ Pendência LGPD:** a região define a custódia da chave. `us-east4` (Ashburn)
> coloca a KEK sob jurisdição US (CLOUD Act). O KMS não armazena PII (só KEK + DEK
> efêmera), mas exige **OK do DPO**. Ver MA-012 e o spec `docs/superpowers/specs/2026-05-25-gcp-kms-provider-design.md` §2.6 (hub).

---

## Estado atual (provisionado em 2026-05-25, projeto `my-gcp-project`)

✅ Já feito (§1–§5 abaixo): Cloud KMS API habilitada; keyRing `bevox-meta-api` em
`us-east4`; cryptoKeys `waba-tokens`/`ig-tokens`/`webhook-secrets` (rotação 90d);
SA `bevox-meta-api-kms@my-gcp-project.iam.gserviceaccount.com` com
`cryptoKeyEncrypterDecrypter` nas 3 chaves; encrypt/decrypt verificado.

⬜ Pendente: WIF (§6) — depende do OIDC issuer do cluster k3s prod; wiring K8s (§7);
OK do DPO. **Valor da app:** `KMS_KEY_ID=projects/my-gcp-project/locations/us-east4/keyRings/bevox-meta-api`.

## 0. Variáveis

```bash
export PROJECT=my-gcp-project
export LOCATION=us-east4
export RING=bevox-meta-api
export SA_NAME=bevox-meta-api-kms
export SA_EMAIL=$SA_NAME@$PROJECT.iam.gserviceaccount.com
export PROJECT_NUMBER=$(gcloud projects describe $PROJECT --format='value(projectNumber)')
```

## 1. Autenticar, projeto, habilitar API ✅

```bash
gcloud auth login                      # interativo (terminal real, não via prefixo !)
gcloud config set project $PROJECT
gcloud services enable cloudkms.googleapis.com --project=$PROJECT
```

## 2. keyRing ✅

```bash
gcloud kms keyrings create $RING --location=$LOCATION --project=$PROJECT
```

## 3. 3 cryptoKeys (simétricas, software, rotação 90d) ✅

Nomes exatos — o app deriva a cryptoKey do ID lógico por convenção:
```bash
for KEY in waba-tokens ig-tokens webhook-secrets; do
  gcloud kms keys create $KEY \
    --keyring=$RING --location=$LOCATION --project=$PROJECT \
    --purpose=encryption --rotation-period=90d \
    --next-rotation-time="$(date -u -d '+90 days' +%Y-%m-%dT%H:%M:%SZ)"
done
```

## 4. Service Account ✅

```bash
gcloud iam service-accounts create $SA_NAME \
  --display-name="bevox-meta-api KMS encrypt/decrypt" --project=$PROJECT
```

## 5. IAM `cryptoKeyEncrypterDecrypter` POR CHAVE (least-privilege) ✅

```bash
for KEY in waba-tokens ig-tokens webhook-secrets; do
  gcloud kms keys add-iam-policy-binding $KEY \
    --keyring=$RING --location=$LOCATION --project=$PROJECT \
    --member="serviceAccount:$SA_EMAIL" \
    --role="roles/cloudkms.cryptoKeyEncrypterDecrypter" --condition=None
done
```

## 6. Auth via Workload Identity Federation ⬜ (substitui SA key — org proíbe keys)

**6.1 — Workload Identity Pool** (executável já, sem o cluster):
```bash
gcloud iam workload-identity-pools create bevox-k8s \
  --location=global --display-name="Bevox k8s clusters" --project=$PROJECT
```

**6.2 — OIDC provider** — **TODO: precisa do issuer OIDC do cluster k3s prod.**
Pré-req no k3s: API server com `--service-account-issuer=<URL pública>` e o discovery
(`/.well-known/openid-configuration` + JWKS) **alcançável pela Google**.
```bash
export POOL=bevox-k8s
export ISSUER="https://<OIDC_ISSUER_DO_CLUSTER_PROD>"          # TODO
gcloud iam workload-identity-pools providers create-oidc bevox-meta-api-k3s \
  --location=global --workload-identity-pool=$POOL --project=$PROJECT \
  --issuer-uri="$ISSUER" \
  --attribute-mapping="google.subject=assertion.sub" \
  --allowed-audiences="//iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL/providers/bevox-meta-api-k3s"
```

**6.3 — Permitir a ServiceAccount do pod impersonar a GCP SA:**
```bash
export K8S_SA="system:serviceaccount:bevox-meta-api:bevox-meta-api-kms"   # ajuste ao SA do pod
gcloud iam service-accounts add-iam-policy-binding $SA_EMAIL --project=$PROJECT \
  --role=roles/iam.workloadIdentityUser \
  --member="principal://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/bevox-k8s/subject/$K8S_SA"
```

**6.4 — Gerar o credential config (ADC; NÃO é segredo — só aponta pro token projetado):**
```bash
gcloud iam workload-identity-pools create-cred-config \
  projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/bevox-k8s/providers/bevox-meta-api-k3s \
  --service-account=$SA_EMAIL \
  --credential-source-file=/var/run/secrets/gcp-tokens/token \
  --credential-source-type=text \
  --output-file=./gcp-wif-credential.json
```

## 7. Wiring no K8s (WIF — sem SA key) ⬜

**(a)** Credential config como ConfigMap (não-secreto):
```bash
kubectl create configmap gcp-wif-credential -n bevox-meta-api \
  --from-file=wif-credential.json=./gcp-wif-credential.json
```

**(b)** `k8s/configmap.yaml`:
```yaml
  KMS_PROVIDER: gcp
  KMS_KEY_ID: "projects/my-gcp-project/locations/us-east4/keyRings/bevox-meta-api"
  GOOGLE_APPLICATION_CREDENTIALS: /var/secrets/gcp/wif-credential.json
```

**(c)** Em **api + os 4 workers** (`deployment-api.yaml`, `deployment-workers.yaml`;
`job-migrate` não precisa): projetar o token da ServiceAccount (audience = WIF) +
montar o credential config. Os pods precisam de uma **ServiceAccount k8s dedicada**
cujo `system:serviceaccount:...` case com o binding do §6.3 (hoje os deployments usam
`automountServiceAccountToken: false` — o projected token é volume à parte).
```yaml
    spec:
      serviceAccountName: bevox-meta-api-kms   # SA k8s dedicada (criar)
      containers:
        - name: <api|worker>
          volumeMounts:
            - name: gcp-wif-cred
              mountPath: /var/secrets/gcp
              readOnly: true
            - name: gcp-token
              mountPath: /var/run/secrets/gcp-tokens
              readOnly: true
      volumes:
        - name: gcp-wif-cred
          configMap: { name: gcp-wif-credential }
        - name: gcp-token
          projected:
            sources:
              - serviceAccountToken:
                  path: token
                  audience: "//iam.googleapis.com/projects/<PROJECT_NUMBER>/locations/global/workloadIdentityPools/bevox-k8s/providers/bevox-meta-api-k3s"
                  expirationSeconds: 3600
```

## 8. Verificar

**Chave funciona (creds de usuário) — já validado:**
```bash
echo -n "smoke" > /tmp/pt.txt
gcloud kms encrypt --location=$LOCATION --keyring=$RING --key=waba-tokens \
  --plaintext-file=/tmp/pt.txt --ciphertext-file=/tmp/ct.bin --project=$PROJECT
gcloud kms decrypt --location=$LOCATION --keyring=$RING --key=waba-tokens \
  --ciphertext-file=/tmp/ct.bin --plaintext-file=- --project=$PROJECT   # imprime "smoke"
rm -f /tmp/pt.txt /tmp/ct.bin
```
**App sobe com prod+gcp (após WIF + wiring):** rollout e
`kubectl exec -n bevox-meta-api deploy/bevox-meta-api -- wget -qO- localhost:3000/readyz`
→ `{"ok":true,...}` (boot antes bloqueado por MA-008). Confirma a WIF: o app cifra/decifra
sem nenhuma SA key.

## Rollback

App não sobe com gcp → reverter ConfigMap ao provider anterior + `kubectl rollout undo`.
As chaves GCP podem ficar (custo desprezível). **Nunca** destruir uma cryptoKey que já
cifrou dados em prod (perde acesso aos tokens) — desabilitar a *versão*, não destruir.

## Notas de segurança

- **WIF não tem segredo de longa duração** — o token é de curta duração, projetado pelo
  k8s, trocado por um access token GCP em runtime. Revogável (remover o binding
  `workloadIdentityUser`) e auditável (Cloud Audit Logs). Superior a SA key (e a única
  opção, dada a org policy).
- Habilitar **Cloud Audit Logs (Data Access)** do Cloud KMS registra cada decrypt —
  recomendado para a postura LGPD/MA-012.

## Referências

- Design: hub `docs/superpowers/specs/2026-05-25-gcp-kms-provider-design.md`
- Plano: hub `docs/superpowers/plans/2026-05-25-gcp-kms-provider.md`
- Código: `src/integration/kms-client.ts` (`GcpKmsClient`), `src/config/env.ts`
- MA-008, MA-012 (LGPD), Go-Live Checklist V1 §2, issue `bernardTavares/bevox-meta-api#2`
