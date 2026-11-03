/**
 * Handler Fastify para webhooks push da bevox-meta-api.
 *
 * Pontos críticos:
 *   - Raw body precisa estar disponível para HMAC. Configure addContentTypeParser
 *     conforme abaixo (ou use rawBody plugin).
 *   - Idempotência por event_id.
 *   - Resposta 2xx em ≤ 1s; processamento real é enfileirado.
 *
 * Referências:
 *   - skill: references/05-webhooks-hmac.md
 *   - ADR MA-005
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";

interface BevoxEvent {
  event_id: string;
  event_type: string;
  tenant_id: string;
  occurred_at: string;
  data: Record<string, unknown>;
}

interface RegisterOptions {
  /** Secret retornado por POST /v1/webhooks/subscriptions. */
  signingSecret: string;
  /** Path do endpoint. Default /webhooks/meta-api. */
  path?: string;
  /** Tolerância de skew em segundos. Default 300. */
  toleranceSeconds?: number;
  /** Callback chamado depois de validar HMAC. Deve ser idempotente por event_id. */
  onEvent: (event: BevoxEvent, raw: string) => Promise<void>;
  /** Já processado? Use seu storage (DB / Redis) para idempotência. */
  isAlreadyProcessed: (eventId: string) => Promise<boolean>;
  /** Marcar como processado. */
  markProcessed: (eventId: string) => Promise<void>;
}

export async function registerBevoxWebhookHandler(
  app: FastifyInstance,
  opts: RegisterOptions,
): Promise<void> {
  const path = opts.path ?? "/webhooks/meta-api";
  const tolerance = opts.toleranceSeconds ?? 300;

  // Garante raw body disponível em request.rawBody
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_req, body, done) => {
      try {
        const parsed = JSON.parse(body as string);
        (parsed as { __raw?: string }).__raw = body as string;
        done(null, parsed);
      } catch (e) {
        done(e as Error, undefined);
      }
    },
  );

  app.post(path, async (req, reply) => {
    const sigHeader = req.headers["x-bevox-signature"];
    if (typeof sigHeader !== "string") {
      return reply.code(400).send({ error: "missing signature" });
    }

    const body = req.body as { __raw?: string } | undefined;
    const raw = body?.__raw;
    if (!raw) return reply.code(400).send({ error: "missing body" });

    if (!validateBevoxSignature(opts.signingSecret, sigHeader, raw, tolerance)) {
      req.log.warn({ event_id: extractId(req) }, "HMAC inválido");
      return reply.code(401).send({ error: "invalid signature" });
    }

    const event = req.body as BevoxEvent;

    // Idempotência
    if (await opts.isAlreadyProcessed(event.event_id)) {
      return reply.code(200).send({ ack: true, duplicate: true });
    }

    // Responde rápido; processa async se for caso de I/O pesado.
    // Aqui, padrão "enqueue + ack". Se onEvent é leve, pode ser síncrono.
    try {
      await opts.onEvent(event, raw);
      await opts.markProcessed(event.event_id);
      return reply.code(200).send({ ack: true });
    } catch (e) {
      req.log.error({ event_id: event.event_id, err: e }, "falha ao processar");
      return reply.code(500).send({ error: "processing failed" });
    }
  });
}

function extractId(req: FastifyRequest): string | undefined {
  const v = req.headers["x-bevox-event-id"];
  return typeof v === "string" ? v : undefined;
}

export function validateBevoxSignature(
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
