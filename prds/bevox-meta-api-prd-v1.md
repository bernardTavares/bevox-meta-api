# bevox-meta-api — PRD V1

## 1. Identificação

| Campo | Valor |
|---|---|
| Documento | PRD bevox-meta-api |
| Versão | 1.0 |
| Status | **Em uso (staging)** — implementação em staging single-host (Docker compose); primeiro consumer cutover delivered (bevox-backend Marco 4, 2026-05-20, per canon ADR-012); aguardando prod go-live per Go-Live Checklist V1 (`40_roadmap/bevox-meta-api/2026-04-25-bevox-meta-api-go-live-checklist-v1.md`; bloqueado por MA-012 LGPD posture + infra provisioning) |
| Data | 2026-04-25 |
| Autor | Bernard Tavares (founder); equipe de arquitetura Bevox |
| Revisores esperados | Bernard Tavares; engenharia Bevox quando constituída; advocacia (revisão LGPD da posição interna) |
| ADRs associadas | A criar: MA-001 (stack), MA-002 (auth model), MA-003 (tenancy model), MA-004 (multi-WABA), MA-005 (webhook delivery), MA-006 (idempotência), MA-007 (observabilidade) |
| Documentação correlata | `bevox-meta-api/README.md` (status); como **prior art** apenas: `prds/integracoes/whatsapp-integration-prd-v1.md` e `prds/integracoes/instagram-integration-prd-v1.md` na pasta-pai (estado embedded no Bevox V1 — não é estendido nem modificado por este documento) |

**Observação de escopo.** Este PRD descreve um **produto novo, autônomo**. Não é extração, refactor ou continuação de qualquer integração existente. O Bevox V1 mantém suas integrações Meta embedded conforme PRDs próprios, em paralelo. Eventual migração futura do Bevox para consumir esta API é decisão separada, com ADR específica, fora do escopo deste documento.

---

## 2. Propósito e visão

**A `bevox-meta-api` é a API HTTP unificada de integração com a Meta — encapsula WhatsApp Business Cloud API e Instagram Graph API atrás de uma superfície única, multi-app e multi-tenant, consumida exclusivamente por produtos internos da família Bevox.**

A API resolve quatro responsabilidades que, sem ela, seriam duplicadas em cada produto consumidor:

1. **Conhecimento Meta concentrado.** OAuth, webhooks, HMAC, refresh de tokens, códigos de erro, rate limits, gestão de templates — tudo isso é não-trivial. Centralizar evita que cada produto reescreva esse subsistema.
2. **Quota app-level protegida.** Meta Cloud API tem cotas por app Meta. Múltiplos produtos consumindo o mesmo app Meta sem coordenação se canibalizam. A `bevox-meta-api` aplica políticas de rate limit por app consumidor e por tenant.
3. **Surface única para os apps.** Cada produto interno consome um único contrato HTTP em vez de aprender duas APIs Meta distintas.
4. **Operação centralizada.** Rotação de tokens, replay de webhooks, dead-letter, observabilidade — runbooks e dashboards em um lugar único.

### Por que este produto é essencial

A família Bevox planeja construir múltiplos produtos baseados em conversa via WhatsApp e Instagram. Sem uma camada compartilhada, cada produto reescreve o mesmo subsistema, com versões diferentes de bugs e decisões. A `bevox-meta-api` é o que permite cada produto novo focar no seu domínio em vez de reaprender Meta.

### Por que este produto **não** é

- **Não é produto comercial.** Sem modelo de receita; sem consumidores externos; sem suporte público; sem SLA contratual.
- **Não é fork ou extração do `bevox-backend`.** O Bevox V1 segue com integrações embedded.
- **Não tem interface gráfica.** Pure HTTP API. Operação humana (admin) acontece via ferramentas internas (CLI, console, ou painel de outro produto da família).
- **Não armazena domínio de negócio.** Não persiste `Conversation`, `Message`, `Customer`, `Appointment`. Persiste apenas o que é específico da camada Meta (tokens, bindings, fila, eventos inbound, audit).
- **Não é gateway genérico de mensageria.** Foco exclusivo em produtos Meta. Twilio, SMS, e-mail, push são fora de escopo permanente.
- **Não é multi-region em V1.** Single-region; se o Bevox crescer multi-region, será V2.

---

## 3. Posicionamento no ecossistema

```
┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐
│  bevox-backend   │    │ futuro-produto-X │    │ futuro-produto-Y │
│   (Bevox V1)     │    │  (família Bevox) │    │  (família Bevox) │
└────────┬─────────┘    └────────┬─────────┘    └────────┬─────────┘
         │                       │                       │
         │  HTTPS + JWT (RS256) + Idempotency-Key + X-Tenant-Id
         └───────────────┬───────┴───────────────────────┘
                         │
                         v
            ┌────────────────────────────┐
            │      bevox-meta-api        │
            │                            │
            │  /v1/messages              │
            │  /v1/templates             │
            │  /v1/tenants               │
            │  /v1/wabas                 │
            │  /v1/webhooks/subscriptions│
            │  /v1/events/stream (SSE)   │
            │                            │
            │  Postgres (dedicado)       │
            │  Redis    (dedicado)       │
            │  BullMQ                    │
            └────┬───────────────────────┘
                 │ HMAC + Bearer
                 v
        ┌──────────────────────────────┐
        │   Meta Cloud API + Graph API │
        │   (WhatsApp + Instagram)     │
        └──────────────────────────────┘
                 │ webhooks (HMAC Meta)
                 v
        ┌──────────────────────────────┐
        │   bevox-meta-api inbound     │
        │   webhook handler            │
        └──────────────────────────────┘
                 │ HMAC + JSON push
                 v
            consumer apps (URLs registradas)
```

