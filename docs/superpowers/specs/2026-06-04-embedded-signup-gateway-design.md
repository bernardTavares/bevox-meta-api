# Embedded Signup (COEX) — lado gateway (bevox-meta-api) — Design

**Data:** 2026-06-04 · **Status:** Aprovado (brainstorm) · **Repo:** bevox-meta-api (implementação é aqui)

## Contexto

Hoje o gateway faz **OAuth-redirect puro** (`buildAuthorizeUrl` → `/dialog/oauth`; `handleWabaCallback` no `GET /v1/oauth/waba/callback`). Não há Embedded Signup — o docstring "Embedded Signup" em `meta-oauth.ts` é enganoso. Resultado: só conecta quem **já tem uma WABA**. Para clientes onboardarem do zero pela tela do Bevox (Tech Provider), precisamos do **Embedded Signup (COEX)** — o sub-projeto 2 do PRD de migração.

O **SDK do Facebook roda no front do consumer** (bevox-direct/web); este spec cobre **só o lado gateway**. Divisão:
- **Front (bevox-direct/web):** `FB.login({config_id, ...})` → recebe `{code, waba_id, phone_number_id}` via `message` event → manda pro backend do bevox-direct.
- **Backend (bevox-direct/api):** chama o gateway (`connect/init` p/ pegar config_id; `connect/complete` com o code).
- **Gateway (este repo):** expõe `config_id`; troca code→token; cifra+persiste; registra webhook per-WABA. **O token Meta fica só aqui.**

## Decisões (brainstorm)

1. **Manter os dois fluxos:** ES vira o primário; o OAuth-redirect continua (legado) pra quem "traz a própria WABA". O refactor faz os dois compartilharem a lógica.
2. **Registro de número fora de escopo:** `connect/complete` faz só **exchange + persist + subscribe**. O `/register` (+ PIN 2FA) é follow-up separado (em COEX o número costuma já vir registrado).

## Mudanças (grounded em file:line)

### 1. Config — expor `config_id`
- `src/config/env.ts` (~bloco "Meta credentials", linha ~60): adicionar `META_ES_CONFIG_ID: optionalString`. **E `.env.example`** com a entrada (comentada).
- `src/modules/wabas/schemas.ts` (`InitOAuthResponse`, ~linha 19): adicionar `config_id?: string`.
- `src/modules/wabas/service.ts` (`initWabaOAuth`, ~linha 34-65): incluir `config_id: env().META_ES_CONFIG_ID` na resposta (pode ser `undefined` → consumer cai no redirect).
- `src/modules/wabas/routes.ts` (`POST .../connect/init`, ~linha 16): sem mudança de assinatura — só repassa o campo novo.

### 2. Novo endpoint — `POST /v1/tenants/:tenant_id/wabas/connect/complete`
- `src/modules/wabas/routes.ts`: nova rota, autenticada (scope `wabas:write`), `Idempotency-Key` obrigatório.
- `src/modules/wabas/schemas.ts`: novo `embeddedSignupCompleteBodySchema = { code: string (1..2048), waba_id?: string, phone_number_id?: string }`.
- `src/modules/wabas/service.ts`: nova `completeEmbeddedSignup({appId, tenantId, code, wabaIdHint?, phoneNumberIdHint?})` → `WabaConnectionResponse`.
  - valida tenant (helper) → `exchangeCode(code)` (sem redirect_uri — ver §4) → **SEMPRE `discoverWaba`** → `subscribeWabaApp` → cifra+persiste → `toResponse`.
  - **Correção do double-check (ALTA):** NÃO pular o `discoverWaba`. Ele é o único que traz `meta_business_id` / `display_name` / `verified_status`, **obrigatórios** no persist E no AAD da cifra (`meta-client.ts:discoverWaba`, `service.ts:174-185`). Usar o `waba_id` cru do widget abriria bypass de validação. O `wabaIdHint` vira no máximo cross-check (`assert discovery.meta_waba_id === wabaIdHint`); o `phone_number_id` é só informativo (usado no follow-up de `/register`).
  - **Idempotência (double-check):** o plugin só cacheia respostas **2xx** (`idempotency.ts` hook `onSend`) — então uma tentativa que falhar (ex.: 502 no subscribe, antes de persistir) **NÃO** é cacheada e o retry re-executa limpo. Comportamento correto, igual ao redirect.

### 3. Refactor — compartilhar lógica entre redirect e complete
Extrair de `handleWabaCallback` (`service.ts:90-185`) helpers reutilizáveis:
- `validateActiveTenant(appId, tenantId)` (lines ~101-112)
- `subscribeAndPersistWaba({tenantId, appId, discovery, accessToken, expiresIn})` — encapsula `subscribeWabaApp` + `encryptToken` + persist/reconnect (lines ~118-168).
`handleWabaCallback` (redirect) e `completeEmbeddedSignup` (ES) passam a chamar os helpers. Sem mudança de comportamento no redirect.

