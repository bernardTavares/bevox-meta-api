/**
 * bevox-meta-api — entry point.
 *
 * Bootstrap stages:
 *   1. Validar config (env() lança fatal se inválido)
 *   2. Construir servidor Fastify
 *   3. Listen na porta configurada
 *   4. Registrar shutdown hooks (Fastify, DB pool, Redis)
 */

import { env } from "@/config/env.js";
import { buildServer } from "@/bootstrap/server.js";
import { closeDb } from "@/db/client.js";
import { closeEventBus } from "@/lib/event-bus.js";
import { closeQueues } from "@/lib/queues.js";
import { closeRedis } from "@/lib/redis.js";
import { installShutdownHandlers, registerShutdownHook } from "@/lib/shutdown.js";
import { captureException, initTelemetry, shutdownTelemetry } from "@/lib/telemetry.js";

async function main(): Promise<void> {
  // Telemetria precisa iniciar ANTES de qualquer trabalho da app — auto
  // instrumentation OpenTelemetry monkey-patcha módulos no boot.
  await initTelemetry();

  const cfg = env();
  const app = await buildServer();

  registerShutdownHook("fastify", () => app.close());
  registerShutdownHook("queues", () => closeQueues());
  registerShutdownHook("event-bus", () => closeEventBus());
  registerShutdownHook("postgres", () => closeDb());
  registerShutdownHook("redis", () => closeRedis());
  registerShutdownHook("telemetry", () => shutdownTelemetry());

  installShutdownHandlers({ logger: (m) => app.log.info(m) });

  // Captura unhandled rejections para Sentry (no-op sem DSN).
  process.on("unhandledRejection", (reason) => {
    captureException(reason, { kind: "unhandledRejection" });
    app.log.error({ err: reason }, "unhandledRejection");
  });

  await app.listen({ port: cfg.PORT, host: "0.0.0.0" });
}

main().catch((err: unknown) => {
  captureException(err, { kind: "main_bootstrap" });
  console.error("[bevox-meta-api] fatal:", err);
  process.exit(1);
});