### 3.1 Conexões da bevox-meta-api

- **bevox-meta-api ← apps consumidores (HTTP):** envio outbound, gestão de tenants/WABAs/templates, registro de webhooks. Auth JWT RS256 emitido pela meta-api.
- **bevox-meta-api → Meta Cloud API + Graph API:** chamadas Bearer token. Refresh automático.
- **bevox-meta-api ← Meta (webhooks):** recepção de mensagens e eventos. HMAC Meta validado.
- **bevox-meta-api → apps consumidores (webhooks):** entrega de eventos roteados por tenant. HMAC próprio (chave secreta por subscription).
- **bevox-meta-api ↔ Postgres dedicado:** banco próprio, isolado dos bancos dos apps consumidores.
- **bevox-meta-api ↔ Redis dedicado:** filas, dedup, rate limit buckets, cache de tokens.
- **bevox-meta-api ↔ observabilidade:** OpenTelemetry → Grafana; Sentry para exceções.
- **bevox-meta-api ≠ Postgres dos apps consumidores:** zero acesso direto. Sem ORM compartilhado, sem schema cruzado.
- **bevox-meta-api ≠ OpenClaw:** sem conexão.

### 3.2 Princípios de fronteira

1. **Sem domínio de negócio.** A meta-api conhece `tenant_id` opaco. Não sabe que o tenant é uma "clínica" ou "estúdio" — esse conceito vive nos apps consumidores.
2. **Idempotência por contrato.** Toda mutação aceita Idempotency-Key. Reenvios são seguros.
3. **Tokens nunca saem.** Access tokens da Meta vivem cifrados no banco da meta-api e nunca são expostos aos apps consumidores.
4. **Webhooks Meta nunca chegam aos apps.** A Meta envia para a meta-api; a meta-api roteia (com sua própria assinatura) para os apps registrados.
5. **App consumidor é stateless em relação à Meta.** Não precisa saber se a Meta está caída — a meta-api tem retries internos.

---

## 4. Usuários e consumidores

### 4.1 App consumidor interno (papel `consumer_app`)

Um produto da família Bevox que consome a API. Identificado por `app_id`. Possui credenciais (par de chaves para JWT) emitidas pelo admin da meta-api.

**Por que essencial.** É o usuário primário. V1 começa com 1 consumidor (Bevox V1 backend, quando migrar) e abre espaço para futuros.

**Permissões.**
- CRUD em seus próprios tenants e bindings.
- Envio de mensagens, leitura de status.
- Registro/atualização de webhooks subscriptions.
- Não acessa tenants de outros apps.

### 4.2 Admin da meta-api (papel `admin`)

Operador humano interno (founder, eng) que provisiona apps consumidores e troubleshoot.

**Permissões.**
- CRUD em `consumer_app` (criar app novo, rotacionar chave, desativar).
- Acesso cross-app (visibilidade global) com audit log obrigatório.
- Replay de dead-letter, força refresh de token, desconecta WABA com falha.

**Como acessa.** V1: CLI (`bevox-meta-api-cli` rodando contra o cluster) ou endpoints `/admin/*` autenticados por chave administrativa rotacionada manualmente. Sem UI.

### 4.3 Tenant (papel modelo, não autenticado diretamente)

Entidade lógica do app consumidor, identificada por `tenant_id` opaco. Por exemplo, no Bevox um `workspace_id` mapeia 1:1 a um `tenant_id` na meta-api. O tenant nunca chama a API diretamente — sempre via app consumidor.

**Por que existe na meta-api.** Porque cada tenant traz seu próprio WABA (resposta do user à pergunta 5 da discovery). A meta-api precisa de uma entidade local para vincular WABA, números, contas IG, templates, etc.

### 4.4 Sub-tenant Meta (não autenticado)

Cada tenant possui:
- 0..N `WabaConnection` (WhatsApp Business Account vinculadas via OAuth Meta).
- 0..N `IgConnection` (Instagram Business accounts).
- 0..N `PhoneNumber` (números WhatsApp dentro de uma WABA).

Esses são objetos do domínio Meta, gerenciados pela meta-api em nome do tenant.

### 4.5 Meta (provedor externo)

Não é "usuário" stricto sensu. Tratada como sistema externo com SLA próprio (não controlável). A meta-api é resiliente a oscilações.

### 4.6 Engenharia interna (consumidor de desenvolvimento)

Equipe de eng que desenvolve a meta-api. Ambiente local com Postgres+Redis em Docker; sandbox Meta para testes; fixtures determinísticas em `docs/fixtures/`.

---

## 5. Escopo V1 — módulos

V1 entrega 14 módulos. Cada um declara objetivo, endpoints principais e regras chave.

### 5.1 Gestão de apps consumidores (admin-only)

**Objetivo.** Provisionar novos apps consumidores; gerenciar credenciais.

**Endpoints.**
- `POST /admin/apps` — cria app, retorna `app_id` e par RSA inicial.
- `GET /admin/apps` — lista todos os apps.
- `POST /admin/apps/:id/keys/rotate` — gera novo par; antigo válido por janela de grace.
- `POST /admin/apps/:id/deactivate` — desativa app; tokens emitidos viram inválidos.

**Regras.**
- App ID é UUIDv7.
- Chave privada RSA fornecida ao app uma única vez na criação. Meta-api guarda só a pública.
- App assina JWT localmente; meta-api verifica com pública.

### 5.2 Tenancy — CRUD de tenant

**Objetivo.** App consumidor cadastra e gerencia seus tenants na meta-api.

