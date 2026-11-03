/**
 * Plugin Fastify — autenticação ADMIN.
 *
 * Conforme ADR MA-002 §"Auth admin" (V1): JWT HS256 assinado com a chave
 * administrativa estática (`ADMIN_API_KEY`), claims `sub` (admin_id),
 * `role: 'admin'`, `iat`, `exp`. Rotação manual.
 *
 * Por que HS256 e não RS256 aqui?
 *  - Universo de admins é ínfimo (V1: poucos, gerenciados via CLI).
 *  - Sem necessidade de chave pública distribuída.
 *  - A chave NUNCA sai do servidor (não há cliente externo).
 *  - Diferente do JWT consumer, que precisa RS256 para que apps possam
 *    assinar localmente sem nunca expor o secret.
 *
 * O endpoint que emite o admin JWT (login) não está aqui — virá em outra
 * task com bcrypt em AdminAccount. Este plugin apenas VERIFICA.
 *
 * Decora `request.admin` com `{ sub, role }`.
 * Expõe `app.requireAdminAuth()` como preHandler.
 */

import fp from "fastify-plugin";
import { jwtVerify } from "jose";
import type { FastifyInstance, FastifyPluginAsync, preHandlerHookHandler } from "fastify";

import { env } from "@/config/env.js";
import { errors } from "@/lib/errors.js";

interface AdminAuth {
  sub: string;
  role: "admin";
}

declare module "fastify" {
  interface FastifyRequest {
    admin?: AdminAuth;
  }
  interface FastifyInstance {
    requireAdminAuth: () => preHandlerHookHandler;
  }
}

const ADMIN_AUDIENCE = "bevox-meta-api-admin";
const ADMIN_MAX_AGE_SECONDS = 3600; // 1h — admin sessions são longas

async function verifyAdminJwt(token: string): Promise<AdminAuth> {
  const cfg = env();
  const secret = new TextEncoder().encode(cfg.ADMIN_API_KEY);

  let payload: Awaited<ReturnType<typeof jwtVerify>>["payload"];
  try {
    const verified = await jwtVerify(token, secret, {
      algorithms: ["HS256"],
      audience: ADMIN_AUDIENCE,
      clockTolerance: "5s",
    });
    payload = verified.payload;
  } catch (err) {
    throw errors.unauthenticated(
      `Admin JWT verification failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (payload.role !== "admin") {
    throw errors.forbidden("Admin role required");
  }
  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw errors.unauthenticated("Missing sub claim");
  }
  if (typeof payload.iat !== "number" || typeof payload.exp !== "number") {
    throw errors.unauthenticated("Missing iat/exp claims");
  }
  if (payload.exp - payload.iat > ADMIN_MAX_AGE_SECONDS) {
    throw errors.unauthenticated(`Admin JWT lifetime exceeds maximum of ${ADMIN_MAX_AGE_SECONDS}s`);
  }

  return { sub: payload.sub, role: "admin" };
}

const plugin: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.decorateRequest("admin", undefined);

  app.decorate("requireAdminAuth", (): preHandlerHookHandler => {
    return async (req) => {
      const header = req.headers.authorization;
      if (typeof header !== "string" || !header.startsWith("Bearer ")) {
        throw errors.unauthenticated("Missing Bearer token");
      }
      const token = header.slice("Bearer ".length).trim();
      if (token.length === 0) {
        throw errors.unauthenticated("Empty Bearer token");
      }

      // Defesa em profundidade: se vier um JWT com 'kid' (consumer JWT)
      // tratamos como não-admin imediatamente — evita confusão de tokens.
      // jose já vai rejeitar pelo algoritmo errado, mas a mensagem fica mais
      // clara assim.
      const parts = token.split(".");
      if (parts.length !== 3) {
        throw errors.unauthenticated("Malformed JWT");
      }

      const auth = await verifyAdminJwt(token);
      req.admin = auth;
    };
  });
};

export default fp(plugin, {
  name: "auth-admin",
  fastify: "5.x",
});

export { verifyAdminJwt, ADMIN_AUDIENCE, ADMIN_MAX_AGE_SECONDS };
