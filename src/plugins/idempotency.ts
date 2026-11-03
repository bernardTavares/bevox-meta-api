/**
 * Plugin Fastify — idempotência (ADR MA-006).
 *
 * Para POST/PUT/PATCH/DELETE em rotas que opt-in via `app.requireIdempotency()`:
 *   1. Exige header `Idempotency-Key` (1..128 chars de classe restrita).
 *   2. Computa hash SHA-256 do body.
 *   3. Procura registro em (app_id, key) na tabela `idempotency_records`:
 *      - hit + hash igual + não expirado → REPLAY (status + body cacheados).
 *      - hit + hash diferente + não expirado → 422 IDEMPOTENCY_CONFLICT (A12; HTTP code segue OpenAPI/PRD §9.4).
 *      - miss ou expirado → segue request; salva resposta no onSend.
 *   4. TTL: 24h. Cleanup via cron worker (task separada).
 *
 * Pré-requisito: o plugin de auth precisa rodar ANTES — usamos `req.auth.appId`.
 * Em rotas que querem idempotência, registrar:
 *
 *   { preHandler: [app.requireAuth({...}), app.requireIdempotency()] }
 */

import { createHash } from "node:crypto";

import fp from "fastify-plugin";
import type {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
  preHandlerHookHandler,
} from "fastify";

import { errors } from "@/lib/errors.js";
import { findIdempotencyRecord, saveIdempotencyRecord } from "@/modules/idempotency/repository.js";

interface IdempotencyState {
  key: string;
  bodyHash: string;
}

declare module "fastify" {
  interface FastifyRequest {
    idempotencyState?: IdempotencyState;
  }
  interface FastifyInstance {
    requireIdempotency: () => preHandlerHookHandler;
  }
}

const TTL_MS = 24 * 60 * 60 * 1000;
const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
// ASCII subset deliberadamente conservador. Aceita base64url, ULID, UUID,
// path-like idempotency keys.
const KEY_PATTERN = /^[A-Za-z0-9._\-:/=+]{1,128}$/;

function hashBody(body: unknown): string {
  const serialized = body === undefined || body === null ? "" : JSON.stringify(body);
  return createHash("sha256").update(serialized).digest("hex");
}

function parseStoredBody(value: unknown): unknown {
  // jsonb sai como objeto JS; nada a fazer.
  return value;
}

function serializePayloadForStore(payload: unknown): unknown | null {
  if (typeof payload === "string") {
    try {
      return JSON.parse(payload);
    } catch {
      // String não-JSON — não cacheamos (não temos como replicar Content-Type
      // de forma confiável neste hook). Retornamos null para sinalizar skip.
      return null;
    }
  }
  if (Buffer.isBuffer(payload)) return null;
  if (payload === null || payload === undefined) return null;
  if (typeof payload === "object") return payload;
  return null;
}

async function preHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!MUTATION_METHODS.has(req.method)) return;

  if (!req.auth) {
    // Programming error — auth precisa ter rodado antes.
    throw errors.internal("requireIdempotency requires requireAuth registered before it");
  }
  const appId = req.auth.appId;

  const headerVal = req.headers["idempotency-key"];
  const key = Array.isArray(headerVal) ? headerVal[0] : headerVal;
  if (typeof key !== "string" || !KEY_PATTERN.test(key)) {
    throw errors.invalidInput(
      "Idempotency-Key header is required (1..128 chars from [A-Za-z0-9._\\-:/=+])",
      { header: "Idempotency-Key" },
    );
  }

  const bodyHash = hashBody(req.body);
  const existing = await findIdempotencyRecord(appId, key);
  const now = new Date();

  if (existing && existing.expiresAt > now) {
    if (existing.requestHash !== bodyHash) {
      throw errors.idempotencyConflict(key, {
        reason: "request_hash_mismatch",
      });
    }
    // Replay
    void reply
      .status(existing.responseStatus)
      .header("idempotent-replay", "true")
      .send(parseStoredBody(existing.responseBodyJson));
    return;
  }

  req.idempotencyState = { key, bodyHash };
}

const plugin: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.decorateRequest("idempotencyState", undefined);

  app.decorate("requireIdempotency", (): preHandlerHookHandler => preHandler);

  // Hook global de save: roda em toda resposta; é no-op quando não há state.
  app.addHook("onSend", async (req, reply, payload) => {
    const state = req.idempotencyState;
    if (!state) return payload;
    if (reply.statusCode < 200 || reply.statusCode >= 300) return payload;

    const bodyToStore = serializePayloadForStore(payload);
    if (bodyToStore === null) return payload;

    const appId = req.auth?.appId;
    if (!appId) return payload; // defesa em profundidade

    try {
      await saveIdempotencyRecord({
        appId,
        key: state.key,
        requestHash: state.bodyHash,
        responseStatus: reply.statusCode,
        responseBodyJson: bodyToStore,
        expiresAt: new Date(Date.now() + TTL_MS),
      });
    } catch (err) {
      // Falha em persistir o record NÃO derruba a resposta — o cliente
      // já recebeu o resultado. Logamos como warn pra investigação.
      req.log.warn({ err, idempotency_key: state.key }, "failed to persist idempotency record");
    }

    return payload;
  });
};

export default fp(plugin, {
  name: "idempotency",
  fastify: "5.x",
});

export { hashBody, KEY_PATTERN, TTL_MS };