**Endpoints.**
- `POST /v1/tenants` — cria tenant. Body: `{ external_id?, display_name?, metadata }`.
- `GET /v1/tenants` — lista tenants do app autenticado.
- `GET /v1/tenants/:id` — detalhe.
- `PATCH /v1/tenants/:id` — atualiza metadata.
- `DELETE /v1/tenants/:id` — soft-delete (incompatível com WABAs ativas; retorna erro com lista de bindings).

**Regras.**
- `tenant_id` é UUIDv7 emitido pela meta-api.
- `external_id` é opcional, único por app — útil para o app mapear seu próprio domínio (`workspace_id` do Bevox, por exemplo).
- Soft-delete preserva audit log; hard-delete só via admin com flag explícita.

### 5.3 WABA enrollment (OAuth Meta)

**Objetivo.** Vincular uma WhatsApp Business Account ao tenant via OAuth da Meta.

**Endpoints.**
- `POST /v1/tenants/:id/wabas/connect/init` — inicia OAuth. Retorna URL Meta + state.
- `GET  /v1/tenants/:id/wabas/connect/callback` — callback OAuth (chamado pelo Meta).
- `GET  /v1/tenants/:id/wabas` — lista WABAs do tenant.
- `DELETE /v1/tenants/:id/wabas/:waba_id` — desconecta WABA.

**Regras.**
- Multi-WABA por tenant suportado em V1 (resposta da pergunta 5).
- Tokens armazenados cifrados (pgcrypto ou cifra na app layer).
- Refresh automático antes de expiração (7 dias antes para tokens long-lived da Meta).
- Webhook subscription com Meta criada na conexão.

### 5.4 Phone numbers (WhatsApp)

**Objetivo.** Listar e gerenciar números WhatsApp de uma WABA.

**Endpoints.**
- `GET  /v1/tenants/:id/wabas/:waba_id/phone-numbers` — lista phone numbers.
- `POST /v1/tenants/:id/wabas/:waba_id/phone-numbers/:phone_id/profile` — atualiza nome de exibição, sobre, foto.
- `POST /v1/tenants/:id/wabas/:waba_id/phone-numbers/:phone_id/two-step` — habilita PIN obrigatório Meta.

### 5.5 Instagram accounts

**Objetivo.** Análogo ao WABA mas para Instagram Business.

**Endpoints.**
- `POST /v1/tenants/:id/ig-accounts/connect/init` → `/callback` (OAuth via Facebook Login).
- `GET  /v1/tenants/:id/ig-accounts`.
- `DELETE /v1/tenants/:id/ig-accounts/:ig_id`.

### 5.6 Templates WhatsApp Business

**Objetivo.** Cobertura completa do ciclo de vida de templates: criar → submeter à aprovação Meta → enviar.

**Endpoints.**
- `POST /v1/tenants/:id/wabas/:waba_id/templates` — cria template; submete automaticamente à Meta.
- `GET  /v1/tenants/:id/wabas/:waba_id/templates` — lista com status (PENDING, APPROVED, REJECTED, PAUSED, DISABLED).
- `GET  /v1/tenants/:id/wabas/:waba_id/templates/:name/:language` — detalhe + categoria + qualidade.
- `POST /v1/tenants/:id/wabas/:waba_id/templates/:name/:language/resync` — força re-leitura do status na Meta.
- `DELETE /v1/tenants/:id/wabas/:waba_id/templates/:name/:language` — deleta na Meta.

**Regras.**
- Approve/reject vem assincronamente via webhook Meta — meta-api atualiza status localmente e propaga aos consumers via webhook próprio (`template.status_updated`).
- V1 suporta categorias UTILITY, MARKETING, AUTHENTICATION.
- Componentes: header, body, footer, buttons (URL, quick_reply, phone_number, OTP).

### 5.7 Outbound síncrono

**Objetivo.** Envio de mensagem com retorno imediato.

**Endpoint.**
- `POST /v1/messages`
  - Headers obrigatórios: `Authorization`, `X-Tenant-Id`, `Idempotency-Key`.
  - Body: `{ channel: "whatsapp"|"instagram", to, type, ... payload }`.
  - Resposta: `{ message_id, provider_message_id, status: "queued"|"sent"|"failed", error? }`.
- Bloqueia até resposta da Meta (timeout interno 10s).
- Ideal para fluxos transacionais (1 mensagem; resposta importa).

**Regras.**
- Mesmo `Idempotency-Key` em janela de 24h retorna o mesmo `message_id` sem duplicar envio.
- Erros 4xx Meta são propagados com mapping para códigos meta-api estáveis.

### 5.8 Outbound assíncrono

**Objetivo.** Envio em fila com callback ao consumer quando completo.

**Endpoint.**
- `POST /v1/messages/async`
  - Body idêntico ao sync + `callback_url` opcional, `callback_secret` opcional.
  - Resposta imediata: `{ job_id, status: "queued" }`.
- `GET /v1/jobs/:id` — consulta status do job.
- Quando job termina (success ou exhausted), meta-api faz HTTP POST ao `callback_url` com HMAC.
- Ideal para volume alto, broadcasts, ou casos onde o consumer não pode bloquear.

**Regras.**
- Fila BullMQ com prioridade configurável por tenant (anti-thundering-herd em broadcasts).
- Retry interno com backoff exponencial respeitando códigos Meta retryable.
- TTL de job: 7 dias.

### 5.9 Inbound — entrega aos consumers (3 modos)

**Objetivo.** Entregar eventos recebidos da Meta (mensagens novas, status updates, template updates) aos apps consumidores. **Modo "mais completo"** (resposta da pergunta 8): suporta os três modos abaixo simultaneamente; consumer escolhe.

