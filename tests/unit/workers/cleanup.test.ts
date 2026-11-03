import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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

const repo = vi.hoisted(() => ({
  cleanExpiredIdempotency: vi.fn<(now?: Date) => Promise<number>>(async () => 0),
  cleanOldInboundEvents: vi.fn<(cutoff: Date) => Promise<number>>(async () => 0),
  cleanOldOutboundJobs: vi.fn<(cutoff: Date) => Promise<number>>(async () => 0),
}));
vi.mock("@/modules/cleanup/repository.js", () => repo);

vi.mock("@/lib/redis.js", () => ({
  getRedis: () => ({ ping: async () => "PONG", quit: async () => "OK" }),
  closeRedis: async () => {},
  createBullMQConnection: () => ({ quit: async () => "OK" }),
}));

beforeAll(() => {
  for (const [k, v] of Object.entries(REQUIRED_ENV)) process.env[k] = v;
});

const { __resetEnvCacheForTests } = await import("@/config/env.js");
const { __resetLoggerForTests } = await import("@/lib/logger.js");
const { __resetMetricsForTests, workerJobsTotal, registry } = await import("@/lib/metrics.js");
const { runCleanup } = await import("@/workers/cleanup.js");

beforeEach(() => {
  __resetEnvCacheForTests();
  __resetLoggerForTests();
  __resetMetricsForTests();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("runCleanup", () => {
  it("invoca os 3 cleaners e retorna contagens", async () => {
    repo.cleanExpiredIdempotency.mockResolvedValueOnce(42);
    repo.cleanOldInboundEvents.mockResolvedValueOnce(7);
    repo.cleanOldOutboundJobs.mockResolvedValueOnce(13);

    const result = await runCleanup();
    expect(result).toEqual({
      idempotency_records: 42,
      inbound_events: 7,
      outbound_jobs: 13,
    });
    expect(repo.cleanExpiredIdempotency).toHaveBeenCalledTimes(1);
    expect(repo.cleanOldInboundEvents).toHaveBeenCalledTimes(1);
    expect(repo.cleanOldOutboundJobs).toHaveBeenCalledTimes(1);
  });

  it("inbound cutoff = now - 90d, outbound cutoff = now - 30d", async () => {
    const fixedNow = new Date("2026-04-26T10:00:00Z");
    await runCleanup(fixedNow);

    const inboundCutoff = repo.cleanOldInboundEvents.mock.calls[0]![0] as Date;
    const outboundCutoff = repo.cleanOldOutboundJobs.mock.calls[0]![0] as Date;

    const day = 24 * 60 * 60 * 1000;
    expect(fixedNow.getTime() - inboundCutoff.getTime()).toBe(90 * day);
    expect(fixedNow.getTime() - outboundCutoff.getTime()).toBe(30 * day);
  });

  it("agrega zeros sem erro", async () => {
    const result = await runCleanup();
    expect(result).toEqual({
      idempotency_records: 0,
      inbound_events: 0,
      outbound_jobs: 0,
    });
  });
});

describe("workerJobsTotal — A17 metrics scrape boundary", () => {
  it("counter está registrado e scrapeável via registry global", async () => {
    workerJobsTotal.inc({ worker: "cleanup", outcome: "ok" }, 3);
    const dump = await registry.metrics();
    expect(dump).toContain("bevox_meta_api_worker_jobs_total");
    expect(dump).toMatch(/bevox_meta_api_worker_jobs_total\{worker="cleanup",outcome="ok"\} 3/);
  });
});
