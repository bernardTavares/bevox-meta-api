/**
 * Health endpoints — PRD §5.14.
 *
 *  - GET /healthz  → liveness (sempre 200 enquanto o processo respira)
 *  - GET /readyz   → readiness (Postgres + Redis OK)
 *
 * /metrics fica em módulo separado (observabilidade, MA-007).
 */

import type { FastifyInstance } from "fastify";

import { env } from "@/config/env.js";
import { readiness } from "@/lib/health.js";
import { renderMetrics } from "@/lib/metrics.js";

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/healthz", async () => ({ status: "ok", build: env().BUILD_SHA }));

  app.get("/readyz", async (_req, reply) => {
    const report = await readiness();
    return reply.status(report.ok ? 200 : 503).send(report);
  });

  // /metrics — Prometheus scrape endpoint. Em produção, restringir via
  // network policy / proxy (não é exposto publicamente conforme PRD §13.3).
  app.get("/metrics", async (_req, reply) => {
    const { contentType, body } = await renderMetrics();
    return reply.type(contentType).send(body);
  });
}