#### 5.9.1 Webhook push (modo primário)

**Mecanismo.** Para cada subscription, meta-api faz `HTTP POST` para a URL registrada com payload + assinatura HMAC.

**Endpoints de gestão.**
- `POST /v1/webhooks/subscriptions` — registra URL + filtros (tenant_id?, event_types?). Retorna secret HMAC.
- `GET  /v1/webhooks/subscriptions` — lista.
- `DELETE /v1/webhooks/subscriptions/:id` — desregistra.
- `POST /v1/webhooks/subscriptions/:id/replay` — replay últimos N eventos.

**Regras.**
- Headers do POST: `X-Bevox-Signature: t=<ts>,v1=<hmac_sha256>`.
- Payload: JSON com `event_id`, `event_type`, `tenant_id`, `occurred_at`, `data`.
- Retry exponencial: imediato, 30s, 2min, 10min, 1h, 6h. Após esgotar, dead-letter.
- Status 2xx do consumer = ack. Outros = retry.
- Idempotência: consumer recebe `event_id` único; reentrega usa mesmo `event_id`.

#### 5.9.2 SSE stream (modo realtime)

**Mecanismo.** Consumer conecta uma vez; stream HTTP fica aberto; eventos chegam em tempo real.

**Endpoint.**
- `GET /v1/events/stream?cursor=<last_event_id>` — Server-Sent Events. Auth via JWT.

**Regras.**
- Reconexão automática usando `cursor`.
- Backpressure: se consumer não consome, conexão fecha após buffer cheio (10K eventos).
- Útil para consumer realtime que não quer overhead de webhook server.

#### 5.9.3 Polling de fila (modo fallback)

**Mecanismo.** Consumer faz GET periódico; meta-api retorna eventos novos desde último cursor.

**Endpoints.**
- `GET  /v1/events?since=<cursor>&limit=100` — eventos novos.
- `POST /v1/events/ack` — ack explícito.

**Regras.**
- Eventos não-acked permanecem visíveis no próximo poll.
- Útil para consumers atrás de NAT, ambientes que não aceitam webhook inbound.

#### 5.9.4 Tipos de evento V1

- `message.received` (whatsapp + instagram)
- `message.status_updated` (sent, delivered, read, failed)
- `template.status_updated`
- `waba.connection_changed`
- `phone_number.quality_changed`

### 5.10 Idempotência

**Objetivo.** Garantir que retries de consumers não dupliquem operações.

**Aplicação.** Obrigatória em todas mutações (`POST`, `PUT`, `PATCH`, `DELETE`) via header `Idempotency-Key`.

**Regras.**
- Janela: 24h.
- Mesma key + mesmo body = mesmo resultado armazenado, retorna sem reexecutar.
- Mesma key + body diferente = erro 422.
- Sem key em mutação = erro 400 (configurável por endpoint para começar com warning).
- Espelha ADR-023 do Bevox (referenciada como prior art em `docs/adr/ADR-023-idempotencia-em-tools-de-mutacao.md` da pasta-pai).

### 5.11 Rate limit

**Objetivo.** Proteger cota Meta e isolar tenants/apps.

**Camadas.**
1. **App-level:** cada `consumer_app` tem teto de RPS. Excesso → 429.
2. **Tenant-level:** cada tenant tem teto. Excesso → 429.
3. **WABA/phone-number-level:** respeita tier Meta (1K, 10K, 100K conversations/24h). meta-api enfileira ou rejeita preemptivamente.

**Implementação.** Token bucket no Redis, leaky-bucket para fairness entre tenants.

**Headers de resposta.** `X-RateLimit-Remaining`, `X-RateLimit-Reset`, `X-RateLimit-Scope`.

### 5.12 Token management

**Objetivo.** Gerenciar tokens Meta de forma transparente aos consumers.

**Componentes.**
- **Refresh automático:** worker dispara 7 dias antes da expiração de tokens long-lived.
- **Cifra em repouso:** AES-256-GCM por tenant (envelope encryption se necessário).
- **Audit:** toda renovação loga em `audit_log`.
- **Falha:** token expirado sem renovação possível → emite evento `waba.connection_changed` com status `disconnected`; consumer pode acionar reconexão OAuth.

### 5.13 Audit log

**Objetivo.** Trilha imutável de toda mutação, para LGPD, debug e segurança.

**Esquema.**
- `audit_log_id`, `actor_type` (consumer_app|admin|system), `actor_id`, `action`, `resource_type`, `resource_id`, `tenant_id?`, `app_id?`, `occurred_at`, `payload_redacted`, `ip`, `user_agent`.

**Regras.**
- Append-only (sem UPDATE/DELETE em produção).
- PII removida de `payload_redacted` (corpo de mensagens nunca entra; apenas metadata).
- Retenção: 5 anos.

### 5.14 Health e observabilidade

**Endpoints.**
- `GET /healthz` — liveness.
- `GET /readyz` — readiness (Postgres + Redis + Meta connectivity).
- `GET /metrics` — Prometheus metrics (interno apenas).

**Métricas-chave.**
- Throughput por endpoint, por app, por tenant.
- Latência p50/p95/p99 de chamada à Meta.
- Tamanho de fila outbound.
- Webhook delivery success rate, dead-letter rate.
- Token refresh success/failure.
- Rate limit 429 rate.

---

## 6. Fora de escopo V1

