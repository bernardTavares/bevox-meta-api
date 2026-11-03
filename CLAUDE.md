# bevox-meta-api — Instruções de projeto

## 1. Identidade

`bevox-meta-api` é serviço HTTP **interno** do grupo Bevox que encapsula WhatsApp Business Cloud API e Instagram Graph API atrás de uma superfície única, multi-app e multi-tenant. Consumido exclusivamente por produtos da família Bevox (Bevox V1 e futuros).

**Não é** produto comercial. **Não tem** UI. **Não armazena** domínio de negócio (Conversation, Message, Customer, Appointment vivem nos consumidores). **Não substitui** as integrações Meta embedded no Bevox V1 — é produto paralelo.

Status atual e versão estão no [`README.md`](./README.md). Não duplicar aqui — README é a fonte; este arquivo cobre **regras de comportamento** que sobrevivem entre versões.

## 2. Leitura obrigatória antes de mexer

Sempre comece por:

1. `prds/bevox-meta-api-prd-v1.md` — PRD V1 (§1-§17). Fonte canônica de escopo, modelo de dados (§8), contratos HTTP (§9), webhook delivery (§10), tenancy (§11), compliance (§12), observabilidade (§13).
2. `docs/adr/` — ADRs MA-001..MA-008 (Aceitas) + MA-012 (LGPD, bloqueia produção).
3. `docs/architecture/openapi.yaml` — contratos formais.

Quando a documentação contradiz o código, **a documentação ganha**. Atualize o código antes de "consertar" a doc. Quando a documentação está errada por design (decisão mudou), atualize a doc + escreva ADR superseding.

## 3. Stack

Travada por MA-001. Não trocar sem ADR superseding.

| Camada | Tecnologia |
|---|---|
| Runtime | Node.js 22+ (`.nvmrc 22.19.0`, `engines.node >=22.19.0`, image `node:22-alpine`) — **Node 20 NÃO suportado**: `undici@8` exige `webidl.util.markAsUncloneable` que só existe em Node 22+; suite falha 18/34 em Node 20 |
| Linguagem | TypeScript 5.x `strict: true` |
| HTTP | Fastify 5 |
| ORM | Drizzle ORM + drizzle-kit |
| Banco | PostgreSQL 16+ (dedicado) |
| Cache/fila | Redis 7+ (dedicado) |
| Workers | BullMQ 5 |
| Validação | Zod 4 |
| Logging | Pino 9 + AsyncLocalStorage |
| Observabilidade | OpenTelemetry + Sentry + Grafana (MA-007) |
| Testes | Vitest 4 |
| Pacotes | pnpm 9 |
| Container | Docker (multi-stage) |

Lista completa de dependências e plugins Fastify no `package.json`. Notar:

- `fastify-sse-v2` é o pacote **comunitário** (sem scope `@fastify/`).
- `js-yaml` **não** é instalado: `@fastify/swagger` carrega o YAML em `mode: 'static'`.

## 4. Invariantes do código — não-negociáveis

Estas regras precisam valer em **todo** request path. PR que viole exige justificativa explícita + ADR.

1. **UUIDv7 em IDs primários.** Nada de `serial`, `bigserial`, ou UUIDv4. Use o helper `uuidv7()` do package interno.
2. **Toda mutação carrega `Idempotency-Key`.** Header obrigatório em `POST/PUT/PATCH/DELETE` (exceto `/healthz`, `/readyz`, `/metrics`). Plugin valida. Ver MA-006.
3. **Toda query é scoped por `app_id` (e `tenant_id` quando aplicável).** Plugin `tenant-scope` injeta automaticamente — não bypassar.
4. **Tokens Meta nunca em log, response ou Sentry.** Apenas decifrados em memória, na linha que faz a chamada Meta. Ver MA-008.
5. **JWT RS256 com `kid` em validação.** Sem `HS256`, sem `alg:none`, sem JWT eterno. Vida ≤ 5min. Plugin `auth-jwt-consumer` cuida.
6. **PII redaction em logs.** `messages.content` nunca em log. Use `provider_message_id` + status. Helper `redact()`.
7. **Soft-delete em entidades de domínio.** `deleted_at` ao invés de `DELETE`. Hard-delete só via admin com flag explícita + audit.
8. **Audit log em toda mutação.** Plugin captura — não duplicar manualmente.
9. **HMAC validation em todo webhook.** Inbound (Meta → meta-api) e outbound (meta-api → consumers). Sem HMAC = drop.
10. **Multi-WABA é regra, não exceção.** Cada tenant tem suas próprias WABAs/IGs. Nunca compartilhar WABA central. Ver MA-004.
11. **Transações em ≥ 2 escritas.** Use `db.transaction()` quando há mais de uma escrita relacionada — atômicas ou nada.

## 5. Convenções de código

