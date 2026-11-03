/**
 * Rotas de webhook Meta (PRD §10.1).
 *
 * Encapsulado como plugin Fastify para escopar o content-type-parser que
 * preserva o raw body — necessário para validar HMAC X-Hub-Signature-256.
 *
 * A4 fix (audit 2026-06-02): JSON.parse agora SÓ roda DEPOIS da verificação
 * HMAC bem-sucedida. Antes, o content-type-parser parseava o body cru
 * imediatamente — payloads forjados grandes consumiam CPU JSON.parse-side
 * antes do guard de assinatura (vetor de DoS barato).
 *
 * A6 fix (audit 2026-06-02): toda decisão de validação emite o counter
 * `bevox_meta_api_meta_webhook_received_total{outcome=...}` para alerting.
 *
 * A12 fix (audit 2026-06-02): o content-type-parser do A4 vazava para o
 * instance pai porque este plugin era wrappeado em `fp()`, que remove a
 * encapsulação Fastify. Resultado colateral: TODAS as rotas
 * application/json passavam a receber `req.body = undefined`, quebrando o
 * plugin de idempotência (hash do body sempre igual → conflito MA-006
 * nunca disparava, cliente sempre via 200 replay em vez de 422). Agora o
 * parser fica isolado dentro de um child scope `register` sem fp e o
 * plugin externo deixa de usar `fp()` — assim o override só vale para as
 * rotas `/webhooks/meta` e o JSON parser default continua valendo para as
 * rotas /v1/* (que precisam de `req.body` parseado para idempotência e
 * validação Zod).
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify";

import { env } from "@/config/env.js";
import { errors } from "@/lib/errors.js";
import { metaWebhookReceivedTotal } from "@/lib/metrics.js";

import { processMetaWebhook, type MetaWebhookPayload } from "./service.js";

declare module "fastify" {
  interface FastifyRequest {
    rawWebhookBody?: string;
  }
}

function verifySignature(rawBody: string, signatureHeader: string | undefined): boolean {
  const cfg = env();
  if (!cfg.META_WEBHOOK_APP_SECRET) {
    // Sem secret configurado: rejeitar tudo. Em prod o env validator já
    // exige; este branch protege test/dev mal configurados.
    return false;
  }
  if (typeof signatureHeader !== "string" || !signatureHeader.startsWith("sha256=")) {
    return false;
  }
  const provided = signatureHeader.slice("sha256=".length).trim();
  const expected = createHmac("sha256", cfg.META_WEBHOOK_APP_SECRET).update(rawBody).digest("hex");
  if (provided.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(provided, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

const inboundWebhooks: FastifyPluginAsync = async (app: FastifyInstance) => {
  // Child scope isola o content-type-parser sem precisar de prefix.
  // Routes registradas aqui continuam acessíveis na raiz (/webhooks/meta).
  await app.register(async (scope) => {
    // A4 fix — content-type-parser captura raw body MAS NÃO faz JSON.parse.
    // O parse só acontece depois da verificação HMAC ter passado no handler
    // POST. Isso elimina o vetor DoS pré-HMAC (atacante enfileira payloads
    // grandes forjados → JSON.parse-side CPU exaustion sem nem chegar ao
    // signature guard).
    scope.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
      const raw = typeof body === "string" ? body : body.toString("utf8");
      (req as FastifyRequest).rawWebhookBody = raw;
      // Body permanece como `undefined` aqui — handler decide quando parsear.
      done(null, undefined);
    });

    // ----- GET /webhooks/meta — verificação Meta -----
    scope.get("/webhooks/meta", async (req, reply) => {
      const query = req.query as Record<string, unknown>;
      if (
        query["hub.mode"] === "subscribe" &&
        typeof query["hub.verify_token"] === "string" &&
        typeof query["hub.challenge"] === "string"
      ) {
        const cfg = env();
        if (
          cfg.META_WEBHOOK_VERIFY_TOKEN &&
          query["hub.verify_token"] === cfg.META_WEBHOOK_VERIFY_TOKEN
        ) {
          return reply.type("text/plain").send(query["hub.challenge"]);
        }
        throw errors.forbidden("Invalid verify token");
      }
      throw errors.invalidInput("Missing hub.mode/verify_token/challenge");
    });

    // ----- POST /webhooks/meta — receber eventos -----
    scope.post("/webhooks/meta", async (req, reply) => {
      const sig = req.headers["x-hub-signature-256"];
      const sigStr = Array.isArray(sig) ? sig[0] : sig;
      const raw = req.rawWebhookBody ?? "";

      // A4 + A6 — verifica assinatura PRIMEIRO. Counter labeled emitido
      // antes do throw para que metrics não dependam do error handler.
      if (typeof sigStr !== "string" || sigStr.length === 0) {
        metaWebhookReceivedTotal.inc({ outcome: "missing_signature" });
        throw errors.unauthenticated("Missing X-Hub-Signature-256");
      }
      if (!verifySignature(raw, sigStr)) {
        metaWebhookReceivedTotal.inc({ outcome: "invalid_signature" });
        throw errors.unauthenticated("Invalid X-Hub-Signature-256");
      }

      // HMAC ok — agora sim podemos parsear o JSON.
      let payload: MetaWebhookPayload;
      try {
        payload =
          raw.length === 0 ? ({} as MetaWebhookPayload) : (JSON.parse(raw) as MetaWebhookPayload);
      } catch {
        metaWebhookReceivedTotal.inc({ outcome: "parse_error" });
        throw errors.invalidInput("Webhook body is not valid JSON");
      }

      // Roda síncrono mas leve. Meta exige < 5s. Se pesado, mover para queue
      // (task #21+).
      const result = await processMetaWebhook(payload);
      metaWebhookReceivedTotal.inc({ outcome: "ok" });

      return reply.status(200).send({ ok: true, ...result });
    });
  });
};

export default inboundWebhooks;