### 4. `exchangeCode` — `redirect_uri` opcional
- `src/integration/meta-client.ts` (`exchangeCode`, ~linha 259): tornar `redirectUri?` opcional; se ausente, não enviar no `/oauth/access_token`. Os 2 callers atuais (`wabas/service.ts`, `ig/service.ts`) continuam passando o redirect_uri → **não quebram** (confirmado no double-check).

### Itens de verificação empírica (staging, com um code/token real de ES)
1. **`redirect_uri` no exchange de ES** — provavelmente **não** é necessário (o code vem do widget, não de redirect). Se a Meta exigir, manter obrigatório.
2. **`discoverWaba` com token de ES** — ES dá um token de *Business Integration System User*; o `discoverWaba` usa `/debug_token` + `granular_scopes`. Confirmar que o shape de scopes é o mesmo de um user token; se diferir, ajustar a descoberta. **Risco a fechar no staging.**

### 5. OpenAPI
- `docs/architecture/openapi.yaml`: `config_id` opcional na resposta do `connect/init`; nova rota `POST .../wabas/connect/complete` (body `{code, waba_id?, phone_number_id?}` → `WabaConnection`).

## Contratos

```
POST /v1/tenants/{tenant_id}/wabas/connect/init   (inalterado + campo novo)
  → 202 { oauth_url, state, expires_in_seconds, config_id? }
     (config_id presente ⇒ consumer usa Embedded Signup; ausente ⇒ usa oauth_url/redirect)

POST /v1/tenants/{tenant_id}/wabas/connect/complete   (NOVO)
  headers: Authorization (wabas:write) + Idempotency-Key
  body: { code: string, waba_id?: string, phone_number_id?: string }
  → 200 WabaConnection   |   400 INVALID_INPUT | 401 | 422 IDEMPOTENCY_CONFLICT | 502 META_REJECTED
```

## Contrato Meta (confirmado na pesquisa — com correção)

- Front: `FB.login({ config_id, response_type:'code', override_default_response_type:true, extras:{ feature:'whatsapp_embedded_signup', sessionInfoVersion:3 } })`. `config_id` substitui `scope`.
- `message` event: `{ waba_id, phone_number_id, code }`.
- Exchange: `GET/POST https://graph.facebook.com/{ver}/oauth/access_token` com `client_id`, `client_secret`, `code` (sem `redirect_uri` — verificar). **CORREÇÃO:** é `graph.facebook.com`, NÃO `graph.instagram.com` (erro na pesquisa; nosso `meta-client.ts` já usa o host certo).
- Pós-onboard: `POST /{waba_id}/subscribed_apps` (✓ já implementado, MA-015).
- Permissões: `whatsapp_business_management` + `whatsapp_business_messaging` (Advanced Access) + business verification do Tech Provider.

## Fora de escopo

- **Registro do número** (`/register` + PIN, `request_code`/`verify_code`) — follow-up separado.
- **Front / FB SDK** — é trabalho do bevox-direct (já há prompt entregue).
- **Detalhes de COEX** (migração de número de WhatsApp Business app existente) além do que o widget entrega.
- **`config_id` setup no App Dashboard** — ato manual (cria a Configuration de Facebook Login for Business → gera o `config_id`).

## Testes

- **Unit:** `completeEmbeddedSignup` happy-path (mock client: exchange → subscribe → persist; assert `subscribeWabaApp` chamado, token cifrado, sem plaintext); `waba_id` hint pula `discoverWaba`; falha de exchange → 502; falha de subscribe → aborta antes de persistir (mesma invariante do redirect). `initWabaOAuth` devolve `config_id` quando env setado, `undefined` quando não.
- **Refactor:** os testes existentes de `handleWabaCallback` (`callback.test.ts`) continuam verdes (sem mudança de comportamento).
- **Verify (manual/staging):** exchange de ES sem `redirect_uri` contra a Meta — confirma o item §4.

## Definição de pronto

`META_ES_CONFIG_ID` + `connect/init` devolvendo config_id + `connect/complete` (exchange+persist+subscribe) + refactor com `callback.test.ts` verde + OpenAPI atualizado + unit do `complete` verde. Item de `redirect_uri` verificado (ou marcado como pendência de staging).

## Referências

- ADR MA-015 (webhook per-WABA via `subscribed_apps`), MA-004 (multi-WABA), MA-008 (cifra de token).
- PRD de migração `bevox-knowledge/35_specs/bevox-direct/2026-05-07-bevox-meta-api-migration-prd.md` (sub-projeto 2 = Embedded Signup).
- Meta: developers.facebook.com → WhatsApp Embedded Signup + Facebook Login for Business (host correto: `graph.facebook.com`).
