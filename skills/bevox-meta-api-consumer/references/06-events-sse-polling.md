# 06 — SSE e Polling (alternativas ao push)

Quando o projeto consumidor **não pode expor URL HTTPS** alcançável pela meta-api (NAT, FaaS sem URL fixa, ambiente isolado), use SSE ou polling. Ambos requerem `events:read` no scope.

Fonte canônica: ADR MA-005 + PRD §10.

## Quando escolher cada um

| Modo | Quando usar | Pegadas |
|---|---|---|
| **Push** (recomendado) | Você tem URL HTTPS interna | Veja `references/05-webhooks-hmac.md` |
| **SSE** | Realtime sem URL pública; você roda processo long-lived | Reconnect e cursor são sua responsabilidade |
| **Polling** | Sem servidor long-lived (cron, serverless), ou redes muito restritas | Mais latência; precisa ack explícito |

## SSE (Server-Sent Events)

### Abrindo o stream

```http
GET /v1/events/stream?cursor=01HX... HTTP/1.1
Host: meta-api.internal
Authorization: Bearer <jwt scope=events:read>
X-Tenant-Id: <opcional — filtra para um tenant específico>
Accept: text/event-stream
```

### Resposta

```
retry: 5000

id: 01HX...
event: message.received
data: {"event_id":"01HX...","event_type":"message.received","tenant_id":"01HY...","occurred_at":"...","data":{...}}

: ping 1714003230

id: 01HZ...
event: message.status_updated
data: {...}
```

- Heartbeat (`: ping <epoch>`) a cada 30s. Use para detectar conexão morta.
- `id` de cada evento é o `event_id` UUIDv7. Guarde o último processado.

### Reconnect

- Em queda, reconecte com `cursor=<último_event_id>` para replay desde o ponto.
- O header `Last-Event-ID` (padrão SSE) também é honrado pela meta-api.
- A diretiva `retry: 5000` sugere ao cliente esperar 5s antes de reconectar.

### Implementação Node + EventSource

```ts
import EventSource from "eventsource";

let cursor = await loadCursor(); // do seu storage
const url = new URL("/v1/events/stream", "https://meta-api.internal");
if (cursor) url.searchParams.set("cursor", cursor);

const es = new EventSource(url.toString(), {
  headers: {
    Authorization: `Bearer ${await signJwt(["events:read"])}`,
  },
});

es.addEventListener("message.received", async (e) => {
  const event = JSON.parse(e.data);
  await processEvent(event); // idempotente por event.event_id
  await saveCursor(event.event_id);
});

es.onerror = (err) => {
  // EventSource tenta reconectar sozinho a cada `retry` ms.
  console.error("SSE error", err);
};
```

### Limites do SSE

- Conexão única por processo. Múltiplas réplicas do seu serviço viram réplicas de eventos — **escolha 1 leader** (ou use polling com lock distribuído).
- JWT precisa ser refresheado durante a conexão (≤ 5min de vida). EventSource não permite trocar header sem reconectar — implemente reconnect a cada 4 minutos.
- Não passa por proxies que bufferizam (configurar `X-Accel-Buffering: no` se for atrás de Nginx, etc.).

## Polling

### Loop de leitura

```http
GET /v1/events?since=<cursor>&limit=100 HTTP/1.1
Authorization: Bearer <jwt scope=events:read>
X-Tenant-Id: <opcional>
```

Resposta:
```json
{
  "data": [
    {
      "event_id": "01HX...",
      "event_type": "message.received",
      "tenant_id": "01HY...",
      "occurred_at": "2026-04-27T12:00:00Z",
      "dispatched_at": null,
      "data": { ... }
    }
  ],
  "next_cursor": "01HZ..."
}
```

### ACK após processar

Eventos não-acked permanecem visíveis no próximo poll. Após processar com sucesso:

```http
POST /v1/events/ack
Authorization: Bearer <jwt scope=events:read>
Idempotency-Key: ack-{batch_id}
Content-Type: application/json

{ "event_ids": ["01HX...", "01HZ..."] }
```

```json
{ "acked": 2, "requested": 2 }
```

### Loop completo Node

```ts
async function pollLoop() {
  let cursor = await loadCursor();
  while (true) {
    const { data, next_cursor } = await metaApi.getEvents({ since: cursor, limit: 100 });
    if (data.length === 0) {
      await sleep(5000); // backoff quando não há eventos
      continue;
    }
    for (const event of data) {
      await processEvent(event); // idempotente por event_id
    }
    await metaApi.ackEvents(data.map((e) => e.event_id), `batch-${next_cursor}`);
    cursor = next_cursor;
    await saveCursor(cursor);
  }
}
```

### Cadência

- Sem eventos: backoff (ex.: 5s).
- Com eventos: chamar de novo imediatamente (provável ter mais).
- Use `limit=100` em V1; meta-api pode rejeitar `> 200`.

### Polling vs SSE — escolha rápida

- Tem processo long-lived? → SSE.
- Roda em cron / scheduler? → Polling.
- Quer latência < 1s? → SSE ou push.
- Quer simplicidade absoluta? → Polling.

## Mudando de modo

Subscriptions com `delivery_mode: "push"` não usam SSE/polling — eles consomem do mesmo evento source mas em modos diferentes. Ou seja: **escolha 1 modo por workload**. Pode ter múltiplas subscriptions push + um polling em paralelo, mas isso vira complexidade desnecessária.
