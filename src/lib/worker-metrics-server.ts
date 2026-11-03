/**
 * HTTP server minimal para expor métricas Prometheus (e healthcheck) dentro
 * dos processos worker BullMQ (outbound-dispatcher, webhook-delivery,
 * token-refresh, cleanup, media-download).
 *
 * Justificativa (A17, audit 2026-06-02):
 *   - Antes desta correção os 5 workers rodavam tsx puros sem HTTP listener,
 *     então o ServiceMonitor jamais alcançava /metrics nesses pods. Todas as
 *     métricas declaradas em `@/lib/metrics.js` (queue size, cleanup deletes,
 *     token refresh outcomes, webhook delivery outcomes, default Node lag/GC,
 *     etc.) ficavam fisicamente incoletáveis → SLO cego.
 *   - A correção declarativa-mínima é levantar um listener `node:http` enxuto
 *     em cada worker, na porta `WORKER_METRICS_PORT` (default 9090), com
 *     dois endpoints:
 *       GET /metrics — texto Prometheus do registry global.
 *       GET /healthz — liveness simples ("ok") para readiness/liveness probe.
 *   - O servidor é registrado no shutdown LIFO via `registerShutdownHook()`,
 *     então fecha antes do Redis pra evitar scrape durante drain.
 *
 * Design:
 *   - `node:http` direto em vez de Fastify para evitar custo de boot, plugins
 *     e port-conflict com a API real (que usa Fastify em PORT).
 *   - Endpoint não-/metrics nem /healthz devolve 404 sem corpo (defesa em
 *     profundidade — superfície mínima).
 *   - `port=0` em config desabilita (útil em testes).
 *   - `host=127.0.0.1` por default pra impedir exposição na network do pod
 *     antes do Service apontar; quando port-forward/Service alvo está pronto,
 *     o caller passa `host=0.0.0.0`. Workers em prod (k8s) usam `0.0.0.0`.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { env } from "@/config/env.js";
import { logger } from "@/lib/logger.js";
import { renderMetrics } from "@/lib/metrics.js";
import { registerShutdownHook } from "@/lib/shutdown.js";

export interface WorkerMetricsServerOptions {
  /** Nome do worker — usado em logs e como hook name. */
  workerName: string;
  /** Override de porta (default = env().WORKER_METRICS_PORT). */
  port?: number;
  /** Override de host (default = "0.0.0.0" em prod, "127.0.0.1" caso contrário). */
  host?: string;
}

export interface WorkerMetricsServerHandle {
  server: Server;
  port: number;
  close: () => Promise<void>;
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url ?? "/";
  if (req.method !== "GET") {
    res.statusCode = 405;
    res.setHeader("allow", "GET");
    res.end();
    return;
  }
  if (url === "/metrics") {
    try {
      const { contentType, body } = await renderMetrics();
      res.statusCode = 200;
      res.setHeader("content-type", contentType);
      res.end(body);
    } catch (err) {
      logger().error({ err }, "worker /metrics render failed");
      res.statusCode = 500;
      res.end("metrics render failed");
    }
    return;
  }
  if (url === "/healthz") {
    res.statusCode = 200;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end("ok");
    return;
  }
  res.statusCode = 404;
  res.end();
}

/**
 * Inicia o servidor HTTP de métricas. Idempotência: o caller é responsável
 * por chamar uma única vez por worker (typicamente em `if (isMain)`).
 *
 * Opt-out: env `WORKER_METRICS_PORT=0` (defaults a 9090) faz a função retornar
 * `null` sem subir listener — útil em dev/test que não precisa de scrape.
 * Override explícito `opts.port=0` significa "pegue uma porta ephemeral do
 * kernel" (útil em testes paralelos), NÃO opt-out.
 */
export async function startWorkerMetricsServer(
  opts: WorkerMetricsServerOptions,
): Promise<WorkerMetricsServerHandle | null> {
  const cfg = env();
  // Opt-out via env: WORKER_METRICS_PORT=0.
  if (opts.port === undefined && cfg.WORKER_METRICS_PORT === 0) {
    logger().info(
      { worker: opts.workerName },
      "worker metrics server disabled (WORKER_METRICS_PORT=0)",
    );
    return null;
  }
  const port = opts.port ?? cfg.WORKER_METRICS_PORT;
  const host = opts.host ?? (cfg.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");

  const server = createServer((req, res) => {
    void handleRequest(req, res);
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });

  const address = server.address();
  const actualPort =
    address && typeof address === "object" && "port" in address ? address.port : port;

  logger().info(
    { worker: opts.workerName, host, port: actualPort },
    "worker metrics server listening",
  );

  const close = async (): Promise<void> => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  };

  registerShutdownHook(`${opts.workerName}-metrics-server`, close);

  return { server, port: actualPort, close };
}
