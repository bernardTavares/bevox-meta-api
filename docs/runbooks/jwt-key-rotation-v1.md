# JWT Key Rotation — V1

**Status:** ativo
**Última atualização:** 2026-05-20
**Owner (mantém doc):** SRE rotation (quarterly review per [`incident-response-playbook-v1.md`](./incident-response-playbook-v1.md#8-quarterly-review-process)).
**Executor (durante incident):** oncall SRE (scheduled) ou IC + Security designate (emergency compromise).
**Severidade:** **P3** scheduled (60d cycle per Go-Live Checklist V1 §3 secret-rotation policy) / **P2** emergency (key compromise suspeito) / bump **P1** se compromise confirmado.
**Tempo estimado de resolução:** 30-60min scheduled / 1-2h emergency.
**Próxima revisão programada:** 2026-08-20 (quarterly).

## 0. Prerequisites / Access

Antes de iniciar rotation, executor precisa:
- Vault profile: `<PLACEHOLDER-VAULT-PROFILE-BEVOX-META-API>` (read+write em `bevox-meta-api/jwt/*` para storage do novo `private_key_pem` emitido pelo CLI).
- kubectl context: `<PLACEHOLDER-K8S-CONTEXT-PROD>` (rollout restart de `deployment/api-deployment`).
- KMS console access: `<PLACEHOLDER-KMS-CONSOLE-PROFILE>` (AWS KMS ou GCP KMS — wrap/unwrap do `private_key_pem` por trás do KEK).
- Grafana role: `<PLACEHOLDER-GRAFANA-ROLE-BEVOX-META-API>` (dashboard `bevox_meta_api_*` auth metrics + log queries).
- DB read access: `<PLACEHOLDER-DB-READONLY-PROFILE>` (inspect `app_keys` table histórico).
- Para emergency compromise: PagerDuty access para escalation imediata + canal `#security-incident-{slug}` (per [`incident-response-playbook-v1.md`](./incident-response-playbook-v1.md#5-escalation-matrix)).

Faltar prerequisite → escalar imediatamente para CTO (per `#5-escalation-matrix`).

## 1. Trigger / Symptom

Dois gatilhos canônicos:

**Scheduled (P3):**
- 60d cycle from last rotation (per Go-Live Checklist V1 §3 secret-rotation policy).
- Calendar reminder owned pelo SRE rotation.

**Emergency (P2 / bump P1 se confirmado):**
- Suspeita de leak do `private_key_pem` (commit acidental em repo, screenshot enviado em canal errado, suspect ex-staff offboarding).
- IDS / SIEM alert flag de atividade anômala em endpoint `POST /v1/oauth/token` ou padrão de mint que sugere chave roubada.
- Forensics report de pentest externo identificando exposição.
- Consumer-app reporting JWTs estranhos minted sem ação deles.

Em ambos casos, este runbook é o ponto único de entrada — process de escalation upstream segue [`incident-response-playbook-v1.md`](./incident-response-playbook-v1.md#1-trigger--symptom).

## 2. Diagnosis

JWT rotation no bevox-meta-api é **per-`consumer_app`**, NÃO global — cada app cliente tem o próprio keypair RS256 em `app_keys`. Diagnose começa por identificar qual app(s) rotacionar.

Inspecionar histórico de chaves no DB:

```sql
-- Table real é app_keys (db/schema/identity.ts:44).
SELECT id, app_id, algo, valid_from, valid_until, revoked_at
FROM app_keys
WHERE app_id = '<app_uuid>'
ORDER BY valid_from DESC LIMIT 5;
```

Inspect env-side authoritative state (chaves públicas aceitas pelo verifier):

```bash
kubectl get deployment/api-deployment -n bevox-meta-api \
  -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="JWT_PUBLIC_KEYS_JSON")].value}'
```

Testar verification em runtime via api Pod logs (per Drift 8 — não há subcomando CLI dedicado `jwt verify`/`jwt rotate`; subcommands sob o grupo `jwt` são FICTITIOUS; verification observada via auth middleware no runtime):

```bash
kubectl logs -n bevox-meta-api -l app=api --tail=500 | grep -E "jwt verification|jwt verify"
```

Para emergency compromise, correlate timeline:

```bash
kubectl logs -n bevox-meta-api -l app=api --since=72h \
  | grep -E "jwt verification (succeeded|failed)" \
  | grep "<suspect-app-uuid>"
```

**NOTA observability gap (Drift 11):** NÃO existe metric dedicado `jwt_verification_failures` — verify via api Pod logs grep até observability gap ser fechado em V2.

## 3. Remediation

**Rotation per-app via real CLI** (per `scripts/admin-cli/index.ts:81`):

```bash
pnpm cli apps rotate-key --app-id <app_uuid> --grace-days 14
# Output JSON: { kid, app_id, valid_from, valid_until, private_key_pem, public_key_pem }
# CLI internally: cria nova row em app_keys + grava private_key_pem em vault.
```

**NÃO** invocar subcommands sob o grupo `jwt` (ex.: `jwt rotate --generate`, `jwt verify`) — todos FICTITIOUS (per Drift 8); o grupo CLI real é `apps`. Rotation é per-`consumer_app`, NÃO global.

Steps subsequentes:

1. **CLI já gravou** o novo `private_key_pem` em vault internamente (não há manual write-to-vault step).
2. **Append novo public key em `JWT_PUBLIC_KEYS_JSON`** (env-side authoritative para verifier):
   - Editar secret K8s correspondente (via ESO ou `kubectl edit secret`).
   - Adicionar nova entry mantendo a entry antiga em paralelo durante grace.
   - Estrutura JSON: array de `{ kid, alg, pem }` entries; manter velhas + nova.
3. **Rolling restart do api deployment** para carregar novo env:
   ```bash
   kubectl rollout restart deployment/api-deployment -n bevox-meta-api
   kubectl rollout status deployment/api-deployment -n bevox-meta-api --timeout=10m
   ```
4. **Período de graça 14 dias** (per MA-002 linhas 122-126, canônico — Drift 6 fix: spec early "24h" era drift; canon canonical é 14d). Durante 14d:
   - Old kid continua válido para verification (JWTs antigos não-expirados ainda aceitos).
   - Novo kid usado em mints novos pelo consumer-app.
5. **Cleanup pós-grace (T+14d):** remover entry antiga de `JWT_PUBLIC_KEYS_JSON` + outro rollout restart. Em paralelo, marcar `app_keys.revoked_at = now()` para a row antiga (opcional housekeeping; verifier já não a aceita).

**Emergency compromise (revogação imediata, NÃO grace):**

```bash
# 1. Rotacionar com grace zero — força revogação imediata da old kid:
pnpm cli apps rotate-key --app-id <app_uuid> --grace-days 0
# 2. Update JWT_PUBLIC_KEYS_JSON: REMOVER entry antiga + adicionar nova entry (não manter ambas).
# 3. kubectl rollout restart deployment/api-deployment -n bevox-meta-api
# 4. Notificar consumer-app owner imediatamente (sua aplicação precisa começar a usar o novo private_key_pem).
```

Emergency revocation invalida todos os JWTs em circulação minted com a old kid — consumer-app pode experienciar 401 spikes enquanto re-mints. Comunicar antes via `<PLACEHOLDER-CONSUMER-SLACK-CHANNEL>` (per [`incident-response-playbook-v1.md`](./incident-response-playbook-v1.md#5-escalation-matrix) communication section).

## 4. Verification

Pós-rotation (scheduled e emergency):

- **End-to-end mint test** — consumer-app (ou test fixture interno) mint um novo JWT usando o novo `private_key_pem` recém-emitido + fazer chamada autenticada qualquer ao bevox-meta-api. Resposta 2xx esperada.
- **Old JWT durante grace (scheduled apenas)** — JWTs minted antes da rotation continuam OK durante 14d grace. Validar com um JWT pré-rotation ainda dentro do `exp`: chamada deve retornar 2xx.
- **API Pod logs limpos** — sem padrões `jwt verification failed` para o `<app_uuid>` rotacionado:
  ```bash
  kubectl logs -n bevox-meta-api -l app=api --since=15m \
    | grep -E "jwt verification failed" \
    | grep "<app_uuid>"
  # Expected: zero hits.
  ```
- **DB consistency** — `app_keys` tem 2 rows ativas para o app (old com `valid_until` futuro durante grace; new com `valid_from` recente):
  ```sql
  SELECT id, valid_from, valid_until, revoked_at
  FROM app_keys
  WHERE app_id = '<app_uuid>' AND revoked_at IS NULL
  ORDER BY valid_from DESC;
  ```

**Observability gap (Drift 11 — repetido aqui para incident memory):** metric `jwt_verification_failures` NÃO existe ainda; verification baseia-se em log grep até gap ser fechado. Documentar action item em postmortem.

## 5. Escalation

Reference [`incident-response-playbook-v1.md`](./incident-response-playbook-v1.md#5-escalation-matrix) para matriz canônica P0/P1/P2/P3 + channel naming + page mechanism + communication.

Runbook-specific rules:
- **Scheduled (P3):** ticket queue; sem PagerDuty page. Escalate P2 se rotation falhar (CLI erro, vault write falhou, rollout não estabiliza).
- **Emergency suspect compromise (P2):** PagerDuty page oncall + Security designate. Bump **P1** se compromise confirmado (logs mostram mint anômalo, forensics conclusivo). Bump **P0** se PII data leak comprovado via JWT roubado (LGPD ANPD-72h clock pode aplicar — engage DPO imediatamente per `#5-escalation-matrix`).

## 6. Rollback

Rollback durante grace period (scheduled) é trivial — old kid ainda em `JWT_PUBLIC_KEYS_JSON`:

1. Reverter `JWT_PUBLIC_KEYS_JSON` para o valor anterior (remover novo entry; manter old entry).
2. `kubectl rollout restart deployment/api-deployment -n bevox-meta-api`.
3. Consumer-apps com JWT minted pelo old private_key_pem continuam OK; consumer-app que já começou a mint com o new private_key_pem precisa reverter local também — comunicar via Slack.
4. Marcar `app_keys.revoked_at` para a row nova (opcional housekeeping).

Rollback pós-emergency revocation (grace=0) **NÃO é seguro** se motivo da emergency foi compromise confirmado — re-introduzir old kid re-abre janela de exploit. Se rollback é desejado (false positive), abrir incident separado + escalation explícita.

## 7. Postmortem

Reference [`incident-response-playbook-v1.md`](./incident-response-playbook-v1.md#7-postmortem-template) para template canônico.

Runbook-specific artifacts a anexar:
- Output JSON do `pnpm cli apps rotate-key` (com `private_key_pem` redacted — apenas `kid`, `app_id`, `valid_from`, `valid_until`).
- Diff do `JWT_PUBLIC_KEYS_JSON` pre/post (kids redacted apropriadamente).
- `app_keys` rows snapshot pre/post rotation (SQL output).
- API Pod logs grep `jwt verification` durante janela de grace (scheduled) ou durante emergency window.
- Para emergency: timeline do compromise indicator + IDS/SIEM alert + decisão de grace=0 (quem aprovou).
- Action item recorrente sugerido: adicionar metric `jwt_verification_failures` (Drift 11 gap; ainda aberto até V2).

## Referencias

- Spec: `docs/superpowers/specs/2026-05-20-bevox-meta-api-runbooks-v1-design.md` (hub `d1a9369`).
- Foundational: [`incident-response-playbook-v1.md`](./incident-response-playbook-v1.md) (escalation matrix, postmortem template, quarterly review).
- MA-002 JWT RS256 + per-app keypair + 14d grace canônico (linhas 122-126).
- PRD V1 §11 Segurança + §13 Observabilidade.
- Code: `scripts/admin-cli/index.ts:81` (real CLI `apps rotate-key`); `db/schema/identity.ts:44` (`app_keys` table).
- Cross-runbook: [`token-refresh-v1.md`](./token-refresh-v1.md) (KEK rotation cenário paralelo), [`disaster-recovery-v1.md`](./disaster-recovery-v1.md) (KMS unavailability impacto).
- Última revisão exercitada em staging: 2026-05-20 (initial publish; tabletop drill agendar dentro 30d).
- Próxima revisão programada: 2026-08-20 (quarterly).
