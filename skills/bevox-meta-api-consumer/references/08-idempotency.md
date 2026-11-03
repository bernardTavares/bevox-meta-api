# 08 — Idempotência

Fonte canônica: ADR MA-006.

`Idempotency-Key` é **header obrigatório** em toda mutação (`POST`, `PUT`, `PATCH`, `DELETE`), exceto `/healthz`, `/readyz`, `/metrics`. Ausência = 400 `INVALID_INPUT`.

## Regras de comportamento

1. **Mesma key + mesmo body** → meta-api retorna o resultado da primeira chamada (cache 24h). Status code idêntico.
2. **Mesma key + body diferente** → 409 `IDEMPOTENCY_CONFLICT`. Bug do consumidor.
3. **Key diferente** → operação executa normalmente.
4. **Cache window:** 24 horas. Após isso, mesma key vira nova operação.

## Como derivar a key

**Princípio:** key derivada de **evento de domínio**, não aleatória. Aleatória mata a idempotência em retry — você acaba duplicando.

### Exemplos bons

| Operação | Key derivada de |
|---|---|
| Enviar lembrete de consulta 24h antes | `appointment-{appointment_id}-reminder-24h` |
| Confirmar agendamento | `appointment-{appointment_id}-confirmation` |
| Mapear workspace para tenant (bootstrap) | `tenant-bootstrap-{workspace_id}` |
| Criar template | `template-{waba_id}-{template_name}-{template_version}` |
| Iniciar OAuth WABA | `waba-connect-{tenant_id}-{minute_window}` |
| Subscription bootstrap | `sub-{ambiente}-bootstrap` |
| Ack batch de eventos | `ack-{cursor_inicial}` ou `ack-{batch_uuid_estável}` |

### Exemplos ruins

| ❌ Key | Por quê |
|---|---|
| `crypto.randomUUID()` | Aleatório a cada call → retry duplica. |
| `Date.now()` | Muda entre tentativas. |
| `${user_id}-message` | Sem dimensão de "qual mensagem específica". 2 mensagens diferentes do mesmo user batem entre si. |
| `${appointment_id}` (sem qualificador) | Se você tem 3 ações por appointment (confirmação, lembrete, cancelamento), todas colidem. |

## Como tratar retry no seu código

Pseudocódigo de cliente HTTP correto:

```ts
async function callWithRetry(req: Request, idempotencyKey: string) {
  const headers = { ...req.headers, "Idempotency-Key": idempotencyKey };

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(req.url, { ...req, headers });
      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get("retry-after") ?? "5");
        await sleep(retryAfter * 1000);
        continue;
      }
      if (res.status >= 500 && res.status !== 501) {
        await sleep(backoff(attempt));
        continue;
      }
      return res; // 2xx, 4xx (exceto 429) → final
    } catch (e) {
      // network error → retry
      if (attempt === 3) throw e;
      await sleep(backoff(attempt));
    }
  }
}
```

**A mesma `idempotencyKey`** vai em todas as 3 tentativas. Isso é o ponto.

## Ambiguidade em `META_UNAVAILABLE`

Cenário: você chamou `POST /v1/messages`, recebeu 502 `META_UNAVAILABLE`. A Meta pode ter recebido ou não.

**Comportamento da meta-api:** ela mantém o registro da operação em `outbound_jobs` em estado `pending`. Worker continua tentando. Em retry seu (mesma key, mesmo body), meta-api reconhece e retorna o estado atual (`pending`, `sent`, `failed`).

**Comportamento seu:** retry com mesma key. **Não** crie key nova "por garantia" — vai duplicar.

## Mensagens com timing crítico

Para mensagens com janela de tempo curta (lembrete que precisa sair em 5 min), use **async** + key com a janela:

```http
POST /v1/messages/async
Idempotency-Key: appointment-{id}-reminder-{ISO_yyyy_mm_dd_hh_mm}
```

Se sua scheduler dispara 2x na mesma janela, key idêntica = no-op. Janela curta evita repetir indefinidamente em janelas seguintes.

## Cleanup do seu lado

Você não precisa "deletar" idempotency keys da meta-api — ela expira em 24h sozinha. Mas seu storage de keys (se houver) deve seguir a mesma janela.

## Debug

`GET /v1/messages/{message_id}` aceita o `message_id` retornado da primeira chamada idempotente. Útil para confirmar estado quando você está em dúvida se a mensagem saiu.

`request_id` no response header é diferente entre chamadas (mesmo idempotentes), mas o `message_id` no body é o mesmo. Use **`message_id`** para correlação de domínio; **`request_id`** para correlação de log da meta-api.