- **Interface gráfica.** Sem dashboard, sem painel web, sem app mobile. Operação humana via CLI ou via outro produto da família.
- **Messenger, Threads, Facebook Pages, WhatsApp Cloud Marketing API.** Foco em WhatsApp Business + Instagram Business apenas.
- **Multi-region.** Single-region. Failover regional é V2+.
- **Public API para terceiros.** Apenas apps internos da família Bevox.
- **Billing/cobrança entre apps.** Sem chargeback de cota; orçamento Meta é assumido pelo grupo Bevox como custo compartilhado.
- **UI de templates.** Templates são criados via API; o app consumidor é responsável por oferecer UI ao seu próprio cliente final.
- **SDKs oficiais.** V1 entrega apenas a API HTTP + OpenAPI spec. SDKs (TS, Python) podem vir em v1.1 se houver demanda interna.
- **A/B test de mensagens, deliverability scoring, analytics avançado.** Métricas básicas via observabilidade; analytics de produto fica nos apps consumidores.
- **Webhooks de outros canais** (e-mail, SMS, push). Permanente fora de escopo — não é objetivo do produto.

---

## 7. Stack e arquitetura

### 7.1 Stack

Reutilizar a stack do `bevox-backend` (decisão alinhada com resposta da pergunta 10; espelha ADR-008 da pasta-pai como prior art):

- **Runtime:** Node.js LTS (mesma versão do Bevox).
- **Linguagem:** TypeScript estrito.
- **HTTP framework:** Fastify.
- **ORM:** Drizzle ORM.
- **Banco:** Postgres 16+ dedicado.
- **Filas/cache:** Redis 7+ dedicado.
- **Workers:** BullMQ.
- **Validação:** Zod.
- **Logging:** pino + correlation IDs.
- **Tracing:** OpenTelemetry.
- **Errors:** Sentry.
- **Dashboards:** Grafana (mesmo cluster Bevox).

### 7.2 Topologia de processo

```
bevox-meta-api/
├── api          (Fastify HTTP server; expõe REST + SSE)
├── worker-out   (BullMQ consumer; outbound queue → Meta)
├── worker-in    (BullMQ consumer; webhook delivery aos consumers)
├── worker-tok   (cron; refresh de tokens Meta)
└── admin-cli    (utilitário CLI para admin)
```

Todos compartilham o mesmo banco e Redis. Escalabilidade horizontal: api e workers podem ter N instâncias.

### 7.3 Deploy

- **Cluster:** mesmo cluster Kubernetes do Bevox V1.
- **Namespace:** `bevox-meta-api` (isolado do namespace do Bevox).
- **Banco:** Postgres dedicado (RDS/equivalente, instância pequena V1).
- **Redis:** dedicado (ElastiCache/equivalente, instância pequena V1).
- **Secrets:** vault/secret manager do cluster; rotação manual em V1, automática em v1.1.
- **Network:** apps consumidores acessam via DNS interno (`meta-api.internal`); nada público.

### 7.4 Multi-tenancy técnica

- Tenancy lógica em todas as queries: `WHERE app_id = ? AND tenant_id = ?`.
- Sem schemas separados por tenant (escolhido por simplicidade V1).
- Row-level security do Postgres ativada para defesa em profundidade.

### 7.5 Princípios não-funcionais V1

- **Sem SLA contratual** (resposta da pergunta 15). Operação best-effort interna.
- **Confiabilidade-alvo (não contratual):** 99% mensal, p95 outbound < 500ms, recovery < 1h em incidentes.
- **Segurança:** TLS 1.2+ obrigatório, mTLS opcional entre apps internos e meta-api em v1.1.
- **Observabilidade obrigatória.** Toda request com `trace_id` propagado de e para Meta.

---

## 8. Modelo de dados

15 entidades agrupadas em 5 macrodomínios. Todas usam UUIDv7 como ID primário (espelha ADR-001 do Bevox como prior art).

### 8.1 Identidade (apps + admin)

**ConsumerApp**
- `id`, `name`, `description`, `status` (active|deactivated), `public_key_pem` (RSA), `created_at`, `metadata_json`.
- Singleton key por app: `current_public_key_id`.

**AppKey**
- `id`, `app_id`, `public_key_pem`, `algo` (RS256), `valid_from`, `valid_until?`, `rotated_at?`.
- N chaves por app para suportar rotação com janela de grace.

**AdminAccount**
- `id`, `email`, `password_hash`, `mfa_enrolled`, `created_at`.
- V1: poucas contas, gerenciadas via CLI.

### 8.2 Tenancy

**Tenant**
- `id`, `app_id`, `external_id?`, `display_name`, `metadata_json`, `status` (active|disabled|deleted), `created_at`, `deleted_at?`.
- Unique: `(app_id, external_id)` quando `external_id` not null.

### 8.3 Bindings Meta

**WabaConnection**
- `id`, `tenant_id`, `app_id` (denormalizado p/ índice), `meta_business_id`, `meta_waba_id`, `display_name`, `verified_status`, `created_at`, `disconnected_at?`.
- Unique: `(tenant_id, meta_waba_id)`.

**WabaToken**
- `id`, `waba_connection_id`, `access_token_encrypted`, `expires_at`, `refresh_at`, `created_at`, `superseded_at?`.

**PhoneNumber**
- `id`, `waba_connection_id`, `meta_phone_id`, `display_phone_number`, `quality_rating`, `messaging_limit_tier`, `verified_name`, `created_at`.

**IgConnection**
- `id`, `tenant_id`, `app_id`, `meta_ig_id`, `username`, `account_type`, `created_at`, `disconnected_at?`.

**IgToken**
- `id`, `ig_connection_id`, `access_token_encrypted`, `expires_at`, `refresh_at`.

### 8.4 Templates

**Template**
- `id`, `waba_connection_id`, `name`, `language`, `category` (UTILITY|MARKETING|AUTHENTICATION), `components_json`, `meta_status` (PENDING|APPROVED|REJECTED|PAUSED|DISABLED), `meta_quality_score?`, `created_at`, `last_synced_at`.
- Unique: `(waba_connection_id, name, language)`.

