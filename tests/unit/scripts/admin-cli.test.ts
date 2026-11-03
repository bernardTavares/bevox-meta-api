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

vi.mock("@/db/client.js", () => ({
  getDb: () => ({}),
  getPool: () => ({}),
  closeDb: async () => {},
  initDb: () => ({}),
  __resetDbStateForTests: () => {},
}));

vi.mock("@/lib/redis.js", () => ({
  getRedis: () => ({ ping: async () => "PONG", quit: async () => "OK" }),
  closeRedis: async () => {},
  createBullMQConnection: () => ({ quit: async () => "OK" }),
}));

const appsService = vi.hoisted(() => ({
  createApp: vi.fn(),
  listApps: vi.fn(),
  rotateKey: vi.fn(),
  deactivateApp: vi.fn(),
}));
vi.mock("@/modules/apps/service.js", () => appsService);

const webhooksService = vi.hoisted(() => ({
  replayDeadLetters: vi.fn(),
}));
vi.mock("@/modules/webhooks/service.js", () => webhooksService);

const webhooksRepo = vi.hoisted(() => ({
  listDeadLetterDeliveries: vi.fn(),
  findSubscriptionById: vi.fn(),
  findOrCreateDelivery: vi.fn(),
  updateDeliveryAttempt: vi.fn(),
  insertSubscription: vi.fn(),
  listSubscriptionsByApp: vi.fn(),
  setSubscriptionStatus: vi.fn(),
  findSubscriptionScoped: vi.fn(),
  resetDeliveryForReplay: vi.fn(),
}));
vi.mock("@/modules/webhooks/repository.js", () => webhooksRepo);

beforeAll(() => {
  for (const [k, v] of Object.entries(REQUIRED_ENV)) process.env[k] = v;
});

const { __resetEnvCacheForTests } = await import("@/config/env.js");
const { __resetLoggerForTests } = await import("@/lib/logger.js");
const { buildCli } = await import("../../../scripts/admin-cli/index.js");

let stdoutChunks: string[] = [];
let originalWrite: typeof process.stdout.write;

beforeEach(() => {
  __resetEnvCacheForTests();
  __resetLoggerForTests();
  stdoutChunks = [];
  originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;

  appsService.createApp.mockResolvedValue({
    id: "app-1",
    name: "test",
    private_key_pem: "-----BEGIN PRIVATE KEY-----...-----END PRIVATE KEY-----",
    key_id: "key-1",
  });
  appsService.listApps.mockResolvedValue([{ id: "app-1", name: "x", status: "active" }]);
  appsService.rotateKey.mockResolvedValue({
    app_id: "app-1",
    new_kid: "key-2",
    superseded_keys: 1,
    grace_window_days: 14,
    private_key_pem: "-----BEGIN PRIVATE KEY-----...",
  });
  appsService.deactivateApp.mockResolvedValue({ id: "app-1", status: "deactivated" });
  webhooksRepo.listDeadLetterDeliveries.mockResolvedValue([
    { id: "del-1", inboundEventId: "evt-1" },
  ]);
  webhooksService.replayDeadLetters.mockResolvedValue({
    subscription_id: "sub-1",
    replayed: 1,
  });
});

afterEach(() => {
  process.stdout.write = originalWrite;
  vi.clearAllMocks();
});

function output(): string {
  return stdoutChunks.join("");
}

async function run(...args: string[]): Promise<void> {
  const cli = buildCli();
  cli.exitOverride();
  await cli.parseAsync(["node", "cli", ...args]);
}

describe("apps create", () => {
  it("invoca createApp + imprime JSON com private_key_pem", async () => {
    await run("apps", "create", "--name", "Bevox V1");
    expect(appsService.createApp).toHaveBeenCalledWith({
      name: "Bevox V1",
      description: undefined,
    });
    expect(output()).toContain("private_key_pem");
  });

  it("--description é repassada", async () => {
    await run("apps", "create", "--name", "x", "--description", "primário");
    expect(appsService.createApp).toHaveBeenCalledWith({
      name: "x",
      description: "primário",
    });
  });

  it("sem --name → erro", async () => {
    await expect(run("apps", "create")).rejects.toThrow();
  });
});

describe("apps list", () => {
  it("imprime apps em JSON", async () => {
    await run("apps", "list");
    expect(appsService.listApps).toHaveBeenCalledTimes(1);
    expect(output()).toContain('"id": "app-1"');
  });
});

describe("apps rotate-key", () => {
  it("default grace=14", async () => {
    await run("apps", "rotate-key", "--app-id", "app-1");
    expect(appsService.rotateKey).toHaveBeenCalledWith({
      appId: "app-1",
      graceWindowDays: 14,
    });
  });

  it("--grace-days override", async () => {
    await run("apps", "rotate-key", "--app-id", "app-1", "--grace-days", "7");
    expect(appsService.rotateKey).toHaveBeenCalledWith({
      appId: "app-1",
      graceWindowDays: 7,
    });
  });
});

describe("apps deactivate", () => {
  it("--dry-run não chama service", async () => {
    await run("apps", "deactivate", "--app-id", "app-1", "--dry-run");
    expect(appsService.deactivateApp).not.toHaveBeenCalled();
    expect(output()).toContain('"dry_run": true');
  });

  it("real run chama service", async () => {
    await run("apps", "deactivate", "--app-id", "app-1");
    expect(appsService.deactivateApp).toHaveBeenCalledWith("app-1");
  });
});

describe("dead-letter", () => {
  it("list invoca listDeadLetterDeliveries", async () => {
    await run("dead-letter", "list", "--subscription-id", "sub-1");
    expect(webhooksRepo.listDeadLetterDeliveries).toHaveBeenCalledWith("sub-1");
  });

  it("replay --dry-run lista mas não enfileira", async () => {
    await run("dead-letter", "replay", "--subscription-id", "sub-1", "--dry-run");
    expect(webhooksService.replayDeadLetters).not.toHaveBeenCalled();
    expect(output()).toContain('"dry_run": true');
  });

  it("replay sem dry-run chama service", async () => {
    await run("dead-letter", "replay", "--subscription-id", "sub-1");
    expect(webhooksService.replayDeadLetters).toHaveBeenCalledWith("sub-1");
  });
});

describe("--format=table", () => {
  it("imprime tabular para arrays", async () => {
    await run("--format", "table", "apps", "list");
    const out = output();
    expect(out).toContain("id\tname\tstatus");
    expect(out).toContain("app-1");
  });
});
