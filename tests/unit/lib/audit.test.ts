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
  insertAuditLog: vi.fn<(input: Record<string, unknown>) => Promise<unknown>>(
    async () => undefined,
  ),
}));
vi.mock("@/modules/audit/repository.js", () => repo);

beforeAll(() => {
  for (const [k, v] of Object.entries(REQUIRED_ENV)) process.env[k] = v;
});

const { __resetEnvCacheForTests } = await import("@/config/env.js");
const { __resetLoggerForTests } = await import("@/lib/logger.js");
const { logAudit } = await import("@/lib/audit.js");

beforeEach(() => {
  __resetEnvCacheForTests();
  __resetLoggerForTests();
  repo.insertAuditLog.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("logAudit", () => {
  it("persiste com payload redacted", async () => {
    await logAudit({
      actorType: "consumer_app",
      actorId: "app-123",
      action: "POST:/v1/messages",
      resourceType: "messages",
      resourceId: "msg-1",
      appId: "app-123",
      tenantId: "tenant-1",
      metadata: {
        body: "secret message body",
        nested: { password: "p4ss" },
      },
      ip: "10.0.0.1",
      userAgent: "test-agent",
    });
    expect(repo.insertAuditLog).toHaveBeenCalledTimes(1);
    const args = repo.insertAuditLog.mock.calls[0]![0];
    expect(args.actorType).toBe("consumer_app");
    expect(args.action).toBe("POST:/v1/messages");
    expect(args.tenantId).toBe("tenant-1");
    // body e password devem ser [REDACTED]
    expect(JSON.stringify(args.payloadRedacted)).not.toContain("secret message body");
    expect(JSON.stringify(args.payloadRedacted)).not.toContain("p4ss");
    expect(args.payloadRedacted).toMatchObject({
      body: "[REDACTED]",
      nested: { password: "[REDACTED]" },
    });
  });

  it("falha em insert é silenciada (best-effort)", async () => {
    repo.insertAuditLog.mockRejectedValueOnce(new Error("DB down"));
    await expect(
      logAudit({
        actorType: "system",
        action: "test",
        resourceType: "test",
      }),
    ).resolves.toBeUndefined();
  });

  it("default null para campos opcionais ausentes", async () => {
    await logAudit({
      actorType: "system",
      action: "boot",
      resourceType: "system",
    });
    const args = repo.insertAuditLog.mock.calls[0]![0];
    expect(args.actorId).toBeNull();
    expect(args.tenantId).toBeNull();
    expect(args.appId).toBeNull();
    expect(args.ip).toBeNull();
  });
});