### 8.5 Operação

**OutboundJob**
- `id`, `tenant_id`, `app_id`, `idempotency_key`, `channel` (whatsapp|instagram), `payload_json` (redacted PII se logado), `status` (queued|sending|sent|failed|expired), `attempts`, `last_error?`, `provider_message_id?`, `created_at`, `completed_at?`.
- Unique: `(app_id, idempotency_key)` em janela 24h.

**InboundEvent**
- `id`, `tenant_id`, `event_type`, `meta_event_id`, `payload_json`, `received_at`, `dispatched_at?`.
- Origem: webhook Meta. Persistido para replay e audit.

**WebhookSubscription**
- `id`, `app_id`, `tenant_id?` (null = todos os tenants), `url`, `secret_encrypted`, `event_types_filter[]`, `status` (active|paused|disabled), `created_at`.

**WebhookDelivery**
- `id`, `subscription_id`, `inbound_event_id`, `status` (pending|delivered|failed|dead_letter), `attempts`, `last_attempt_at?`, `last_response_status?`, `last_error?`, `next_retry_at?`.

**IdempotencyRecord**
- `key`, `app_id`, `request_hash`, `response_status`, `response_body_json`, `created_at`, `expires_at`.
- TTL: 24h. Postgres com índice em `expires_at` + cron de cleanup.

**AuditLog**
- §5.13. Append-only. Tabela particionada por mês após volume.

**RateLimitBucket**
- Vive em Redis, não em Postgres. Chaves: `rl:app:<app_id>`, `rl:tenant:<tenant_id>`, `rl:waba:<waba_id>`.

### 8.6 Convenções

- IDs: UUIDv7 (Drizzle helper).
- Timestamps: `timestamptz` UTC.
- Soft-delete: `deleted_at` ao invés de DELETE.
- Encryption: campos `*_encrypted` usam pgcrypto ou cifra em app layer (decisão MA-008 a fechar).

---

## 9. Contratos HTTP

### 9.1 Auth

**Modelo escolhido:** JWT RS256 assinado pelo consumer app com chave privada própria, verificado pela meta-api com a chave pública.

```http
Authorization: Bearer <jwt>
```

**Claims obrigatórios.**
```json
{
  "iss": "<app_id>",
  "iat": 1714003200,
  "exp": 1714003500,
  "aud": "bevox-meta-api",
  "kid": "<key_id>",
  "scope": "tenants:write messages:write webhooks:write"
}
```

- `exp - iat` máximo: 5 minutos. JWT é credencial efêmera.
- `kid` permite rotação sem downtime.
- `scope` é validado por endpoint.

### 9.2 Headers obrigatórios

| Header | Quando | Valor |
|---|---|---|
| `Authorization` | toda request | `Bearer <jwt>` |
| `X-Tenant-Id` | endpoints scoped em tenant | `<uuid>` |
| `Idempotency-Key` | toda mutação | string única, ≤ 128 chars |
| `X-Request-Id` | recomendado | string para tracing cross-system |
| `Content-Type` | requests com body | `application/json` |

### 9.3 Versionamento

- Path-based: `/v1/...`, `/v2/...`.
- Breaking changes só em nova major. Quebrar `/v1` exige aviso 6 meses para consumers.
- Backwards-compatible adds (novos campos opcionais, novos endpoints) na mesma versão.

### 9.4 Padronização de erros

```json
{
  "error": {
    "code": "TEMPLATE_REJECTED",
    "message": "Template was rejected by Meta",
    "details": {
      "meta_reason": "PROMOTIONAL_CONTENT",
      "template_id": "tpl_01HW..."
    },
    "request_id": "req_01HW..."
  }
}
```

**Códigos canônicos.** `UNAUTHENTICATED`, `FORBIDDEN`, `INVALID_INPUT`, `NOT_FOUND`, `CONFLICT`, `IDEMPOTENCY_CONFLICT`, `RATE_LIMITED`, `META_UNAVAILABLE`, `META_REJECTED`, `INTERNAL`. Mapeamento Meta → canônico documentado em `docs/architecture/error-mapping.md` (a criar).

### 9.5 OpenAPI

- Spec OpenAPI 3.1 publicada em `openapi.yaml` no repo.
- Geração de tipos TS para consumers (helper interno).

---

## 10. Webhook delivery — detalhes

### 10.1 Pipeline inbound

```
Meta → POST webhook → bevox-meta-api
    │
    ├─ valida HMAC Meta (X-Hub-Signature-256)
    ├─ deduplica por meta_event_id (Redis SETNX)
    ├─ persiste InboundEvent
    ├─ resolve tenant via meta_waba_id ou meta_ig_id
    ├─ encontra subscriptions ativas
    └─ enfileira WebhookDelivery (BullMQ)
       │
       └─ worker-in entrega:
           ├─ POST URL com X-Bevox-Signature
           ├─ 2xx → marca delivered
           └─ não-2xx → schedule next_retry com backoff
```

### 10.2 Backoff

`[0s, 30s, 2min, 10min, 1h, 6h]` — total 6 tentativas em ~7h. Após esgotar, status `dead_letter` e evento `webhook.dead_letter` (auto-emitido via subscription dedicada se houver).

### 10.3 Replay manual

Admin pode forçar replay via:
```
POST /admin/subscriptions/:id/replay
Body: { event_ids: [...] } | { since: "2026-04-25T..." }
```

### 10.4 Verificação de URL na criação

Ao registrar subscription, meta-api faz `POST` de `webhook.subscription_verify` ao URL e exige resposta `200` com echo de challenge antes de marcar `active`.

