/**
 * Factory do servidor Fastify do bevox-meta-api.
 *
 * Não inicia listening — apenas constrói. `start()` (em src/index.ts) chama
 * `app.listen()` e instala shutdown handlers.
 *
 * Decisões:
 *  - request.id usa UUIDv7 (invariante CLAUDE.md §5.1).
 *  - Logger Pino do Fastify herda LOG_LEVEL e redact paths.
 *  - X-Request-Id é honrado quando vem do cliente; senão geramos.
 *  - AsyncLocalStorage é setada no onRequest hook para que código fundo do
 *    call-stack possa pegar requestId via getContext().
 */

import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import sensible from "@fastify/sensible";
import fastify, { type FastifyInstance } from "fastify";

import { env } from "@/config/env.js";
import { uuidv7 } from "@/lib/uuid.js";
import { httpRequestDuration, httpRequestsTotal } from "@/lib/metrics.js";
import { runWithContext, type RequestContext } from "@/lib/request-context.js";

import { errorHandler } from "./error-handler.js";
import { buildRequestSerializer } from "./logger.js";
import { registerOpenApiDocs } from "./openapi-docs.js";

import auditLogPlugin from "@/plugins/audit-log.js";
import authAdmin from "@/plugins/auth-admin.js";
import authJwtConsumer from "@/plugins/auth-jwt-consumer.js";
import idempotency from "@/plugins/idempotency.js";
import rateLimitBuckets from "@/plugins/rate-limit-buckets.js";

import { adminAppsRoutes } from "@/modules/apps/routes.js";
import { eventsRoutes } from "@/modules/events/routes.js";
import { healthRoutes } from "@/modules/health/routes.js";
import { igRoutes } from "@/modules/ig/routes.js";
import inboundWebhooks from "@/modules/inbound/routes.js";
import { mediaRoutes } from "@/modules/media/routes.js";
import { messagesRoutes } from "@/modules/messages/routes.js";
import { phoneNumbersRoutes } from "@/modules/phone-numbers/routes.js";
import { templatesRoutes } from "@/modules/templates/routes.js";
import { tenantsRoutes } from "@/modules/tenants/routes.js";
import { wabasRoutes } from "@/modules/wabas/routes.js";
import { webhooksRoutes } from "@/modules/webhooks/routes.js";

export async function buildServer(): Promise<FastifyInstance> {
  const cfg = env();

  const app = fastify({
    logger: {
      level: cfg.LOG_LEVEL,
      redact: {
        paths: [
          'req.headers["authorization"]',
          'req.headers["cookie"]',
          'req.headers["x-app-key"]',
          "access_token",
          "access_token_encrypted",
          "private_key_pem",
          "secret",
          "password",
          "password_hash",
          // OAuth — achado C1. Fallback se `code`/`state` aparecerem em
          // payloads logados pela app (o vazamento principal em `req.url`
          // é tratado pelo serializer customizado em `serializers.req`).
          "code",
          "state",
          "error_description",
        ],
        censor: "[REDACTED]",
      },
      serializers: {
        // Achado C1 (auditoria interna): redijir query string das rotas
        // OAuth callback antes do Pino logar `req.url`. Ver
        // `src/bootstrap/logger.ts`.
        req: buildRequestSerializer(),
      },
      ...(cfg.NODE_ENV === "development"
        ? {
            transport: {
              target: "pino-pretty",
              options: { colorize: true, translateTime: "HH:MM:ss.l", ignore: "pid,hostname" },
            },
          }
        : {}),
    },
    // X-Request-Id do cliente é honrado; senão geramos UUIDv7.
    genReqId: (req) => {
      const incoming = req.headers["x-request-id"];
      if (typeof incoming === "string" && incoming.length > 0 && incoming.length <= 200) {
        return incoming;
      }
      return uuidv7();
    },
    requestIdLogLabel: "request_id",
    requestIdHeader: "x-request-id",
    disableRequestLogging: false,
    // Body limit padrão de 1MB (webhook Meta ocasionalmente vem grande, mas
    // requests de API ficam abaixo). Endpoints de webhook podem override.
    bodyLimit: 1_048_576,
    trustProxy: true,
  });

  // -------------------------------------------------------------------------
  // Plugins de segurança e ergonomia
  // -------------------------------------------------------------------------

  await app.register(helmet, {
    // /v1/* é API JSON; sem inline scripts/styles, então CSP estrita.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
      },
    },
    crossOriginResourcePolicy: { policy: "same-origin" },
  });

  await app.register(cors, {
    // V1: sem público externo. Origem só importa para apps internos
    // chamando endpoints de admin via browser (futuro). Default = false.
    origin: false,
  });

  await app.register(sensible);

  // Plugins de auth — não forçam auth global; rotas pedem via decorators.
  await app.register(authJwtConsumer);
  await app.register(authAdmin);
  // Idempotency — opt-in por rota via app.requireIdempotency().
  await app.register(idempotency);
  // Audit log — onResponse hook automático para mutações 2xx.
  await app.register(auditLogPlugin);
  // Rate limiting — opt-in por rota via app.requireRateLimit({...}).
  await app.register(rateLimitBuckets);

  // -------------------------------------------------------------------------
  // Hooks: request context (AsyncLocalStorage) + response headers
  // -------------------------------------------------------------------------

  app.addHook("onRequest", (req, _reply, done) => {
    const ctx: RequestContext = { requestId: req.id };
    (req as unknown as { __startedAt: number }).__startedAt = Date.now();
    runWithContext(ctx, () => {
      // Permite que code-paths fundos atualizem appId/tenantId em runtime.
      // Plugins futuros (auth, tenant-scope) farão patchContext().
      done();
    });
  });

  app.addHook("onResponse", (req, reply, done) => {
    const start = (req as unknown as { __startedAt?: number }).__startedAt;
    if (typeof start === "number") {
      const route = req.routeOptions?.url ?? req.url.split("?")[0] ?? req.url;
      const labels = {
        method: req.method,
        route,
        status_code: String(reply.statusCode),
      };
      httpRequestDuration.observe(labels, (Date.now() - start) / 1000);
      httpRequestsTotal.inc({ ...labels, app_id: req.auth?.appId ?? "anon" });
    }
    done();
  });

  // onSend roda antes de o response sair — onResponse seria tarde demais
  // para mutar headers.
  app.addHook("onSend", (req, reply, payload, done) => {
    void reply.header("x-request-id", req.id);
    done(null, payload);
  });

  // -------------------------------------------------------------------------
  // Error handler global
  // -------------------------------------------------------------------------

  app.setErrorHandler(errorHandler);

  app.setNotFoundHandler(async (req, reply) => {
    return reply.status(404).send({
      error: {
        code: "NOT_FOUND",
        message: `Route ${req.method} ${req.url} not found`,
        request_id: req.id,
      },
    });
  });

  // -------------------------------------------------------------------------
  // Rotas
  // -------------------------------------------------------------------------

  await registerOpenApiDocs(app);
  await app.register(healthRoutes);
  await app.register(tenantsRoutes);
  await app.register(wabasRoutes);
  await app.register(igRoutes);
  await app.register(phoneNumbersRoutes);
  await app.register(templatesRoutes);
  await app.register(messagesRoutes);
  await app.register(mediaRoutes);
  await app.register(eventsRoutes);
  await app.register(webhooksRoutes);
  await app.register(adminAppsRoutes);
  await app.register(inboundWebhooks);

  return app;
}
