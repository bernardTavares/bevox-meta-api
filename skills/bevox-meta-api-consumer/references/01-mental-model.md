# 01 — Modelo mental

## A meta-api é um serviço HTTP, não uma biblioteca

Não importa, não embute, não copia código. Cada projeto consumidor fala com **uma única instância** rodando em algum lugar (cluster), via HTTPS, em rede privada (`meta-api.internal`).

```
                ┌─────────────────────────────┐
                │   bevox-meta-api            │
                │   1 deploy, 1 banco,        │
                │   1 Redis                   │
                │                             │
                │   - OAuth Meta              │
                │   - Tokens cifrados (KMS)   │
                │   - Refresh automático      │
                │   - Webhooks Meta           │
                │   - Normalização de eventos │
                └──┬─────────┬─────────┬──────┘
                   │ HTTPS   │ HTTPS   │ HTTPS
                   │ (JWT)   │ (JWT)   │ (JWT)
              ┌────┴───┐ ┌───┴────┐ ┌──┴─────┐
              │ Proj A │ │ Proj B │ │ Proj C │
              │ app:1  │ │ app:2  │ │ app:3  │
              │ RSA A  │ │ RSA B  │ │ RSA C  │
              └────────┘ └────────┘ └────────┘
```

## O que cada projeto consumidor é responsável

- Implementar **cliente HTTP fininho** com assinador JWT.
- Mapear seu conceito de "workspace/conta/organização" para Tenant na meta-api (1:1 via `external_id`).
- Expor UI com botão "Conectar WhatsApp"/"Conectar Instagram" que dispara o fluxo OAuth.
- Receber eventos via push (URL HTTPS interna), SSE (long-lived GET) ou polling (loop GET + ack).
- Validar HMAC em todo evento push recebido.
- Registrar `Idempotency-Key` derivado de evento de domínio em toda mutação.

## O que cada projeto NÃO faz (delegado à meta-api)

- Registrar app no Meta Developer (a meta-api tem o app Meta compartilhado).
- Implementar OAuth com a Meta (init, callback, troca code→token).
- Guardar/cifrar tokens.
- Implementar refresh / detectar expiração / reauth.
- Validar HMAC dos webhooks da Meta (a meta-api faz isso antes de roteat para você).
- Lidar com `graph.facebook.com` em qualquer forma.
- Saber detalhes de versão da Graph API.

## Os 4 canais de comunicação

```
1. OUTBOUND HTTP — você → meta-api
   POST /v1/messages, /v1/templates, /v1/tenants ...
   Auth: JWT RS256 efêmero
   Headers: X-Tenant-Id, Idempotency-Key, X-Request-Id

2. INBOUND — meta-api → você (escolha 1 dos 3 modos)
   a) Push: meta-api faz POST na sua URL HTTPS interna
   b) SSE:  você abre GET /v1/events/stream e fica lendo
   c) Polling: você faz GET /v1/events?since=<cursor> em loop + ack

3. OAuth handoff — usuário-final autoriza WhatsApp/IG
   seu UI redireciona para oauth_url gerada por /v1/.../connect/init
   callback Meta volta para a meta-api (não para você)
   meta-api redireciona usuário para seu redirect_url ao final

4. Operação humana — admin via CLI bevox-meta-api-cli
   provisionar apps, rotacionar chaves, replay de dead-letter
```

## Identidade e isolamento

- Cada projeto recebe `app_id` (UUIDv7) + `key_id` + `private_key_pem` (mostrada **uma única vez** no provision).
- A meta-api só guarda a chave **pública**.
- Queries são 100% scoped por `app_id` no plugin `tenant-scope` da meta-api. **Impossível por design** um projeto ver tenants de outro.

## Tenants

O conceito de "tenant" na meta-api é opaco — ela não sabe se é "clínica", "estúdio", "empresa". Você manda:

```json
{ "external_id": "<seu_workspace_id>", "display_name": "Clínica X" }
```

Recebe um `tenant_id` UUIDv7. Guarda no seu banco junto do seu `workspace_id`. Daí em diante, toda chamada usa `X-Tenant-Id: <tenant_id>`.

## Multi-WABA

Cada tenant pode ter **múltiplas WABAs** (WhatsApp Business Accounts) e múltiplos números. Quando o usuário conecta WhatsApp, ele autoriza acesso da meta-api às WABAs dele — pode ser 1, pode ser várias. ADR MA-004.

Não compartilhe WABA entre tenants. Não compartilhe tenant entre apps consumidores. Multi-tenancy é rígido.