### 10.5 Segurança

- HMAC-SHA256 com secret por subscription.
- Header: `X-Bevox-Signature: t=<unix_ts>,v1=<hex>`.
- Consumer valida `t` em janela de 5min para mitigar replay.
- TLS obrigatório (URL deve ser https).

---

## 11. Multi-tenant + auth — modelo completo

### 11.1 Hierarquia

```
ConsumerApp (1)
  └── Tenant (N)
        ├── WabaConnection (N)
        │     ├── PhoneNumber (N)
        │     └── Template (N)
        └── IgConnection (N)
```

### 11.2 Regra de scope

Toda query carrega contexto:
```
{
  app_id: <derivado do JWT>,
  tenant_id: <header X-Tenant-Id, opcional para alguns endpoints>
}
```

- Endpoints `app-scoped`: filtra por `app_id`.
- Endpoints `tenant-scoped`: filtra por `app_id AND tenant_id`. Falta de header → 400.
- Cross-tenant queries proibidas para apps consumidores (apenas admin).

### 11.3 Auth admin

V1: chave administrativa estática rotacionada manualmente; assina JWT admin com claim `role: admin`. Em v1.1, integração com Clerk ou OAuth interno do grupo Bevox.

### 11.4 Auth no futuro (v1.1+)

- mTLS entre apps consumidores e meta-api dentro do cluster.
- Revogação granular de scopes.
- Policy-as-code (OPA?) para autorização.

---

## 12. Compliance, segurança e LGPD (posição interna)

### 12.1 Posição declarada

A `bevox-meta-api` opera **exclusivamente como serviço interno do grupo Bevox** (resposta da pergunta 13). Não é controladora nem operadora autônoma para fins de DPA externo. Trata dados pessoais em nome dos apps consumidores, que por sua vez são operadores em nome de seus controladores (cliente Bevox no caso do Bevox V1).

**Implicação prática.**
- DPA Bevox ↔ cliente Bevox (que existe no `prds/modulos/bevox-compliance-lgpd-prd-v1.md` na pasta-pai) cobre por extensão a meta-api como sub-processador interno.
- RoPa do grupo Bevox (`docs/compliance/ropa-v1.md` na pasta-pai) precisa adicionar OT-19 "Tratamento via meta-api interna" — **edit a fazer só quando a meta-api entrar em produção**, não agora.
- Não é necessário DPA Bevox ↔ meta-api porque ambos são entidades do mesmo controlador.
- ANPD: meta-api visível como infraestrutura interna do controlador.

**Validação jurídica.** Esta posição requer carimbo do advogado externo. Acredita-se ser defensável por simetria com qualquer SaaS que opera múltiplos micro-serviços internos sob o mesmo controlador. Marcado como decisão pendente até confirmação.

### 12.2 Segurança técnica

- TLS 1.2+ obrigatório em entrada e saída.
- Tokens Meta cifrados em repouso (AES-256-GCM, chave em KMS).
- HMAC obrigatório em webhooks Meta (inbound) e webhooks consumers (outbound).
- Rate limit anti-abuse + IP allowlist para Meta webhooks.
- Audit log imutável por 5 anos.
- Logs de aplicação com PII redacted (corpo de mensagens NUNCA em log; apenas `provider_message_id` + status).
- Backup Postgres diário, restore testado trimestralmente.
- Secret rotation: tokens Meta automaticamente, JWT keys com cron + janela de grace, admin keys manualmente.

### 12.3 Retenção

- `InboundEvent` payload: 90 dias (suficiente para replay e debug). Após, hard-delete.
- `OutboundJob` payload: 30 dias (já entregue ou já falhou).
- `AuditLog`: 5 anos.
- `IdempotencyRecord`: 24h (TTL).

### 12.4 Direitos dos titulares

A meta-api não atende DSRs diretamente. DSRs chegam pelo controlador (cliente Bevox) → app consumidor (Bevox backend) → meta-api via API admin (`POST /admin/dsr` que redaciona/apaga conforme).

---

## 13. Observabilidade

### 13.1 Stack

OpenTelemetry + Sentry + Grafana (resposta da pergunta 14, espelhando ADR-017 do Bevox como prior art).

### 13.2 Tracing

- OTel SDK em todas as request paths.
- Trace propagation: header `traceparent` aceito de consumers e propagado para Meta (Meta não suporta, mas trace fica completo internamente).
- Span attributes: `app.id`, `tenant.id`, `meta.endpoint`, `meta.error_code`.

### 13.3 Métricas-chave (Prometheus)

- `meta_api_request_duration_seconds{endpoint, status, app_id}`.
- `meta_api_outbound_messages_total{channel, tenant_id, status}`.
- `meta_api_meta_call_duration_seconds{provider, endpoint}`.
- `meta_api_webhook_delivery_attempts_total{subscription_id, status}`.
- `meta_api_dead_letter_total{tenant_id}`.
- `meta_api_token_refresh_total{status}`.

### 13.4 Alertas (PagerDuty/equivalente)

- Dead-letter rate > 1% em 5min.
- Token refresh failures > 0 em 1min.
- Meta API error rate > 5% em 5min.
- Webhook delivery p95 > 30s em 10min.
- DB connection failure.

### 13.5 Dashboards

Grafana com 4 dashboards:
- **Overview:** throughput, latência, erro por endpoint.
- **Per-app:** consumo, rate limit hits, latência por app consumidor.
- **Per-tenant:** top tenants por volume, qualidade de WABA, templates rejected.
- **Operacional:** filas, dead-letter, token refresh, DB, Redis.

---

## 14. Operações

