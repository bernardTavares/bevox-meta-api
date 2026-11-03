# Incident Response Playbook — V1

**Status:** ativo
**Última atualização:** 2026-05-20
**Owner (mantém doc):** SRE rotation (quarterly review per §8 abaixo)
**Executor (durante incident):** N/A — este doc é foundational/process, NÃO scenario.
**Severidade:** N/A (process doc, não scenario)
**Tempo estimado de resolução:** N/A
**Próxima revisão programada:** 2026-08-20 (quarterly).

## 0. Prerequisites / Access

Antes de declarar qualquer incident, o oncall precisa de:
- Vault profile: `<PLACEHOLDER-VAULT-PROFILE-BEVOX-META-API>` (acesso a secrets `bevox-meta-api/*`).
- kubectl context: `<PLACEHOLDER-K8S-CONTEXT-PROD>` (cluster prod).
- Grafana role: `<PLACEHOLDER-GRAFANA-ROLE-BEVOX-META-API>` (dashboards observabilidade).
- PagerDuty access: `<PLACEHOLDER-PAGERDUTY-SERVICE>` (service: bevox-meta-api; ack + escalation permissions).
- Slack channels: `#engineering` + permission para criar `#incident-{slug}` dynamic channels.
- Status page admin: `<PLACEHOLDER-STATUS-PAGE-URL>` (para post external updates durante incident).

Se faltar qualquer prerequisite → escalar imediatamente para CTO (per §5 escalation matrix) para obter access. Tempo de espera conta contra SLA — potential P-bump.

## 1. Trigger / Symptom

Este doc é o **entry-point process** para qualquer incident detectado em `bevox-meta-api`. Dispara quando:
- PagerDuty page recebido em qualquer severidade (P0/P1/P2/P3).
- Alert Grafana / Sentry / oncall queue ticket.
- Manual report (consumer support escalation, engineer observation, monitoring panel anomaly).
- Cross-runbook reference (specific scenario runbook needs IC/escalation/postmortem process).

Este doc NÃO é remediation de scenario específico; é **process de incident handling**. Para remediation, use o runbook scenario-específico (token-refresh, dead-letter-replay, etc).

## 2. Diagnosis (triage)

Triage flow após page recebido:

1. **Acknowledge page** em PagerDuty (≤5min para parar re-page; clock SLA já iniciou).
2. **Classify severity** via decision tree (per §5 escalation matrix):
   - Data loss / PII breach / safety → **P0**.
   - Consumer-impacting prod outage (no data loss) → **P1**.
   - Degraded service / single tenant impacted → **P2**.
   - Non-impacting investigation / scheduled ops → **P3**.
3. **Identify scope** (quantas consumers/tenants impactados? duração estimada?).
4. **Open incident channel** `#incident-YYYY-MM-DD-N-{slug}` em Slack (per §5 channel convention).
5. **Assign IC** (Incident Commander) — primeiro responder default; pode handoff explicitly.
6. **Page additional roles** per severity matrix (P0 = CTO+Legal+DPO; P1 = CTO; P2 = oncall; P3 = ticket queue).
7. **Identify scenario runbook** (token-refresh? dead-letter-replay? jwt-key-rotation? incident-meta-down? disaster-recovery? waba-disconnect-recovery?). Cross-link via anchor.

## 3. Remediation

**NÃO há remediation técnica neste doc** — process apenas. Use o runbook scenario-específico:

- WABA token refresh failures → [`token-refresh-v1.md`](./token-refresh-v1.md).
- WABA disconnected Meta-side → [`waba-disconnect-recovery-v1.md`](./waba-disconnect-recovery-v1.md).
- Webhook delivery dead-letter queue growing → [`dead-letter-replay-v1.md`](./dead-letter-replay-v1.md).
- JWT signing key rotation (scheduled 60d ou emergency) → [`jwt-key-rotation-v1.md`](./jwt-key-rotation-v1.md).
- Meta APIs upstream unavailable → [`incident-meta-down-v1.md`](./incident-meta-down-v1.md).
- Catastrophic infra failure (DB lost, region down, etc) → [`disaster-recovery-v1.md`](./disaster-recovery-v1.md).

Se scenario NÃO mapeia para nenhum runbook → escalate para CTO + flag como **V2 runbook candidate** post-postmortem (per spec §9 deferred runbooks list).