### 5.1 TypeScript

- `strict: true`. Sem `any` exceto em adapters de libs sem tipos. `unknown` + narrowing.
- Sem default exports. Named exports sempre.
- Imports absolutos via paths: `@/modules/...`, `@/plugins/...`.
- Async/await. Sem callbacks. Sem `.then()` exceto em chains de teste.

### 5.2 Naming

| Item | Convenção |
|---|---|
| Arquivos | kebab-case: `webhook-delivery.ts` |
| Tipos/interfaces | PascalCase: `WabaConnection` |
| Funções/variáveis | camelCase: `createTenant` |
| Constantes | SCREAMING_SNAKE: `JWT_MAX_AGE_SECONDS` |
| Tabelas/colunas | snake_case: `waba_connections`, `expires_at` |
| Endpoints | kebab-case + REST: `/v1/tenants/:id/wabas/connect/init` |
| Enums (valores) | UPPER_SNAKE: `PENDING`, `APPROVED` |

### 5.3 Errors

- Throw `AppError` (classe interna) com `code`, `httpStatus`, `details`. Nunca `throw new Error('string')`.
- Códigos canônicos: PRD §9.4 (`UNAUTHENTICATED`, `FORBIDDEN`, `INVALID_INPUT`, `NOT_FOUND`, `CONFLICT`, `IDEMPOTENCY_CONFLICT`, `RATE_LIMITED`, `META_UNAVAILABLE`, `META_REJECTED`, `INTERNAL`).
- Erro Meta crú: traduzir via `mapMetaError()` em `src/integration/meta-client.ts`.

### 5.4 Logging

- Pino sempre via `req.log` (request-scoped, com `trace_id`).
- Níveis: `error` (incidente), `warn` (anomalia recuperável), `info` (mutação relevante), `debug` (apenas em dev).
- **Nunca** logar: `access_token`, `private_key_pem`, `messages.content`, `idempotency body`, payload de mensagem inbound. Use `redact()`.
- Sempre logar: `request_id`, `app_id`, `tenant_id`, `endpoint`, `latency_ms`, `meta_endpoint` quando aplicável.

### 5.5 Validação

- Toda input validada com Zod schema antes de chegar à lógica de negócio.
- Schemas em `src/modules/<X>/schemas.ts`.
- OpenAPI: `docs/architecture/openapi.yaml` é fonte canônica enquanto V1 (geração a partir de Zod é deferido pós-V1).

### 5.6 Estrutura de módulo

Padrão por módulo em `src/modules/<nome>/`:
```
index.ts       # exports públicos
routes.ts      # registra rotas Fastify (valida + chama service + retorna)
service.ts     # lógica
repository.ts  # acesso DB via Drizzle
schemas.ts     # Zod (input + output)
types.ts       # tipos compartilhados
```

Apenas Drizzle para DB. Nunca `pg` cru. Migrations via `drizzle-kit generate`; SQL escrito à mão só com comentário justificando.

## 6. Fronteira — o que este projeto NÃO faz

- **Sem UI.** Embedded Signup widget vive no app consumidor (ex.: bevox-web).
- **Sem domínio Bevox.** Não conhece `Workspace`, `Customer`, `Appointment`, `Charge`. Apenas `app_id` + `tenant_id` opacos.
- **Sem fork de Bevox.** Produto paralelo. Bevox V1 mantém integrações embedded.
- **Sem Messenger / Threads / FB Pages em V1.**
- **Sem multi-region em V1.**
- **Sem público externo.** Apenas apps internos da família Bevox.
- **Sem chargeback / billing entre apps.** Custo Meta vai para o tenant.
- **Sem persistência de domínio do consumer.** Esquece o conteúdo de mensagens após dispatch (apenas metadata em audit + `provider_message_id`).

## 7. Compliance e segurança

- **TLS 1.2+** obrigatório.
- **Tokens Meta cifrados** via envelope encryption (KMS + AES-256-GCM por tenant). Ver MA-008.
- **HMAC** em webhooks Meta (inbound) e consumers (outbound).
- **Audit log imutável** por 5 anos.
- **PII redaction** em logs e Sentry.
- **LGPD:** meta-api é serviço interno do grupo Bevox; tratamento em cadeia com os apps consumidores. Posição precisa carimbo jurídico (MA-012, pendente — bloqueia produção).

## 8. Decisão sobre ações — quando agir vs. quando perguntar

