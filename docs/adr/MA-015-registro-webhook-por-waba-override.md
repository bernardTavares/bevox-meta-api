# MA-015: Registro de webhook por-WABA via override no Meta App compartilhado

**Status:** Proposta
**Data:** 2026-06-02
**Decisor(es):** Bernard Tavares (fundador), equipe Bevox
**Revisor(es):** —
**Bloqueia:** Recebimento de webhooks (inbound) para WABAs onboarded pelo meta-api — sem esta decisão, WABAs enviam mas não recebem.

---

## Contexto

A `bevox-meta-api` encapsula o WhatsApp atrás de **um único Meta App Bevox**
("Bevox Solutions", `app_id <META_APP_ID>`), com N WABAs onboarded via OAuth
(`/dialog/oauth`) / Embedded Signup (MA-004). Confirmado por Graph API em
2026-06-02: o app tem o produto WhatsApp **ativo** (subscription
`whatsapp_business_account`), porém o **callback de webhook a nível de app**
aponta para o Bevox V1 (`chat.example.com`), **não** para o meta-api
(`meta-api.example.com/webhooks/meta`).

**Problema observado:** WABAs onboarded pelo meta-api conseguiam **enviar**
(outbound, com o token guardado cifrado por MA-008) mas **não recebiam**
webhooks. O `handleWabaCallback` (`src/modules/wabas/service.ts`) trocava
code→token, descobria a WABA (`discoverWaba`) e persistia, mas **nunca
registrava a WABA nos webhooks do app** (`POST /{waba_id}/subscribed_apps`).
O gap estava deferido com rótulo errado ("task #15", que na verdade é "Gestão
de Phone Numbers", concluída) — drift de rastreamento, não decisão consciente.

A questão estrutural por trás do bug é: **onde mora o callback de webhook das
WABAs que o meta-api onboarda?** A Meta resolve callback de webhook em duas
camadas — a nível de app (um único URL por app) e a nível de WABA (override por
`subscribed_apps`). Como o callback a nível de app já está tomado pelo V1, a
decisão é se reaproveitamos o app compartilhado com um override por-WABA ou se
criamos um Meta App separado e dedicado ao meta-api.

### Forças em tensão

- **Custo de burocracia Meta:** um Meta App novo exige business verification +
  Advanced Access aprovados do zero (semanas de processo Meta).
- **Isolamento:** compartilhar `app_id`/`app_secret` com o V1 acopla os dois
  produtos no mesmo segredo de assinatura HMAC inbound.
- **Estado atual de produção:** o V1 **não tem** números/WABAs vivos em
  produção hoje — então não há tráfego real a isolar neste momento.

## Alternativas consideradas

### Opção A — App compartilhado + override de callback por-WABA (escolhida)

Usar o **mesmo Meta App** do V1 e, em cada onboarding, registrar a WABA com um
override de callback por-WABA: `POST /{waba_id}/subscribed_apps` com
`override_callback_uri = <OAUTH_CALLBACK_BASE_URL>/webhooks/meta` +
`verify_token = META_WEBHOOK_VERIFY_TOKEN`.

**Prós:**
- Pouco trabalho — mudança só de código, sem processo Meta.
- Override é cirúrgico (por-WABA): **não** toca o callback a nível de app do V1,
  então não interfere com o que o V1 já tem registrado.
- Idempotente no lado Meta — reconexão de uma WABA já registrada é segura.
- Reusa o HMAC inbound (`META_WEBHOOK_APP_SECRET`) e o `verify_token` já
  validados pela rota `/webhooks/meta` — sem nova superfície de validação.

**Contras:**
- Acopla o meta-api ao Meta App do V1 (mesmo `app_id`/`app_secret`/
  `META_WEBHOOK_APP_SECRET`). Rotação ou suspensão do app do V1 afeta o meta-api.

### Opção B — Meta App separado, dedicado ao meta-api

Criar um Meta App novo só para o meta-api, com seu próprio `app_id`,
`app_secret` e callback a nível de app apontando para `/webhooks/meta`.

**Prós:**
- Isolamento total entre meta-api e V1 (segredos, callback, quality/policy
  enforcement Meta independentes).
- Callback a nível de app simplifica o onboarding (sem override por-WABA).

**Contras:**
- Exige refazer business verification + Advanced Access do zero — semanas de
  burocracia Meta antes de qualquer WABA poder ser onboarded.
- O V1 **não tem** números/WABAs vivos em produção, então **não há o que
  isolar** hoje — o custo não se justifica no estado atual.
- Migração futura de WABAs entre apps é trabalhosa (re-onboarding por WABA).

## Decisão

**Usar o mesmo Meta App compartilhado com o V1 e registrar cada WABA onboarded
com um override de callback por-WABA via `POST /{waba_id}/subscribed_apps`
(`override_callback_uri` = `<OAUTH_CALLBACK_BASE_URL>/webhooks/meta`,
`verify_token` = `META_WEBHOOK_VERIFY_TOKEN`), em vez de criar um Meta App
dedicado ao meta-api.**

O registro acontece **durante o callback OAuth de onboarding**, depois de
descobrir a WABA e **antes** de cifrar/persistir o token, de modo que uma falha
de registro aborta o onboarding inteiro (sem conexão meia-onboarded).

## Consequências

### Positivas

- WABAs onboarded pelo meta-api passam a **receber** webhooks (inbound) em
  `/webhooks/meta`, fechando o gap em que só enviavam.
- Onboarding fica **atômico do ponto de vista funcional**: se o registro de
  webhook falha, nada é persistido — o consumer re-tenta limpo e não fica com
  uma conexão que envia mas não recebe.
- Zero burocracia Meta — a capacidade vai a produção assim que mergeia.
- Preserva o callback a nível de app do V1 intacto (override é por-WABA).

### Negativas / riscos aceitos

- **Acoplamento ao Meta App do V1** (mesmo `app_id`/`app_secret`/
  `META_WEBHOOK_APP_SECRET`). Rotação de `app_secret`, suspensão por policy
  Meta ou business verification revogada do app do V1 derrubam o inbound do
  meta-api junto. Mitigação: reabrir esta decisão (Opção B, app dedicado) se o
  isolamento virar requisito — ver follow-ups.
- **Verificado só em unit** (Meta mockada). O caminho `subscribeWabaApp` **não**
  foi exercitado e2e contra a Meta real. Risco: shape de erro ou semântica de
  idempotência real da Meta podem divergir do mock. Mitigação: smoke/e2e contra
  Meta sandbox antes do go-live do onboarding self-service.
- **Toca o invariante CLAUDE.md §4.4 (tokens Meta nunca em log/response/Sentry):**
  `subscribeWabaApp` recebe o `access_token` em claro (decifrado em memória,
  durante o callback, antes de persistir). Aceito desde que o token permaneça
  variável local de escopo de função e a chamada Meta passe pelo
  `serializeErrorRedacted` em erro — **nenhum** log/response desta etapa pode
  carregar `access_token` nem o header `verify_token`/`X-Hub-Signature-256`.
  Confronto com `.claude/rules/secrets-never-log.md` é obrigatório no PR.

### Neutras

- Toca o invariante §4.9 (HMAC em todo webhook) e §4.10 (multi-WABA) **sem
  violá-los**: o inbound (`GET/POST /webhooks/meta`) já valida `verify_token`
  (`META_WEBHOOK_VERIFY_TOKEN`) e HMAC (`META_WEBHOOK_APP_SECRET`, mesmo app) —
  nenhuma mudança na validação. O override apenas garante que os eventos
  cheguem à rota que já faz a validação.
- A chamada é idempotente no lado Meta — re-registrar uma WABA já inscrita é
  no-op seguro, então reconexão não precisa de tratamento especial.

## Plano de implementação

> Implementação já presente na branch `feat/waba-webhook-subscribe-override`
> (commits `4aa7017` + `82f09a7`; correção de doc `52ccadb`). Plano detalhado em
> `docs/superpowers/plans/2026-06-02-waba-webhook-subscribe-override.md`.

1. Adicionar `subscribeWabaApp(wabaId, accessToken, { callbackUri, verifyToken })`
   ao `MetaOAuthClient` em `src/integration/meta-client.ts` — faz
   `POST /{waba_id}/subscribed_apps` com `override_callback_uri` + `verify_token`.
2. Em `handleWabaCallback` (`src/modules/wabas/service.ts`), chamar
   `subscribeWabaApp` **após** `discoverWaba` e **antes** de `encryptToken` /
   persistência. Falha aborta antes de persistir.
3. Guarda de config: exigir `META_WEBHOOK_VERIFY_TOKEN` setado
   (`errors.internal` se ausente) antes da chamada.
4. Confirmar que o inbound (`src/modules/inbound/routes.ts`) **já** valida
   `hub.verify_token` e HMAC — sem mudança nesta etapa.

### Critério de "Aceita"

- [ ] Carimbo do fundador (decisão arquitetural: reusar app compartilhado).
- [ ] Smoke/e2e contra Meta sandbox exercitando `subscribeWabaApp` (registro +
      recebimento de um evento real em `/webhooks/meta`) — fecha o risco
      "verificado só em unit".

### Follow-ups (fora de escopo desta ADR)

- **De-subscribe no `disconnectWaba`:** `DELETE /{waba_id}/subscribed_apps` ao
  desconectar uma WABA, para não deixar subscription órfã.
- **Worker de reconcile** de subscriptions órfãs / divergentes (WABA persistida
  sem subscription ativa, ou vice-versa).
- **Reabrir a decisão (Opção B, app dedicado)** se o isolamento meta-api↔V1
  virar requisito (ex.: V1 ganha WABAs vivas em produção e a partilha de
  `app_secret` passa a ser risco real).

## Referências

- PRD `bevox-meta-api-prd-v1.md` §10 (webhook delivery).
- ADR MA-004 — Multi-WABA por tenant (onboarding OAuth/Embedded Signup).
- ADR MA-005 — Webhook delivery em três modos (entrega dos eventos inbound aos
  consumers; canonical em `bevox-knowledge/30_adr/bevox-meta-api/`).
- ADR MA-008 — Cifra de tokens Meta (envelope encryption; token decifrado em
  memória durante o callback).
- `docs/superpowers/plans/2026-06-02-waba-webhook-subscribe-override.md` (plano).
- `.claude/rules/secrets-never-log.md` (confronto §4.4 — token/verify_token).
- [Meta — Subscribe to webhooks per WABA / `subscribed_apps` override](https://developers.facebook.com/docs/whatsapp/cloud-api/guides/set-up-webhooks).