## 4. Verification (incident closed criteria)

Para fechar incident:
- All consumer-impacting symptoms resolved (metrics de volta ao SLO).
- 15min minimum observation post-fix com no regression.
- Status page atualizado para "resolved".
- Internal Slack `#engineering` notification de closure.
- IC declares incident closed em `#incident-{slug}` channel.
- Postmortem agendado dentro de 24h (per §7).

## 5. Escalation Matrix

Esta é a **fonte canônica** referenciada pelas outras 6 runbooks via anchor `#5-escalation-matrix`.

### P0 — Data loss / PII breach / safety incident

- **Page:** PagerDuty service `<PLACEHOLDER-PAGERDUTY-SERVICE>` (oncall) + CTO + Legal + DPO.
- **Respond:** ≤15min (PagerDuty ack; phone fallback automático após 5min sem ack).
- **Channel:** `#engineering` + `#incident-{slug}` dedicated + `#pii-incident-{slug}` restricted (DPO + Legal access only).
- **LGPD clock:** ANPD-72h notification clock pode aplicar (per canon ADR-019 e MA-012). Engage DPO immediately.
- **Escalate immediately:** CEO awareness + customer-comm team + jurídico.

### P1 — Consumer-impacting prod outage (no data loss confirmed)

- **Page:** PagerDuty `<PLACEHOLDER-PAGERDUTY-SERVICE>` (oncall) + CTO.
- **Respond:** ≤15min (V1 stage; V2 target ≤5min post-rotation maturity).
- **Channel:** `#engineering` + `#incident-{slug}` dedicated.
- **Escalate after 30min sem resolution path:** CTO ad-hoc + customer-comm team. Bump para P0 if data-loss detected mid-incident.

### P2 — Degraded service / single tenant impacted

- **Page:** PagerDuty `<PLACEHOLDER-PAGERDUTY-SERVICE>` (oncall only).
- **Respond:** ≤1h.
- **Channel:** `#engineering` thread (no dedicated channel unless escalates).
- **Escalate after 2h sem resolution:** bump P1. Bump P1 if ≥5 tenants impactados.

### P3 — Non-impacting investigation / scheduled ops

- **Page:** none (ticket queue em `<PLACEHOLDER-TICKET-SYSTEM>`).
- **Respond:** ≤8h business.
- **Channel:** ticket + `#engineering` thread.
- **Escalate after 24h sem progress:** bump P2 if user-visible impact emerges.

### Channel naming convention

`{slug}` = `YYYY-MM-DD-N-{short-descriptor}` where:
- `YYYY-MM-DD` = UTC date.
- `N` = sequential integer 1, 2, 3... within same UTC day (handles concurrent incidents).
- `{short-descriptor}` = kebab-case scenario hint (e.g., `meta-down`, `dead-letter-spike`, `jwt-key-leak`).

Examples:
- `#incident-2026-05-20-1-meta-down`
- `#incident-2026-05-20-2-dead-letter-spike`
- `#incident-2026-05-20-3-jwt-key-leak`

### Page mechanism

- **Primary:** PagerDuty service `<PLACEHOLDER-PAGERDUTY-SERVICE>` (oncall rotation).
- **Auto-escalation:** PagerDuty policy auto-paged backup após 5min sem ack.
- **Phone fallback:** PagerDuty policy auto-dials oncall após 10min sem ack (P0/P1 only).
- **Slack mention:** `@oncall` em `#engineering` (NÃO substitui PagerDuty page; supplementary visibility apenas).

### Communication during incident

- **Status page update:** post inicial em `<PLACEHOLDER-STATUS-PAGE-URL>`:
  - P0: imediato (post-IC declaration).
  - P1: imediato post-IC declaration.
  - P2: se user-visible > 30min.
  - P3: não-mandatory.
- **Consumer-comm Slack channel:** `<PLACEHOLDER-CONSUMER-SLACK-CHANNEL>` cross-post para customer-comm team awareness.
- **Email blast:** P0 only (customer-comm team executes; IC approves draft).

## 6. Rollback

N/A — este é process doc, NÃO remediation. Rollback procedures vivem nos runbooks scenario-específicos.

## 7. Postmortem Template

Esta é a **fonte canônica** referenciada pelas outras 6 runbooks via anchor `#7-postmortem-template`.

