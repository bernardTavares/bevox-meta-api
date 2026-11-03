# 04 — OAuth + Embedded Signup (WhatsApp e Instagram)

Caminho mais comum: usuário-final do seu produto clica "Conectar WhatsApp" e autoriza acesso à WABA dele. Tudo é orquestrado pela meta-api.

## Pré-requisitos no seu projeto

- `app_id`, `key_id`, `private_key_pem` provisionados (uma vez por projeto).
- Tenant criado para o workspace do usuário (`POST /v1/tenants`, idempotente).
- Subscription ativa para `waba.connection_changed` (uma vez por ambiente, ver `references/05-webhooks-hmac.md`).

## Fluxo completo (WhatsApp)

```
[Usuário]  [Seu UI]  [Seu Backend]  [bevox-meta-api]  [Meta]
   │          │           │               │            │
   │ click    │           │               │            │
   │─────────▶│           │               │            │
   │          │ POST .../wabas/connect/init             │
   │          │──────────▶│               │            │
   │          │           │ POST .../init │            │
   │          │           │──────────────▶│            │
   │          │           │               │ gera state │
   │          │           │               │ (Redis 10m)│
   │          │           │ {oauth_url}   │            │
   │          │           │◀──────────────│            │
   │          │ 302 Redirect oauth_url    │            │
   │          │◀──────────│               │            │
   │ navega   │           │               │            │
   │──────────────────────────────────────────────────▶│
   │                                                   │
   │   Embedded Signup                                 │
   │   (telas Meta — login, seleção                    │
   │    de WABAs, autorização)                         │
   │                                                   │
   │ callback Meta → ?code=...&state=...               │
   │                                ┌──────────────────│
   │                                ▼
   │                          /v1/tenants/.../wabas/connect/callback
   │                                │
   │                                │ valida state
   │                                │ troca code → token
   │                                │ cifra com KMS (envelope)
   │                                │ persiste waba_connection
   │                                │ enfileira webhook
   │                                │
   │                          302 Redirect → seu redirect_url?success=true&...
   │◀───────────────────────────────│
   │
   │ (paralelo) webhook waba.connection_changed
   │           ┌─────────────────────────────►│ POST seu /webhooks/meta-api
   │                                          │
```

## Passo 1 — Backend chama init

```http
POST /v1/tenants/{tenant_id}/wabas/connect/init HTTP/1.1
Host: meta-api.internal
Authorization: Bearer <jwt scope=wabas:write>
X-Tenant-Id: {tenant_id}
Idempotency-Key: waba-connect-{tenant_id}-{timestamp_minuto}
Content-Type: application/json

{
  "redirect_url": "https://your-app.example.com/post-oauth"
}
```

Resposta:
```json
{
  "oauth_url": "https://www.facebook.com/v21.0/dialog/oauth?client_id=...&state=...&scope=...",
  "state": "01HX...",
  "expires_in_seconds": 600
}
```

Observações:
- O `state` tem TTL de 10 minutos. Se o usuário demorar mais que isso, callback falha e ele precisa começar de novo.
- `redirect_url` deve ser HTTPS e estar em allowlist (configurada no provisionamento do app consumidor — pergunta para admin).
- `Idempotency-Key` derivado do `tenant_id` + janela de tempo curta evita duplicar `state` se o usuário clicar 2x rápido.

## Passo 2 — UI redireciona

```ts
// Server-side (Next.js Route Handler ou similar)
const { oauth_url } = await metaApi.wabaConnectInit(tenantId, redirectUrl);
return Response.redirect(oauth_url, 302);
```

## Passo 3 — Usuário completa Embedded Signup na Meta

Telas da Meta. Você não tem controle aqui. O usuário:
1. Faz login no Facebook (se não estiver logado).
2. Seleciona ou cria a Business Manager.
3. Seleciona ou cria a WABA.
4. Seleciona ou registra o número de telefone.
5. Autoriza permissões (`whatsapp_business_management`, `whatsapp_business_messaging`, `business_management`).

## Passo 4 — Meta callback → meta-api

