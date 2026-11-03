---
name: secrets-never-log
glob: "src/**/*.ts"
description: |
  Lista canônica do que NUNCA pode aparecer em log, response HTTP, Sentry ou
  métrica — e do que SEMPRE deve estar presente. Aplica §7.4 do CLAUDE.md
  e invariante 4 do §5. Referencia MA-008 (envelope encryption).
priority: 1
---

# Regra: Secrets — nunca logar, nunca responder, nunca capturar

Aplicável a `src/**/*.ts`. Violação é bug bloqueante de merge.
Auditado por `.claude/agents/secrets-redaction-auditor.md`.

## NUNCA logar / responder / mandar para Sentry / usar em label de métrica

| Categoria | Exemplos de campos / chaves |
|---|---|
| Tokens Meta | `access_token`, `accessToken`, `system_user_access_token`, `long_lived_token`, `meta_token`, `META_ACCESS_TOKEN` |
| Chaves cripto / OAuth | `private_key_pem`, `privateKeyPem`, `client_secret`, `clientSecret`, `app_secret`, `appSecret`, `META_APP_SECRET`, `JWT_PRIVATE_KEY`, `kms_key_material`, `dek` (data encryption key) |
| HMAC secrets | `hmac_secret`, `hmacSecret`, `X-Hub-Signature-256` recebido, `X-Bevox-Signature` enviado (header inteiro, não só presença) |
| Conteúdo de mensagem | `messages.content`, `message.body`, `message.text.body`, `template.components[].parameters[].text`, `media.caption`, `interactive.body.text`, `button.title`, qualquer variável de template preenchida |
| Webhook payload Meta | `entry[].changes[].value.messages[]` cru, `entry[].changes[].value.contacts[]` cru, qualquer body inbound de `/webhooks/inbound/*` antes de redact |
| Idempotency raw | `idempotency.body` armazenado no cache, `cached_request_body`, request body cru de `POST` que carrega `content` |
| PII direta | `phone_number_e164` (mascarar para `+55****1234`), `wa_id` do contato final, `profile.name`, `email`, `cpf`, `cnpj` |
| Headers sensíveis | `authorization`, `cookie`, `set-cookie`, `x-meta-token`, `x-admin-token` |

### Pino serializers obrigatórios (em `src/lib/logger.ts`)

```ts
serializers: {
  req: (req) => ({
    method: req.method,
    url: req.url,            // sem query string sensível
    request_id: req.id,
    app_id: req.appId,       // injetado por tenant-scope
    tenant_id: req.tenantId, // idem
    // NUNCA: req.headers.authorization, req.body
  }),
  res: (res) => ({ statusCode: res.statusCode }),
  err: serializeErrorRedacted,
},
redact: {
  paths: [
    'req.headers.authorization',
    'req.headers.cookie',
    'req.headers["x-hub-signature-256"]',
    '*.access_token',
    '*.accessToken',
    '*.client_secret',
    '*.private_key_pem',
    '*.hmac_secret',
    '*.messages[*].content',
    '*.body.message',
  ],
  censor: '[REDACTED]',
}
```

## SEMPRE logar (campos canônicos)

Todo `req.log.info` em mutação deve carregar pelo menos:

| Campo | Origem |
|---|---|
| `request_id` | `req.id` (Fastify auto via `request-context`) |
| `app_id` | JWT consumer claim, injetado por `tenant-scope` |
| `tenant_id` | JWT claim opcional (quando aplicável), injetado por `tenant-scope` |
| `endpoint` | `${req.method} ${req.routerPath}` (rota, não URL com IDs) |
| `latency_ms` | `onResponse` hook |
| `meta_endpoint` | quando chamou Meta — `messages`, `subscribed_apps`, etc. (path Meta, sem IDs sensíveis) |
| `outcome` | `ok` \| `client_error` \| `server_error` \| `meta_error` |
| `provider_message_id` | quando enviou/recebeu mensagem (substitui content) |

## Helper canônico

```ts
// src/lib/redact.ts
import { redact } from '@/lib/redact';

req.log.info(
  redact({
    payload,                       // pode conter campos sensíveis
    pickAllowlist: ['provider_message_id', 'status', 'to_e164_masked'],
  }),
  'outbound dispatched'
);
```

**Regra**: nunca passe um objeto cru de domínio (`payload`, `body`, `event`,
`webhook`, `response`) para `req.log.*` sem antes passar por `redact()` ou
construir um objeto novo com **allowlist explícita**.

## Response HTTP de erro

`src/plugins/error-handler.ts` retorna:
```json
{
  "error": {
    "code": "META_REJECTED",
    "message": "string curta, sem detalhe interno",
    "request_id": "uuid"
  }
}
```

- `details` **NUNCA** inclui token, secret, body cru ou conteúdo de mensagem.
- `mapMetaError()` (em `src/integration/meta-client.ts`) limpa response Meta
  antes de propagar — Meta às vezes ecoa o body que recebeu.

## Sentry

- `Sentry.setContext` apenas com `request_id`, `app_id`, `tenant_id`,
  `meta_endpoint`, `outcome`. Nunca com `req.body`, `req.headers`,
  `response.body`.
- `beforeSend` em `src/lib/telemetry.ts` deve passar `event` por `redact()`.

## Métricas Prometheus

Labels permitidos: `app_id`, `meta_endpoint`, `status_class` (`2xx`/`4xx`/`5xx`),
`outcome`. **Nunca** label de alta cardinalidade ou sensível: `tenant_id` cru,
`phone_number`, `wa_id`, `message_id` específico.

## Cifra de tokens (MA-008)

- Tokens Meta são decifrados **apenas** na linha que chama `meta-client.ts`.
- Variável local descartada (escopo de função) — não atribuir a campo de
  objeto que possa vazar em log ou stack trace.
- Em stack trace de erro: `serializeErrorRedacted` em `src/lib/logger.ts`
  remove qualquer string que case `/^(eyJ|EAA)[A-Za-z0-9_-]{20,}/` (JWT / Meta token shape).

## Checklist por PR

- [ ] Nenhum `req.log.*` recebe `req.body`, `payload`, `event`, `webhook`, `response` cru.
- [ ] `redact()` aplicado em todos os logs de mutação.
- [ ] `error.details` de `AppError` não contém secrets.
- [ ] Nenhuma label de métrica de alta cardinalidade.
- [ ] Sentry context limpo de PII.
- [ ] Headers `authorization` / `x-hub-signature-*` em redact paths.
- [ ] Teste unit que joga payload com `access_token` em log e verifica que sai `[REDACTED]`.

## Referências

- CLAUDE.md §5 invariante 4 (tokens Meta) e invariante 6 (PII redaction)
- CLAUDE.md §7.4 (logging completo)
- `docs/adr/MA-008-cifra-de-tokens-meta.md` (envelope encryption)
- `docs/adr/MA-005-webhook-delivery-tres-modos.md` (HMAC outbound)
- `.claude/agents/secrets-redaction-auditor.md` (auditor automatizado)
