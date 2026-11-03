# 09 — Checklist de integração

Sequência completa para um projeto novo da família Bevox passar de zero a "manda mensagem WhatsApp em produção".

## Fase 1 — Provisionamento (admin, uma vez por projeto)

- [ ] Admin roda no cluster da meta-api:
  ```bash
  pnpm cli apps create --name "<nome-do-projeto>"
  ```
- [ ] Saída do comando guardada com cuidado (mostrada **uma única vez**):
  - `app_id` → vai para env do projeto novo (`META_API_APP_ID`)
  - `key_id` → vai para env (`META_API_KEY_ID`)
  - `private_key_pem` → vai para **secret manager** (Vault, AWS SM, GCP SM, k8s Secret).
- [ ] Admin registra `redirect_url` allowlist do projeto novo (callback OAuth precisa estar aqui).
- [ ] Admin documenta no projeto novo: link do runbook de rotação anual de chave.

## Fase 2 — Cliente HTTP no projeto novo

- [ ] Implementar assinador JWT (ver `references/02-jwt-signing.md` + `snippets/jwt-signer.ts`).
- [ ] Implementar cliente HTTP com:
  - [ ] Header `Authorization: Bearer <jwt>` em toda call.
  - [ ] Header `X-Tenant-Id` em chamadas tenant-scoped.
  - [ ] Header `Idempotency-Key` em mutações, derivado de evento de domínio.
  - [ ] Geração de `X-Request-Id` UUIDv7 (opcional; meta-api gera se ausente).
  - [ ] Retry com backoff em 429/5xx, **mesma key**.
  - [ ] Tratamento de erro canônico (`UNAUTHENTICATED`, `META_REJECTED`, etc.).
- [ ] Configurar timeout cliente: 15s (meta-api respeita 10s; deixe folga).
- [ ] Logging: `request_id`, `endpoint`, `latency_ms`, `tenant_id`. **Nunca** o JWT inteiro.

## Fase 3 — Modelo de dados do consumidor

- [ ] Adicionar coluna `bevox_meta_api_tenant_id` (UUID) na entidade que representa workspace/conta/organização.
- [ ] Adicionar tabela ou colunas para `waba_connections` (status, waba_id, phone_number_ids) — **sem token**, só metadata.
- [ ] Adicionar tabela `processed_events` (event_id PRIMARY KEY) para idempotência no recebimento.

## Fase 4 — Bootstrap de tenant (lazy)

- [ ] No primeiro acesso de um workspace que precise de canal: chamar `POST /v1/tenants` com `Idempotency-Key: tenant-bootstrap-{workspace_id}`.
- [ ] Guardar `tenant_id` retornado.
- [ ] Idempotência: 2ª chamada retorna o mesmo tenant; não falhe se já existe.

## Fase 5 — Subscription para webhooks (uma vez por ambiente)

- [ ] Decidir modo: push (recomendado) / SSE / polling.
- [ ] Se push:
  - [ ] Expor URL HTTPS interna (`/webhooks/meta-api`).
  - [ ] Garantir alcançabilidade pela rede da meta-api.
  - [ ] Implementar handler com validação HMAC raw-body (ver `references/05-webhooks-hmac.md`).
  - [ ] Implementar idempotência por `event_id`.
- [ ] Chamar `POST /v1/webhooks/subscriptions` com `event_types_filter` adequado.
- [ ] Guardar `signing_secret` no secret manager.
- [ ] Testar entrega: forçar evento `waba.connection_changed` em sandbox.

## Fase 6 — UI "Conectar WhatsApp"

- [ ] Botão dispara request ao seu backend.
- [ ] Backend chama `POST /v1/tenants/{tenant_id}/wabas/connect/init` com `redirect_url`.
- [ ] Backend retorna `oauth_url` (ou redireciona direto 302).
- [ ] Página `/post-oauth` no seu projeto:
  - [ ] Lê `success`, `waba_connection_id`, `reconnected` da query string.
  - [ ] Mostra estado conectado/erro.
  - [ ] Marca canal como `pending` (aguardando webhook confirmar).
- [ ] Handler de `waba.connection_changed`:
  - [ ] Marca canal como `active` quando `data.status === "active"`.
  - [ ] Idempotente com o redirect (`(waba_connection_id, status)` chave).

## Fase 7 — Envio de mensagem (caso "happy path")

- [ ] Implementar envio de template de teste:
  ```http
  POST /v1/messages
  X-Tenant-Id: {tenant_id}
  Idempotency-Key: test-msg-{id_único}
  
  {
    "channel": "whatsapp",
    "to": "+5511999999999",
    "type": "template",
    "template": { "name": "hello_world", "language": "pt_BR" }
  }
  ```
- [ ] Receber `message.status_updated` (sent → delivered → read) via webhook.

## Fase 8 — Testes contra sandbox Meta

- [ ] Configurar variáveis para apontar à meta-api em staging (`META_API_BASE_URL`).
- [ ] Realizar fluxo OAuth completo com conta de teste Meta.
- [ ] Enviar e receber mensagens.
- [ ] Forçar erros (template inválido, número errado) para validar mapeamento de erro.
- [ ] Forçar reconnect (revogar permissão na Meta) e validar evento `waba.connection_changed: disconnected`.

## Fase 9 — Pré go-live

- [ ] Variáveis de produção populadas (`META_API_BASE_URL=https://meta-api.internal`).
- [ ] Secret manager carregado com `META_API_PRIVATE_KEY` + `META_API_WEBHOOK_SIGNING_SECRET`.
- [ ] Subscription criada no ambiente de prod com URL de prod.
- [ ] Smoke test: `pnpm smoke` no projeto consumidor (se existir helper) ou curl manual ao `/healthz`.
- [ ] Logging/observability conectados (request_id correlaciona com Grafana da meta-api).
- [ ] Runbook do projeto consumidor atualizado: "como tratar webhook em dead-letter", "como rotacionar chave RSA do consumer".

## Fase 10 — Go-live e monitoramento

- [ ] Acompanhar métricas: latência das chamadas à meta-api, taxa de erro, recebimento de webhooks.
- [ ] Alarme em: subscription pausada, taxa de `META_REJECTED` anormal, taxa de HMAC inválido (deveria ser zero).
- [ ] Calendário de rotação anual de chave RSA no calendário do time.

## Variáveis de ambiente do projeto consumidor

```dotenv
# Identidade
META_API_APP_ID=01HX...
META_API_KEY_ID=01HX...
META_API_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\n...

# Endpoint
META_API_BASE_URL=https://meta-api.internal

# Webhook
META_API_WEBHOOK_SIGNING_SECRET=<32 bytes base64>
META_API_WEBHOOK_PATH=/webhooks/meta-api
```

## Anti-checklist (sinais de que você foi pra trilha errada)

- ❌ Você está armazenando `access_token` da Meta em qualquer lugar do projeto.
- ❌ Você está chamando `graph.facebook.com` direto.
- ❌ Você está implementando OAuth com a Meta (init / callback / troca code).
- ❌ Você está validando HMAC da Meta (X-Hub-Signature) em algum lugar.
- ❌ Você está implementando refresh de token.
- ❌ Sua `Idempotency-Key` é `Date.now()` ou `randomUUID()`.
- ❌ Você está usando o mesmo `app_id` em mais de um projeto.

Se qualquer ❌ for verdadeiro, pare e releia `references/01-mental-model.md`.
