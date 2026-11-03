/**
 * Plugin Fastify — rate limiting em 3 camadas (PRD §5.11).
 *
 * `app.requireRateLimit({...})` retorna preHandler que checa N buckets em
 * sequência (app → tenant → waba) e:
 *   - Define headers `X-RateLimit-{Limit,Remaining,Reset,Scope}` do bucket
 *     mais restrito que ainda permite a request.
 *   - Em violação: 429 RATE_LIMITED + `Retry-After`.
 *
 * Não é forçado globalmente — rotas opt-in. App-level é o default mais útil.
 *
 * Pré-requisito: `requireAuth` antes (precisa de `req.auth.appId`).
 */

import fp from "fastify-plugin";
import type {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
  preHandlerHookHandler,
} from "fastify";

import { errors } from "@/lib/errors.js";
import {
  appKey,
  consumeToken,
  DEFAULT_APP_LIMIT,
  DEFAULT_TENANT_LIMIT,
  DEFAULT_WABA_LIMIT,
  tenantKey,
  wabaKey,
  type RateLimitConfig,
  type RateLimitResult,
} from "@/lib/rate-limit.js";

export interface RequireRateLimitOptions {
  /** Override do limite app-level. Default: 1000/min. */
  app?: RateLimitConfig | null;
  /** Override do limite tenant-level. Default: 100/min. Se null, skip. */
  tenant?: RateLimitConfig | null;
  /** Override do limite WABA-level. Default: tier 1K. Se null, skip. */
  waba?: RateLimitConfig | null;
  /**
   * Resolve o tenantId. Se não fornecido e `tenant` ativo, plugin tenta
   * `req.auth?.tenantId` (futuro) ou pula scope tenant.
   */
  resolveTenantId?: (req: FastifyRequest) => string | undefined;
  /**
   * Resolve o wabaId. Se não fornecido e `waba` ativo, scope é pulado.
   */
  resolveWabaId?: (req: FastifyRequest) => string | undefined;
}

declare module "fastify" {
  interface FastifyInstance {
    requireRateLimit: (opts?: RequireRateLimitOptions) => preHandlerHookHandler;
  }
}

function applyHeaders(reply: FastifyReply, result: RateLimitResult): void {
  void reply.header("x-ratelimit-limit", String(result.limit));
  void reply.header("x-ratelimit-remaining", String(result.remaining));
  void reply.header("x-ratelimit-reset", String(result.resetAt));
  void reply.header("x-ratelimit-scope", result.scope);
}

const plugin: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.decorate("requireRateLimit", (opts: RequireRateLimitOptions = {}): preHandlerHookHandler => {
    const appCfg = opts.app === undefined ? DEFAULT_APP_LIMIT : opts.app;
    const tenantCfg = opts.tenant === undefined ? DEFAULT_TENANT_LIMIT : opts.tenant;
    const wabaCfg = opts.waba === undefined ? DEFAULT_WABA_LIMIT : opts.waba;

    return async (req, reply) => {
      if (!req.auth) {
        throw errors.internal("requireRateLimit requires requireAuth registered before it");
      }

      // Lista de buckets a checar, na ordem do mais amplo ao mais restrito.
      const checks: Array<{ key: string; cfg: RateLimitConfig }> = [];

      if (appCfg) checks.push({ key: appKey(req.auth.appId), cfg: appCfg });

      if (tenantCfg) {
        const tid = opts.resolveTenantId?.(req);
        if (tid) checks.push({ key: tenantKey(tid), cfg: tenantCfg });
      }

      if (wabaCfg) {
        const wid = opts.resolveWabaId?.(req);
        if (wid) checks.push({ key: wabaKey(wid), cfg: wabaCfg });
      }

      // Roda em série; o primeiro deny aborta. Sucesso → setamos headers
      // do scope mais restrito (último que passou).
      let lastResult: RateLimitResult | null = null;
      for (const { key, cfg } of checks) {
        const result = await consumeToken(key, cfg);
        if (!result.allowed) {
          applyHeaders(reply, result);
          void reply.header("retry-after", String(Math.max(1, result.retryAfter)));
          throw errors.rateLimited(result.retryAfter, result.scope);
        }
        lastResult = result;
      }
      if (lastResult) applyHeaders(reply, lastResult);
    };
  });
};

export default fp(plugin, {
  name: "rate-limit-buckets",
  fastify: "5.x",
});