### 14.1 Runbooks (a escrever em `docs/runbooks/`)

- `token-refresh-runbook-v1.md` — manual e automático.
- `waba-disconnect-recovery-runbook-v1.md` — quando OAuth Meta expira sem renovação.
- `dead-letter-replay-runbook-v1.md` — operador analisa e decide replay/discard.
- `jwt-key-rotation-runbook-v1.md` — rotação coordenada com apps consumidores.
- `incident-meta-down-runbook-v1.md` — Meta indisponível; backoff agressivo, alarme aos consumers.
- `disaster-recovery-runbook-v1.md` — Postgres restore, Redis warm-up, dead-letter draining.

### 14.2 Backup e DR

- Postgres: backup diário cifrado, retenção 30 dias, restore testado trimestralmente.
- Redis: snapshot horário; aceita-se perda em incidentes (apenas dedup e cache).
- RPO-alvo: ≤ 24h. RTO-alvo: ≤ 4h.

### 14.3 Onboarding de novo app consumidor

1. Admin cria `consumer_app` via CLI.
2. App recebe par RSA (privada apenas uma vez).
3. App configura kid + chave em ambiente.
4. App cria primeiros tenants + registra webhooks.
5. App testa OAuth Meta sandbox.
6. Liberação para produção via flag.

---

## 15. Decisões pendentes — ADRs a escrever

Tabela das ADRs prefixo `MA-NNN` (Meta-API), numeração própria, vivendo em `bevox-meta-api/docs/adr/`.

| ADR | Decisão | Urgência |
|-----|---------|----------|
| MA-001 | Stack do bevox-meta-api (Node+TS+Fastify+Drizzle+PG+Redis) | Aceita por design (carimbar) |
| MA-002 | Auth model entre apps e meta-api (JWT RS256 com kid) | Aceita por design (carimbar) |
| MA-003 | Tenancy model (meta-api tem tenant registry próprio) | Aceita por design (carimbar) |
| MA-004 | Multi-WABA por tenant (vs WABA central compartilhada) | Aceita por design (carimbar) |
| MA-005 | Webhook delivery com 3 modos (push + SSE + polling) | Aceita por design (carimbar) |
| MA-006 | Idempotência mandatória em mutações (espelha ADR-023 Bevox) | Aceita por design (carimbar) |
| MA-007 | Observabilidade: OTel + Sentry + Grafana (espelha ADR-017 Bevox) | Aceita por design (carimbar) |
| MA-008 | Cifra de tokens Meta: pgcrypto vs app-layer + KMS | Pendente decisão |
| MA-009 | Particionamento de AuditLog (volume) | Pode esperar primeiros 6 meses |
| MA-010 | Quando introduzir mTLS entre apps e meta-api | Pendente; v1.1 |
| MA-011 | Política de retenção fina (variar por app consumidor?) | Pendente |
| MA-012 | LGPD — confirmação jurídica da posição "sub-processador interno" | **Bloqueia produção** |

---

## 16. Roadmap

### v1.0 — MVP

WhatsApp + Instagram simultâneos, sync + async outbound, 3 modos de inbound, multi-tenant + multi-WABA, JWT auth, templates completos, idempotência, observabilidade básica, CLI admin.

**Critério de prontidão.**
- Bevox V1 backend (ou outro consumer real) integra com sucesso em sandbox + staging.
- Suite E2E cobre: OAuth WABA, envio sync, envio async, recebimento webhook, replay dead-letter, rotação de token.
- ADRs MA-001 a MA-007 carimbadas.
- MA-012 (LGPD jurídico) confirmada.
- Runbooks 14.1 escritos.

### v1.1

- mTLS opcional.
- SDK TypeScript oficial.
- Métricas avançadas (por app, por tenant).
- UI mínima admin (web stub).

### v2.0 (eventual)

- Messenger / Threads (se priorizado).
- Multi-region.
- Public API para terceiros (exigiria SLA, billing, suporte).

---

## 17. Anexo — Referências

### 17.1 Prior art interno (não-vinculante; este produto não estende)

- `prds/integracoes/whatsapp-integration-prd-v1.md` na pasta-pai — integração WhatsApp embedded no Bevox V1.
- `prds/integracoes/instagram-integration-prd-v1.md` na pasta-pai — integração Instagram embedded no Bevox V1.
- `prds/modulos/bevox-backend-prd-v1.md` §5.15 (Channels) na pasta-pai — como o Bevox V1 hoje encapsula Meta dentro do backend.

### 17.2 ADRs Bevox referenciadas como prior art

- `docs/adr/ADR-001-tipo-canonico-de-identificadores.md` (UUIDv7) na pasta-pai.
- `docs/adr/ADR-008-stack-do-bevox-backend.md` (stack reuso).
- `docs/adr/ADR-011-whatsapp-business-provider.md` (Meta Cloud API direto).
- `docs/adr/ADR-012-instagram-provider.md` (Meta Graph API).
- `docs/adr/ADR-017-observabilidade.md`.
- `docs/adr/ADR-023-idempotencia-em-tools-de-mutacao.md`.

### 17.3 Documentação Meta

- WhatsApp Business Cloud API: https://developers.facebook.com/docs/whatsapp/cloud-api
- Instagram Graph API: https://developers.facebook.com/docs/instagram-api
- Webhooks: https://developers.facebook.com/docs/graph-api/webhooks

### 17.4 Padrões

- OpenAPI 3.1.
- RFC 6749 (OAuth 2.0).
- RFC 7519 (JWT), RFC 7515 (JWS), RFC 7517 (JWK).
- RFC 8725 (JWT BCP).
- OWASP API Security Top 10.

---

**Fim do documento.**
