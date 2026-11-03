/**
 * Handler Next.js (App Router) para webhooks push da bevox-meta-api.
 *
 * Localização: app/webhooks/meta-api/route.ts
 *
 * Pontos críticos:
 *   - Acessar raw body via request.text() ANTES de qualquer parse.
 *   - Idempotência por event_id contra seu storage.
 *
 * Referências:
 *   - skill: references/05-webhooks-hmac.md
 */
import { createHmac, timingSafeEqual } from "node:crypto";

// Garante runtime Node (não Edge) — crypto + storage geralmente requer.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface BevoxEvent {
  event_id: string;
  event_type: string;
  tenant_id: string;
  occurred_at: string;
  data: Record<string, unknown>;
}

export async function POST(request: Request): Promise<Response> {
  const signingSecret = process.env.META_API_WEBHOOK_SIGNING_SECRET;
  if (!signingSecret) {
    return new Response(JSON.stringify({ error: "misconfigured" }), {
      status: 500,
    });
  }

  const sigHeader = request.headers.get("x-bevox-signature");
  if (!sigHeader) {
    return new Response(JSON.stringify({ error: "missing signature" }), {
      status: 400,
    });
  }

  // Crítico: raw body, não JSON.stringify(parsed).
  const rawBody = await request.text();

  if (!validateBevoxSignature(signingSecret, sigHeader, rawBody, 300)) {
    return new Response(JSON.stringify({ error: "invalid signature" }), {
      status: 401,
    });
  }

  let event: BevoxEvent;
  try {
    event = JSON.parse(rawBody) as BevoxEvent;
  } catch {
    return new Response(JSON.stringify({ error: "invalid json" }), {
      status: 400,
    });
  }

  // Idempotência — substitua pelos seus helpers reais.
  if (await isAlreadyProcessed(event.event_id)) {
    return Response.json({ ack: true, duplicate: true });
  }

  try {
    await dispatchEvent(event); // enfileirar; manter handler curto
    await markProcessed(event.event_id);
    return Response.json({ ack: true });
  } catch (err) {
    console.error("processing failed", { event_id: event.event_id, err });
    return new Response(JSON.stringify({ error: "processing failed" }), {
      status: 500,
    });
  }
}

function validateBevoxSignature(
  signingSecret: string,
  signatureHeader: string,
  rawBody: string,
  toleranceSeconds: number,
): boolean {
  const parts = signatureHeader.split(",").reduce<Record<string, string>>(
    (acc, part) => {
      const [k, v] = part.split("=");
      if (k && v) acc[k] = v;
      return acc;
    },
    {},
  );

  const ts = parseInt(parts.t ?? "", 10);
  const v1 = parts.v1;
  if (!ts || !v1) return false;

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > toleranceSeconds) return false;

  const signedPayload = `${ts}.${rawBody}`;
  const expected = createHmac("sha256", signingSecret)
    .update(signedPayload)
    .digest("hex");

  if (expected.length !== v1.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(v1));
}

// Stubs — substitua pela sua implementação real.

async function isAlreadyProcessed(_eventId: string): Promise<boolean> {
  // SELECT 1 FROM processed_events WHERE event_id = $1
  return false;
}

async function markProcessed(_eventId: string): Promise<void> {
  // INSERT INTO processed_events (event_id, processed_at) VALUES ($1, NOW())
  // ON CONFLICT (event_id) DO NOTHING
}

async function dispatchEvent(event: BevoxEvent): Promise<void> {
  // Pattern recomendado: enfileirar (BullMQ, SQS, Inngest, etc.)
  // e retornar 200 em < 1s.
  switch (event.event_type) {
    case "waba.connection_changed":
      // marca canal como active/disconnected no domínio
      break;
    case "message.received":
      // cria mensagem inbound no domínio
      break;
    case "message.status_updated":
      // atualiza status da mensagem outbound
      break;
    default:
      // unknown event_type — log e ignora; meta-api é compatível aditivo
      break;
  }
}
