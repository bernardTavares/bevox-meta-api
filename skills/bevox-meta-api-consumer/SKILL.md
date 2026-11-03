---
name: bevox-meta-api-consumer
description: Use ao integrar um projeto da família Bevox com a bevox-meta-api para WhatsApp Business / Instagram (embedded signup, OAuth, mensageria, webhooks). Cobre cliente HTTP, JWT RS256, idempotência, validação HMAC, modos de inbound (push/SSE/polling) e fluxo OAuth. NÃO use quando o projeto fala direto com graph.facebook.com (esse é o caso do bevox-backend V1 hoje).
---

# bevox-meta-api — Consumer Integration Skill

Você está em um projeto da família Bevox que precisa enviar/receber mensagens WhatsApp ou Instagram. A `bevox-meta-api` é um **serviço HTTP interno** centralizado: ela cuida de OAuth Meta, cifra de tokens, refresh, webhooks da Meta, normalização de eventos. Seu projeto NUNCA toca em `graph.facebook.com` nem em `access_token`.

## Quando usar esta skill

- Você está implementando "Conectar WhatsApp" / Embedded Signup em um app Bevox.
- Você está enviando mensagens (template, texto, mídia) ou recebendo eventos da Meta.
- Você está provisionando um app consumidor novo na meta-api.
- Você está debugando 401/403/HMAC inválido ao falar com a meta-api.

## Quando NÃO usar

- O projeto fala direto com `graph.facebook.com` (ex.: bevox-backend V1, que tem integração embedded até decidir migrar).
- Você está modificando a própria `bevox-meta-api` — para isso, leia `prds/bevox-meta-api-prd-v1.md` e `docs/adr/MA-001..MA-008`.

## Modelo mental em 30 segundos

```
Seu projeto (consumidor) ──HTTPS+JWT RS256──► bevox-meta-api ──► graph.facebook.com
       ▲                                            │
       └──────── webhook push / SSE / polling ──────┘
```

- **Identidade:** cada projeto tem `app_id` + par RSA. Provisionado uma vez via CLI admin.
- **Auth:** JWT RS256 efêmero (≤ 5min) assinado com a chave privada, `kid` no header.
- **Tenants:** seu `workspace_id` (ou conceito equivalente) vira um Tenant na meta-api via `external_id`.
- **OAuth:** seu projeto chama `connect/init` → recebe `oauth_url` → redireciona usuário → callback volta para a meta-api (não para você) → meta-api redireciona o usuário para o `redirect_url` que você passou.
- **Tokens Meta:** vivem cifrados na meta-api (envelope encryption, MA-008). Seu projeto **nunca** os vê.

## Regras invioláveis (5)

1. **Tokens Meta nunca passam pelo seu projeto.** Se está pensando em ler `access_token`, parou na trilha errada.
2. **Idempotency-Key obrigatório** em toda mutação (`POST/PUT/PATCH/DELETE`), derivado de evento de domínio (não aleatório).
3. **HMAC obrigatório** ao receber webhook push (`X-Bevox-Signature: t=<ts>,v1=<hex>`). Falha = drop.
4. **`X-Tenant-Id` obrigatório** em endpoints scoped por tenant. Sem ele = 403.
5. **JWT vida ≤ 300s.** Maior que isso é rejeitado como `INVALID_INPUT`.

## Mapa de referências (carregue sob demanda)

| Quando você está… | Leia |
|---|---|
| Começando do zero, primeira integração | `references/01-mental-model.md` |
| Implementando assinador JWT | `references/02-jwt-signing.md` + `snippets/jwt-signer.ts` |
| Implementando "Conectar WhatsApp" / Embedded Signup | `references/04-oauth-embedded-signup.md` |
| Recebendo webhooks push (recomendado) | `references/05-webhooks-hmac.md` + `snippets/webhook-handler-*.ts` |
| Sem URL pública (NAT, etc.) — escolhendo SSE ou polling | `references/06-events-sse-polling.md` |
| Tratando erros / mapeando para o domínio | `references/07-error-codes.md` |
| Escolhendo `Idempotency-Key` correto | `references/08-idempotency.md` |
| Lista completa de endpoints + scopes | `references/03-endpoints.md` |
| Provisionando app novo / checklist completo | `references/09-checklist.md` |

## Fluxo recomendado para Embedded Signup (caminho mais comum)

1. Admin provisiona `consumer_app` (CLI). Você guarda `app_id`, `key_id`, `private_key_pem` no secret manager. Veja `references/09-checklist.md`.
2. Implementa cliente HTTP com assinador JWT. Use `snippets/meta-api-client.ts` como base.
3. No bootstrap do workspace no seu produto, chama `POST /v1/tenants` (idempotente) e guarda o `tenant_id` retornado.
4. Registra subscription para webhook push (uma vez por ambiente): `POST /v1/webhooks/subscriptions` com filtro `["waba.connection_changed", "message.received", "message.status_updated"]`. Guarda o `signing_secret` retornado.
5. Botão "Conectar WhatsApp" no UI:
   - Backend chama `POST /v1/tenants/:tenant_id/wabas/connect/init` com `redirect_url`.
   - UI redireciona usuário para `oauth_url` retornado.
   - Usuário completa Embedded Signup na Meta.
   - Meta-api recebe callback, cifra token, redireciona usuário para seu `redirect_url?success=true&waba_connection_id=...`.
6. Backend recebe webhook `waba.connection_changed` (status `active`) e marca canal como conectado no domínio do projeto. Idempotente — pode chegar pelo redirect também, o que vier primeiro.

Detalhe completo: `references/04-oauth-embedded-signup.md`.

## Snippets prontos

- `snippets/jwt-signer.ts` — assinador RS256 com `jose` (Node).
- `snippets/meta-api-client.ts` — cliente HTTP fino com assinatura + idempotency + retry.
- `snippets/webhook-handler-fastify.ts` — handler push em Fastify com validação HMAC.
- `snippets/webhook-handler-nextjs.ts` — handler push em Next.js Route Handler.

## Fonte canônica e versionamento

Esta skill é **derivada** de:

- `docs/architecture/consumer-integration-guide-v1.md` (guia oficial, leitura nº 1).
- `docs/architecture/openapi.yaml` (contratos formais V1).
- ADRs MA-002 (auth), MA-004 (multi-WABA), MA-005 (webhook delivery), MA-006 (idempotência), MA-008 (cifra de tokens).

Quando a meta-api lança nova versão, atualizar esta skill é parte do mesmo PR. **Em caso de conflito entre skill e fontes canônicas, as fontes ganham** — abra issue.
