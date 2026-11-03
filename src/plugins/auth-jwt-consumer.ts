/**
 * Plugin Fastify — autenticação JWT RS256 de consumer apps.
 *
 * Espelha PRD §9 + ADR MA-002:
 *   - Algoritmo: APENAS RS256 (proteção contra `alg:none`/HS256 confusion).
 *   - `aud` = JWT_AUDIENCE (default `bevox-meta-api`).
 *   - `iss` = app_id (UUID) e precisa apontar para ConsumerApp ativo.
 *   - `kid` no protected header → lookup em `app_keys` (cache Redis 5min).
 *   - `exp - iat <= JWT_MAX_AGE_SECONDS` (default 300s).
 *   - `scope` (string space-separated) → `request.auth.scopes` validados.
 *
 * Decora `request.auth` com `{ appId, keyId, scopes }`.
 * Expõe `app.requireAuth({ scopes })` que retorna preHandler.
 */

import fp from "fastify-plugin";
import { decodeProtectedHeader, importSPKI, jwtVerify } from "jose";
import type { FastifyInstance, FastifyPluginAsync, preHandlerHookHandler } from "fastify";

import { env } from "@/config/env.js";
import { errors } from "@/lib/errors.js";
import { getRedis } from "@/lib/redis.js";
import { hasAllScopes, parseScopes, type Scope } from "@/lib/scopes.js";
import { findActiveAppKey, findConsumerAppById } from "@/modules/apps/repository.js";

interface ConsumerAuth {
  appId: string;
  keyId: string;
  scopes: Scope[];
}

declare module "fastify" {
  interface FastifyRequest {
    auth?: ConsumerAuth;
  }
  interface FastifyInstance {
    requireAuth: (opts?: { scopes?: Scope[] }) => preHandlerHookHandler;
  }
}

const KEY_CACHE_TTL_SECONDS = 300;
const APP_CACHE_TTL_SECONDS = 60;
const KEY_CACHE_PREFIX = "auth:appkey:";
const APP_CACHE_PREFIX = "auth:app-active:";

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s);
}

async function loadPublicKeyPem(appId: string, keyId: string): Promise<string | null> {
  const redis = getRedis();
  const cacheKey = `${KEY_CACHE_PREFIX}${appId}:${keyId}`;
  const cached = await redis.get(cacheKey);
  if (cached !== null) {
    return cached === "__missing__" ? null : cached;
  }

  const row = await findActiveAppKey(appId, keyId);
  if (row === null) {
    // Negative cache curto para evitar tempest de DB em token inválido.
    await redis.set(cacheKey, "__missing__", "EX", 30);
    return null;
  }

  await redis.set(cacheKey, row.publicKeyPem, "EX", KEY_CACHE_TTL_SECONDS);
  return row.publicKeyPem;
}

async function isAppActive(appId: string): Promise<boolean> {
  const redis = getRedis();
  const cacheKey = `${APP_CACHE_PREFIX}${appId}`;
  const cached = await redis.get(cacheKey);
  if (cached === "1") return true;
  if (cached === "0") return false;

  const app = await findConsumerAppById(appId);
  const active = app !== null && app.status === "active";
  await redis.set(cacheKey, active ? "1" : "0", "EX", APP_CACHE_TTL_SECONDS);
  return active;
}

async function verifyConsumerJwt(token: string): Promise<ConsumerAuth> {
  const cfg = env();

  // 1. Decode header (sem verificar assinatura) para pegar kid + alg.
  let header: ReturnType<typeof decodeProtectedHeader>;
  try {
    header = decodeProtectedHeader(token);
  } catch {
    throw errors.unauthenticated("Malformed JWT header");
  }

  if (header.alg !== "RS256") {
    throw errors.unauthenticated(`Algorithm "${String(header.alg)}" not allowed; use RS256`);
  }
  if (typeof header.kid !== "string" || header.kid.length === 0) {
    throw errors.unauthenticated("Missing kid in JWT header");
  }
  if (!isUuid(header.kid)) {
    throw errors.unauthenticated("Invalid kid format");
  }

  // 2. Decode payload (ainda sem verificar) para extrair iss = appId.
  // jose só faz verify+decode em uma chamada, mas precisamos do iss
  // para buscar a chave pública. Trick: parse manual da segunda parte do token.
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw errors.unauthenticated("Malformed JWT");
  }
  let unverifiedPayload: Record<string, unknown>;
  try {
    const json = Buffer.from(parts[1]!, "base64url").toString("utf8");
    unverifiedPayload = JSON.parse(json) as Record<string, unknown>;
  } catch {
    throw errors.unauthenticated("Malformed JWT payload");
  }

  const iss = unverifiedPayload.iss;
  if (typeof iss !== "string" || !isUuid(iss)) {
    throw errors.unauthenticated("Invalid iss claim");
  }

  // 3. Verificar que o app existe e está ativo.
  if (!(await isAppActive(iss))) {
    throw errors.unauthenticated("Issuer app inactive or unknown");
  }

  // 4. Buscar public key do (iss, kid).
  const pem = await loadPublicKeyPem(iss, header.kid);
  if (pem === null) {
    throw errors.unauthenticated("Unknown or revoked kid");
  }

  // 5. Verificar assinatura + claims canônicos via jose.
  let key: Awaited<ReturnType<typeof importSPKI>>;
  try {
    key = await importSPKI(pem, "RS256");
  } catch {
    throw errors.internal("Stored AppKey is not a valid SPKI public key");
  }

  let payload: Awaited<ReturnType<typeof jwtVerify>>["payload"];
  try {
    const verified = await jwtVerify(token, key, {
      algorithms: ["RS256"],
      audience: cfg.JWT_AUDIENCE,
      issuer: iss,
      // jose checa exp por default; clockTolerance default = 0.
      clockTolerance: "5s",
    });
    payload = verified.payload;
  } catch (err) {
    throw errors.unauthenticated(
      `JWT verification failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 6. Validar janela exp - iat <= JWT_MAX_AGE_SECONDS.
  if (typeof payload.iat !== "number" || typeof payload.exp !== "number") {
    throw errors.unauthenticated("Missing iat/exp claims");
  }
  if (payload.exp - payload.iat > cfg.JWT_MAX_AGE_SECONDS) {
    throw errors.unauthenticated(`JWT lifetime exceeds maximum of ${cfg.JWT_MAX_AGE_SECONDS}s`);
  }

  const scopes = parseScopes(payload.scope);

  return {
    appId: iss,
    keyId: header.kid,
    scopes,
  };
}

const plugin: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.decorateRequest("auth", undefined);

  app.decorate("requireAuth", (opts: { scopes?: Scope[] } = {}): preHandlerHookHandler => {
    const required = opts.scopes ?? [];
    return async (req) => {
      const header = req.headers.authorization;
      if (typeof header !== "string" || !header.startsWith("Bearer ")) {
        throw errors.unauthenticated("Missing Bearer token");
      }
      const token = header.slice("Bearer ".length).trim();
      if (token.length === 0) {
        throw errors.unauthenticated("Empty Bearer token");
      }

      const auth = await verifyConsumerJwt(token);
      req.auth = auth;

      if (!hasAllScopes(auth.scopes, required)) {
        throw errors.forbidden("Token missing required scope(s)", {
          required,
          have: auth.scopes,
        });
      }
    };
  });
};

export default fp(plugin, {
  name: "auth-jwt-consumer",
  fastify: "5.x",
});

// Re-export para testes.
export { verifyConsumerJwt };