Postmortem MUST ser draft dentro de 24h post-incident, owned pelo IC. Save em `docs/postmortems/YYYY-MM-DD-{slug}.md`.

Template completo:

```markdown
# Postmortem — YYYY-MM-DD {slug}

**Incident channel:** #incident-YYYY-MM-DD-N-{slug}
**Severity:** P{N}
**IC:** {name}
**Duration:** YYYY-MM-DD HH:MM UTC – YYYY-MM-DD HH:MM UTC ({Xh Ym})
**Detection lag:** {alert-to-page time, em minutes} (drives MTTD improvements)

## Impact
- Consumer-impact bulleted: who/what/how-many.
- Data loss assessment (zero / partial / total).
- Business impact estimate (\$ valor se calculável; senão "non-quantifiable").

## Timeline (UTC)
- HH:MM — symptom first detectable em metrics/logs (pre-page baseline).
- HH:MM — alert fired (PagerDuty / Sentry / Grafana).
- HH:MM — page received by oncall (detection lag = this - alert time).
- HH:MM — IC declared incident em #incident channel.
- HH:MM — runbook X invoked (cite specific runbook file).
- HH:MM — remediation completed.
- HH:MM — verification confirmed (per runbook §4 verification criteria).
- HH:MM — incident closed em #incident channel.

## External communication timeline
- HH:MM — status page updated (initial post).
- HH:MM — consumer-comm Slack notification sent.
- HH:MM — customer email blast (if P0).
- HH:MM — status page updated (mid-incident progress).
- HH:MM — status page resolved.

## Root cause
{technical root cause; 5-whys if appropriate. NÃO blame individuals — focus em system/process gaps.}

## Remediation
- What was done.
- Was it effective? (yes / partially / no — explain.)
- Was the runbook accurate? Where did it diverge from reality? (Drives runbook updates.)

## What went well
- {item}: what worked correctly em the response (psychological safety / blameless culture signal).
- Examples: clear escalation, good runbook coverage, fast page ack, accurate root cause identification.

## Cost
- Engineer-hours invested: {N hours × M persons} = {total hours}.
- Business impact estimate: \${value} OR "non-quantifiable".
- SLA breach (if applicable): {yes / no, credit impact \${value}}.

## Action items
- [ ] {action description}, owner: {name}, deadline: {YYYY-MM-DD}, severity: {P0/P1/P2/P3}.
- [ ] {action description}, owner: {name}, deadline: {YYYY-MM-DD}, severity: {P0/P1/P2/P3}.

## Follow-on backlog
Linked memory entries em hub `.claude/projects/-workspace-bevox-PRD-consolidation/memory/`.
```

## 8. Quarterly Review Process

Esta runbook + as 6 dependent runbooks devem ser revisadas trimestralmente.

**Owner:** SRE rotation (founder atribui owner quarterly).

**Process:**
1. **Tabletop drill** — pick 1 random runbook trimestre; team walks through como se fosse real incident (sem disparar code). Output: drill notes documenting divergence from realidade (commands quebrados, paths errados, missing context).
2. **Drift check** — grep code/CLI/metric names mentioned em runbooks; verify ainda existem.
3. **Update runbook** — apply drill notes + drift fixes.
4. **Update "Última revisão exercitada em staging" + "Próxima revisão programada"** dates em runbook headers.
5. **Memorialize patterns** em hub memory file se padrão emergir.

**First tabletop drill commitment:** dentro de 30d post-V1 publish (per spec §10 Risk-4 mitigation).

## Referencias

- Spec: `docs/superpowers/specs/2026-05-20-bevox-meta-api-runbooks-v1-design.md` (hub `d1a9369`).
- PRD V1: `prds/bevox-meta-api-prd-v1.md` §13 (Observabilidade) + §12 (Compliance).
- ADRs: MA-002 (JWT auth), MA-005 (webhook delivery), MA-007 (observabilidade), MA-008 (token cifra), MA-012 (LGPD, Proposta — não aceita).
- Canon ADR-019: AISuggestion dissolution + LGPD ANPD-72h notification clock.
- Go-Live Checklist V1: `40_roadmap/bevox-meta-api/2026-04-25-bevox-meta-api-go-live-checklist-v1.md`.
- Última revisão exercitada em staging: 2026-05-20 (initial publish; tabletop drill agendar dentro 30d).
- Próxima revisão programada: 2026-08-20 (quarterly).
