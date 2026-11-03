/**
 * Plugin Fastify — serve OpenAPI spec + Swagger UI em /docs.
 *
 * Apenas em dev/staging (skip em production via NODE_ENV check).
 * Em prod, /docs deve ficar atrás de network policy / proxy interno.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import type { FastifyInstance } from "fastify";

import { env } from "@/config/env.js";
import { logger } from "@/lib/logger.js";

export async function registerOpenApiDocs(app: FastifyInstance): Promise<void> {
  const cfg = env();
  if (cfg.NODE_ENV === "production") {
    return; // não expõe /docs em prod
  }

  const specPath = fileURLToPath(new URL("../../docs/architecture/openapi.yaml", import.meta.url));

  // O spec OpenAPI canônico vive em bevox-knowledge (movido para fora do repo).
  // @fastify/swagger em mode:static lê o arquivo em `ready()`, fora do try/catch
  // abaixo; um arquivo ausente derrubaria o boot. Guarda explícita: se o spec
  // não está presente localmente, /docs fica desabilitado (não-fatal).
  if (!existsSync(specPath)) {
    logger().warn({ specPath }, "OpenAPI spec ausente; /docs desabilitado");
    return;
  }

  try {
    await app.register(swagger, {
      mode: "static",
      specification: { path: specPath, baseDir: "" },
    });
    await app.register(swaggerUi, {
      routePrefix: "/docs",
      uiConfig: { docExpansion: "list", deepLinking: true },
      staticCSP: true,
    });
  } catch (err) {
    logger().warn({ err, specPath }, "OpenAPI docs setup falhou; /docs desabilitado");
  }
}
