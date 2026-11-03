/**
 * A19 fix (audit 2026-06-02) — `/readyz` agora cobre KMS além de
 * Postgres+Redis. Sem isso, todo o flow OAuth (cifra de token Meta)
 * quebrava em silêncio enquanto readiness reportava verde.
 *
 * Re-attack (2026-06-02): a primeira passagem só chamava `getKmsClient()`
 * (construtor lazy do GCP client — não exercita auth real), então readyz
 * continuava verde com WIF quebrado. Esta suíte adiciona casos onde o
 * `healthCheck()` do client falha (auth error) ou trava (timeout) e
 * confirma que `readiness.ok` vai a `false` mesmo com DB+Redis verdes.
 */

import { beforeAll, beforeEach, describe, it, expect, vi } from "vitest";

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
  for (const [k, v] of Object.entries(REQUIRED_ENV)) {
    if (v !== undefined) process.env[k] = v;
  }
});

// Postgres/Redis check NÃO devem fazer I/O real nesta suíte unit — só
// estamos validando o shape do relatório + caminho KMS. Mock leves dos
// dois para retornarem sucesso.
vi.mock("@/db/client.js", () => ({
  getDb: () => ({ execute: async () => undefined }),
}));
vi.mock("@/lib/redis.js", () => ({
  getRedis: () => ({ ping: async () => "PONG" }),
}));

// Mock controlável do kms-client para os testes de falha/timeout.
const kmsState = {
  healthCheckImpl: async (): Promise<void> => {
    /* default: ok */
  },
};
vi.mock("@/integration/kms-client.js", () => ({
  getKmsClient: () => ({
    generateDataKey: async () => {
      throw new Error("not used in this suite");
    },
    decryptDataKey: async () => {
      throw new Error("not used in this suite");
    },
    healthCheck: () => kmsState.healthCheckImpl(),
  }),
}));

beforeEach(() => {
  // reset para o default (sucesso) antes de cada teste
  kmsState.healthCheckImpl = async () => {
    /* ok */
  };
});

describe("checkKms (A19)", () => {
  it("KMS healthCheck ok → ok=true (provider=local, in-process)", async () => {
    const { checkKms } = await import("@/lib/health.js");
    const r = await checkKms();
    if (!r.ok) {
      console.error("checkKms failure detail:", r);
    }
    expect(r.ok).toBe(true);
    expect(r.error).toBeUndefined();
    expect(typeof r.latencyMs).toBe("number");
  });

  it("KMS healthCheck throw (auth/WIF broken) → ok=false + mensagem propagada", async () => {
    kmsState.healthCheckImpl = async () => {
      throw new Error("PERMISSION_DENIED: WIF token expired");
    };
    const { checkKms } = await import("@/lib/health.js");
    const r = await checkKms();
    expect(r.ok).toBe(false);
    expect(r.error).toContain("PERMISSION_DENIED");
  });

  it("KMS healthCheck pendurado (network stall) → timeout retorna ok=false antes de bloquear /readyz", async () => {
    // Promise que nunca resolve — simula GCP control-plane stall.
    kmsState.healthCheckImpl = () => new Promise<void>(() => undefined);
    const { checkKms } = await import("@/lib/health.js");
    const start = Date.now();
    const r = await checkKms();
    const elapsed = Date.now() - start;
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/timeout/i);
    // Timeout duro é 3s; margem generosa pra CI lento mas < 10s.
    expect(elapsed).toBeLessThan(10_000);
  });
});

describe("readiness — A19 KMS é gate", () => {
  it("DB+Redis+KMS ok → readiness.ok=true (200)", async () => {
    const { readiness } = await import("@/lib/health.js");
    const report = await readiness();
    expect(report.checks).toHaveProperty("kms");
    expect(typeof report.checks.kms.ok).toBe("boolean");
    expect(report.ok).toBe(true);
  });

  it("DB+Redis ok mas KMS fail → readiness.ok=false (503), mesmo com outros checks verdes", async () => {
    kmsState.healthCheckImpl = async () => {
      throw new Error("UNAUTHENTICATED");
    };
    const { readiness } = await import("@/lib/health.js");
    const report = await readiness();
    expect(report.checks.postgres.ok).toBe(true);
    expect(report.checks.redis.ok).toBe(true);
    expect(report.checks.kms.ok).toBe(false);
    expect(report.ok).toBe(false);
  });

  it("DB+Redis ok mas KMS timeout → readiness.ok=false (503)", async () => {
    kmsState.healthCheckImpl = () => new Promise<void>(() => undefined);
    const { readiness } = await import("@/lib/health.js");
    const report = await readiness();
    expect(report.checks.postgres.ok).toBe(true);
    expect(report.checks.redis.ok).toBe(true);
    expect(report.checks.kms.ok).toBe(false);
    expect(report.checks.kms.error).toMatch(/timeout/i);
    expect(report.ok).toBe(false);
  });
});
