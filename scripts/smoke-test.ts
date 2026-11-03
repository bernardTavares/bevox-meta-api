/**
 * Smoke test de produção — roda contra um deployment vivo (staging ou prod)
 * para validar saúde básica.
 *
 * Uso:
 *   BEVOX_META_API_URL=https://meta-api.example.com tsx scripts/smoke-test.ts
 *
 * Exit code 0 = todos passaram; 1 = algum falhou (use no CI / cron).
 *
 * NÃO usa SDK interno — tudo via fetch nativo, simulando consumer real.
 */

const BASE_URL = process.env.BEVOX_META_API_URL ?? "http://localhost:3000";
const TIMEOUT_MS = 10_000;

interface Check {
  name: string;
  run(): Promise<void>;
}

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

const checks: Check[] = [
  {
    name: "GET /healthz → 200 ok",
    async run() {
      const res = await fetchWithTimeout(`${BASE_URL}/healthz`);
      if (res.status !== 200) throw new Error(`status ${res.status}`);
      const body = (await res.json()) as { status?: string };
      if (body.status !== "ok") throw new Error(`body.status=${body.status}`);
    },
  },
  {
    name: "GET /readyz → 200 com PG+Redis healthy",
    async run() {
      const res = await fetchWithTimeout(`${BASE_URL}/readyz`);
      if (res.status !== 200) throw new Error(`status ${res.status}`);
      const body = (await res.json()) as {
        ok?: boolean;
        checks?: { postgres?: { ok?: boolean }; redis?: { ok?: boolean } };
      };
      if (!body.ok) throw new Error(`ok=false; ${JSON.stringify(body.checks)}`);
      if (body.checks?.postgres?.ok !== true) throw new Error("postgres unhealthy");
      if (body.checks?.redis?.ok !== true) throw new Error("redis unhealthy");
    },
  },
  {
    name: "GET /metrics → text/plain com bevox_meta_api_*",
    async run() {
      const res = await fetchWithTimeout(`${BASE_URL}/metrics`);
      if (res.status !== 200) throw new Error(`status ${res.status}`);
      const text = await res.text();
      if (!text.includes("bevox_meta_api_http_requests_total")) {
        throw new Error("metric bevox_meta_api_http_requests_total ausente");
      }
    },
  },
  {
    name: "GET /v1/tenants sem auth → 401",
    async run() {
      const res = await fetchWithTimeout(`${BASE_URL}/v1/tenants`);
      if (res.status !== 401) throw new Error(`expected 401, got ${res.status}`);
    },
  },
  {
    name: "GET /webhooks/meta com query inválida → 400",
    async run() {
      const res = await fetchWithTimeout(`${BASE_URL}/webhooks/meta`);
      if (res.status !== 400) throw new Error(`expected 400, got ${res.status}`);
    },
  },
];

async function main(): Promise<void> {
  let failed = 0;
  process.stdout.write(`Smoke test against ${BASE_URL}\n\n`);
  for (const check of checks) {
    const start = Date.now();
    try {
      await check.run();
      process.stdout.write(`  ✓ ${check.name} (${Date.now() - start}ms)\n`);
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      process.stdout.write(`  ✗ ${check.name}: ${msg}\n`);
    }
  }
  process.stdout.write(`\n${checks.length - failed}/${checks.length} passed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