| Situação | Ação |
|---|---|
| Endpoint descrito em PRD §9 com task TaskMaster correspondente | Implementar |
| Adicionar teste para código existente | Implementar |
| Refatorar dentro de um módulo, sem mudar contrato externo | Implementar |
| Bug com reprodução clara, sem mudar invariante | Corrigir |
| Atualizar dependência minor/patch sem breaking change | Atualizar |
| Decisão estrutural não coberta por ADR | **Parar** — propor ADR draft |
| Mudança em invariante (§4) | **Parar** — confirmação humana explícita |
| Bypass de plugin (auth, idempotency, tenant-scope, audit) | **Parar** — quase nunca tem motivo legítimo |
| Schema migration que altera tipo de coluna existente | **Parar** — pode quebrar dados em prod |
| Adicionar dependência em `package.json` | **Parar** — listar alternativas + justificar |
| Trocar provider externo (KMS, Sentry, etc.) | **Parar** — ADR |
| Mudar PRDs/ADRs/runbooks | **Parar** — PR explícito |

## 9. Comandos rápidos

```bash
# Setup inicial
pnpm install
docker compose up -d                 # Postgres + Redis
pnpm migrate:up
pnpm seed

# Dev
pnpm dev                             # Fastify watch (tsx)
pnpm worker:out                      # outbound dispatcher
pnpm worker:in                       # webhook delivery
pnpm worker:tok                      # token refresh cron
pnpm worker:cleanup                  # cleanup retenção (cron 24h)

# Testes
pnpm test                            # unit (mocks)
pnpm test:integration                # Postgres + Redis em Docker
pnpm test:e2e                        # contra Meta sandbox (CI/pre-merge)

# Migration
pnpm migrate:generate --name=<nome>
pnpm migrate:up
pnpm migrate:down

# OpenAPI
pnpm openapi:types                   # gera src/types/api.ts a partir do YAML
pnpm openapi:check                   # valida YAML

# Admin CLI (commander) — comandos reais (ver scripts/admin-cli/index.ts)
pnpm cli apps create --name <x> [--description <d>]
pnpm cli apps list
pnpm cli apps rotate-key --app-id <x> [--grace-days <n>]
pnpm cli apps deactivate --app-id <x> [--dry-run]
pnpm cli dead-letter list --subscription-id <x>
pnpm cli dead-letter replay --subscription-id <x> [--dry-run]

# Smoke contra staging/prod
BEVOX_META_API_URL=https://meta-api.example.com pnpm smoke

# Verificações
pnpm typecheck
pnpm lint
pnpm format
pnpm build                           # tsc -p tsconfig.build.json
```

## 10. Tom e estilo de PR

- PR descreve **por que**, não só **o que** (diff já mostra o que).
- Referencia task TaskMaster (`closes #task-12`) quando aplicável.
- Inclui ADR superseding se mudou decisão registrada.
- Sem emojis. Sem prefixo `feat:` / `fix:` obrigatório (mas aceito).
- Idioma: português, alinhado com o resto do repo Bevox.

## 11. Produção / Deploy

Runbook canônico: `docs/ops/2026-05-25-go-live-prod-plan.md` (leia o §1 — gotchas). Não duplicar aqui; abaixo só o mapa que sobrevive entre versões.

- **Prod real** = `https://meta-api.example.com`, servido pelo host Hetzner **`meta-api-prod-1` (<PROD_HOST_IP>)**, em **k3s** (ns `bevox-meta-api`), exposto por cloudflared **no próprio host**. Acesso: `ssh -i ~/.ssh/meta-api-prod_ed25519 root@<PROD_HOST_IP>` + `export KUBECONFIG=/etc/rancher/k3s/k3s.yaml`.
- Stack prod: CloudNativePG (`bevox-meta-api-pg`) + Redis statefulset; `NODE_ENV=production`; `KMS_PROVIDER=gcp` via Workload Identity Federation (org proíbe SA keys); secrets no k8s Secret `bevox-meta-api-secret` (envFrom). Runtime roda via `tsx`, sem `dist/`.
- **Cuidado — instâncias decoy (NÃO são prod):** o k3s desta máquina de dev (nó `debian`, <DEV_HOST_IP>) é o **dry-run** do go-live; o docker-compose `bevox-meta-api-api` em `127.0.0.1:3010` (`docker-compose.prod.yml`) é **staging**. Têm `ADMIN_API_KEY` próprios e diferentes. `KUBECONFIG` default do shell aponta para o k3s **local**, não prod.
- **Admin / provisionar consumer-app:** auth admin é JWT **HS256** assinado com `ADMIN_API_KEY` (gerado por `openssl rand -hex 32` no servidor; só existe no secret de prod). Mintar o JWT **dentro de um pod api** (`kubectl exec ... node`/`jose`, `aud=bevox-meta-api-admin`, vida ≤3600s) e chamar `http://127.0.0.1:3000/admin/apps` in-pod. Rota é `/admin/apps` (não `/v1/admin/...`). A `private_key_pem` sai **uma vez** na criação/rotação.

---

**Primeira tarefa ao começar a codificar:** ler PRD V1 inteiro + MA-001 até MA-008. Sem isso, o que você escreve vai conflitar com decisões já tomadas.