A URL de callback do app Meta aponta para a meta-api, **não para você**. Você nunca vê o `code` da Meta. A meta-api:

1. Valida `state` contra Redis.
2. Troca `code` por `access_token` na Meta.
3. Cifra token com envelope encryption (KMS DEK + AES-256-GCM, AAD = `{tenant_id, waba_id, app_id}`). Ver MA-008.
4. Persiste `waba_connection` (status `active`).
5. Enfileira evento `waba.connection_changed`.
6. Redireciona usuário para seu `redirect_url`.

## Passo 5 — Usuário aterrissa no seu app

URL final que o navegador do usuário recebe:
```
https://your-app.example.com/post-oauth?
  success=true&
  waba_id=123456789&
  waba_connection_id=01HX...&
  reconnected=false
```

Seu UI mostra "WhatsApp conectado!" com base nesses query params.

Em caso de erro:
```
https://your-app.example.com/post-oauth?
  success=false&
  error_code=OAUTH_DENIED&
  error_message=Usu%C3%A1rio+cancelou+autoriza%C3%A7%C3%A3o
```

Códigos de erro possíveis: `OAUTH_DENIED`, `STATE_EXPIRED`, `STATE_INVALID`, `META_REJECTED`, `INTERNAL`.

## Passo 6 — Backend recebe webhook (idempotente com o redirect)

```json
POST /webhooks/meta-api  (sua URL registrada na subscription)
X-Bevox-Signature: t=1714003200,v1=<hex_hmac_sha256>
Content-Type: application/json

{
  "event_id": "01HX...",
  "event_type": "waba.connection_changed",
  "tenant_id": "01HY...",
  "occurred_at": "2026-04-27T12:00:00Z",
  "data": {
    "waba_connection_id": "01HZ...",
    "waba_id": "123456789",
    "status": "active",
    "previous_status": "pending",
    "phone_numbers": [
      { "phone_number_id": "987...", "display_phone_number": "+5511..." }
    ]
  }
}
```

Você marca o canal como `active` no domínio do seu produto. Idempotente: `(waba_connection_id, status)` como chave; se já marcou pelo redirect, este webhook é no-op.

## Fluxo Instagram

Análogo. Endpoints:

- `POST /v1/tenants/{tenant_id}/ig-accounts/connect/init` (scope `ig:write`)
- Callback Meta interno (você não chama).
- Evento `ig.connection_changed`.

A Meta exige que a conta IG seja Business/Creator e esteja conectada a uma Página do Facebook. A meta-api **não** valida isso por você antes de iniciar — se o usuário não atender o pré-requisito, ele recebe erro na tela da Meta. Documente isso na sua UI.

## Reconexão / reauth

Quando token expira / é revogado, meta-api dispara `waba.connection_changed` com status `disconnected`. Seu UI mostra "Reconectar WhatsApp"; o fluxo é o mesmo `connect/init` — meta-api detecta WABA existente e chama de "reconnected".

## Erros operacionais comuns

| Sintoma | Causa |
|---|---|
| Usuário fica preso na tela final do Facebook | `redirect_url` não está em allowlist do app consumidor. Conferir com admin. |
| Callback retorna `STATE_EXPIRED` | Usuário demorou > 10min entre clicar e completar. Reiniciar fluxo. |
| `META_REJECTED` na resposta de `connect/init` | App Meta sem permissões aprovadas (`whatsapp_business_management`). App Review pendente. |
| Webhook `waba.connection_changed` não chega | Subscription inativa, URL inacessível pela meta-api, ou HMAC sendo rejeitado pelo seu handler. Veja `references/05-webhooks-hmac.md`. |

## Observações importantes

- **Token Meta nunca passa pelo seu projeto.** Se você está pensando em armazenar `access_token`, parou na trilha errada.
- **Refresh é automático.** Worker `token-refresh` da meta-api roda hourly.
- **Múltiplas WABAs por tenant** são suportadas. Mesmo `connect/init` pode resultar em N `waba_connection` se o usuário autoriza N WABAs. Você recebe N eventos.
