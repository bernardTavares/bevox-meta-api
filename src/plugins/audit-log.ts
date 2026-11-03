/**
 * Plugin Fastify — audit log automático para mutações.
 *
 * Captura toda resposta 2xx em métodos POST/PUT/PATCH/DELETE e registra
 * uma entrada de audit_log com:
 *   - actor_type derivado de req.auth (consumer_app) ou req.admin (admin)
 *     ou system (caminho não-autenticado)
 *   - action = `<method>:<route_path>` (ex.: 'POST:/v1/tenants')
 *   - resource_type = primeiro segmento útil do path (best-effort)
 *   - resource_id = id do path (último UUIDv7 encontrado, se houver)
 *   - tenant_id / app_id de req.auth ou X-Tenant-Id
 *   - metadata = payload do request (redacted)
 *
 * Service layer pode complementar com `logAudit(...)` manual quando
 * precisar de contexto que o plugin não tem (ex.: id da entidade criada).
 */

import fp from "fastify-plugin";
import type { FastifyInstance, FastifyPluginAsync } from "fastify";

import { logAudit } from "@/lib/audit.js";

const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const UUID_V7_REGEX = /[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;

function inferResourceType(routePath: string | undefined, url: string): string {
  // /v1/tenants/:id → 'tenants'; /v1/messages → 'messages'; etc.
  const path = routePath ?? url;
  const m = /\/v1\/([^/?]+)/.exec(path);
  if (m && m[1]) return m[1];
  if (path.startsWith("/admin/")) {
    const am = /\/admin\/([^/?]+)/.exec(path);
    if (am && am[1]) return `admin:${am[1]}`;
  }
  if (path.startsWith("/webhooks/")) return "webhook";
  return "unknown";
}

function inferResourceId(url: string): string | null {
  const m = UUID_V7_REGEX.exec(url);
  return m ? m[0] : null;
}

const plugin: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.addHook("onResponse", (req, reply, done) => {
    if (!MUTATION_METHODS.has(req.method)) {
      done();
      return;
    }
    if (reply.statusCode < 200 || reply.statusCode >= 400) {
      done();
      return;
    }
    // Skip rotas internas de teste e health (não são auditáveis).
    if (req.url.startsWith("/__test/") || req.url.startsWith("/healthz")) {
      done();
      return;
    }

    const tenantHeader = req.headers["x-tenant-id"];
    const tenantId = typeof tenantHeader === "string" ? tenantHeader : null;

    let actorType: "consumer_app" | "admin" | "system";
    let actorId: string | null;
    if (req.admin?.sub) {
      actorType = "admin";
      actorId = req.admin.sub;
    } else if (req.auth?.appId) {
      actorType = "consumer_app";
      actorId = req.auth.appId;
    } else {
      actorType = "system";
      actorId = null;
    }

    const ip =
      typeof req.headers["x-forwarded-for"] === "string"
        ? (req.headers["x-forwarded-for"].split(",")[0]?.trim() ?? null)
        : (req.ip ?? null);
    const ua = typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null;

    void logAudit({
      actorType,
      actorId,
      action: `${req.method}:${req.routeOptions?.url ?? req.url.split("?")[0] ?? req.url}`,
      resourceType: inferResourceType(req.routeOptions?.url, req.url),
      resourceId: inferResourceId(req.url),
      tenantId,
      appId: req.auth?.appId ?? null,
      metadata: {
        request_id: req.id,
        status_code: reply.statusCode,
        body: (req as unknown as { body?: unknown }).body,
      },
      ip,
      userAgent: ua,
    });
    done();
  });
};

export default fp(plugin, { name: "audit-log", fastify: "5.x" });
