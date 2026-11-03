/**
 * Unit tests — src/lib/worker-metrics-server.ts (A17 fix, audit 2026-06-02).
 *
 * Cobertura:
 *   1. Boot do servidor numa porta ephemeral (0) e GET /metrics retorna
 *      content-type Prometheus + counter ativo (`workerJobsTotal`).
 *   2. GET /healthz retorna "ok".
 *   3. GET path desconhecido retorna 404.
 *   4. POST /metrics → 405 method not allowed.
 *   5. WORKER_METRICS_PORT=0 desabilita (retorna null).
 *   6. close() libera a porta.
 */

import http from "node:http";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const REQUIRED_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  LOG_LEVEL: "fatal",
  DATABASE_URL: "postgresql://bevox:pwd@localhost:5432/test",
  REDIS_URL: "redis://localhost:6379",
  KMS_PROVIDER: "local",
  KMS_KEY_ID: "test-key",
  KMS_LOCAL_MASTER_KEY: Buffer.alloc(32, 0x42).toString("base64"),
  ADMIN_API_KEY: "test-admin-key-1234",
};

beforeAll(() => {
  for (const [k, v] of Object.entries(REQUIRED_ENV)) process.env[k] = v;
});

const { __resetEnvCacheForTests } = await import("@/config/env.js");
const { __resetLoggerForTests } = await import("@/lib/logger.js");
const { __resetMetricsForTests, workerJobsTotal } = await import("@/lib/metrics.js");
const { __resetShutdownStateForTests } = await import("@/lib/shutdown.js");
const { startWorkerMetricsServer } = await import("@/lib/worker-metrics-server.js");

interface Response {
  status: number;
  body: string;
  headers: Record<string, string>;
}

function request(port: number, method: string, path: string): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = http.request({ method, host: "127.0.0.1", port, path }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c as Buffer));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
          headers: Object.fromEntries(
            Object.entries(res.headers).map(([k, v]) => [
              k,
              Array.isArray(v) ? v.join(",") : (v ?? ""),
            ]),
          ),
        }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

const handles: Array<{ close: () => Promise<void> }> = [];

beforeEach(() => {
  __resetEnvCacheForTests();
  __resetLoggerForTests();
  __resetMetricsForTests();
  __resetShutdownStateForTests();
});

afterEach(async () => {
  delete process.env.WORKER_METRICS_PORT;
  while (handles.length > 0) {
    const h = handles.pop();
    if (h) await h.close();
  }
});

afterAll(async () => {
  while (handles.length > 0) {
    const h = handles.pop();
    if (h) await h.close();
  }
});

describe("startWorkerMetricsServer", () => {
  it("port=0 → opt-out, retorna null sem subir listener", async () => {
    process.env.WORKER_METRICS_PORT = "0";
    __resetEnvCacheForTests();
    const result = await startWorkerMetricsServer({ workerName: "test-worker" });
    expect(result).toBeNull();
  });

  it("GET /metrics → 200 com content-type prometheus + counter visível", async () => {
    workerJobsTotal.inc({ worker: "test-worker", outcome: "ok" }, 7);
    const handle = await startWorkerMetricsServer({ workerName: "test-worker", port: 0 });
    expect(handle).not.toBeNull();
    handles.push(handle!);

    const res = await request(handle!.port, "GET", "/metrics");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/plain/);
    expect(res.body).toContain("bevox_meta_api_worker_jobs_total");
    expect(res.body).toMatch(
      /bevox_meta_api_worker_jobs_total\{worker="test-worker",outcome="ok"\} 7/,
    );
  });

  it("GET /healthz → 200 ok", async () => {
    const handle = await startWorkerMetricsServer({ workerName: "test-worker", port: 0 });
    handles.push(handle!);

    const res = await request(handle!.port, "GET", "/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toBe("ok");
  });

  it("GET path desconhecido → 404", async () => {
    const handle = await startWorkerMetricsServer({ workerName: "test-worker", port: 0 });
    handles.push(handle!);

    const res = await request(handle!.port, "GET", "/something-else");
    expect(res.status).toBe(404);
  });

  it("POST /metrics → 405 com Allow: GET", async () => {
    const handle = await startWorkerMetricsServer({ workerName: "test-worker", port: 0 });
    handles.push(handle!);

    const res = await request(handle!.port, "POST", "/metrics");
    expect(res.status).toBe(405);
    expect(res.headers["allow"]).toBe("GET");
  });

  it("close() libera a porta sem erro", async () => {
    const handle = await startWorkerMetricsServer({ workerName: "test-worker", port: 0 });
    expect(handle).not.toBeNull();
    await expect(handle!.close()).resolves.toBeUndefined();
    // Já fechado — não empilhar.
  });
});
