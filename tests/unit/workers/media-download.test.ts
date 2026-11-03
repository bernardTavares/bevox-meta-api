import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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

const MEDIA_MAX_BYTES = 26_214_400;

const storage = vi.hoisted(() => ({
  mediaObjectKey: vi.fn((tenantId: string, mediaId: string) => `${tenantId}/${mediaId}`),
  headMedia: vi.fn(),
  putMedia: vi.fn(),
}));
vi.mock("@/lib/media-storage.js", () => storage);

const client = vi.hoisted(() => ({
  getMediaMetadata: vi.fn(),
  downloadMedia: vi.fn(),
  getPhoneCoexInfo: vi.fn(),
  triggerSmbAppDataSync: vi.fn(),
}));
vi.mock("@/integration/meta-client.js", () => ({
  getMetaOAuthClient: () => client,
}));

const wabaRepo = vi.hoisted(() => ({
  listWabasByTenant: vi.fn(),
}));
vi.mock("@/modules/wabas/repository.js", () => wabaRepo);

const tokenResolver = vi.hoisted(() => ({
  resolveActiveWabaToken: vi.fn(),
}));
vi.mock("@/modules/wabas/token-resolver.js", () => tokenResolver);

vi.mock("@/lib/redis.js", () => ({
  getRedis: () => ({
    get: async () => null,
    set: async () => "OK",
    ping: async () => "PONG",
    quit: async () => "OK",
  }),
  closeRedis: async () => {},
  createBullMQConnection: () => ({ quit: async () => "OK" }),
}));

vi.mock("@/config/env.js", () => ({
  env: () => ({
    NODE_ENV: "test",
    LOG_LEVEL: "fatal",
    OTEL_SERVICE_NAME: "bevox-meta-api",
    MEDIA_MAX_BYTES,
  }),
  __resetEnvCacheForTests: () => {},
}));

const { __resetLoggerForTests } = await import("@/lib/logger.js");
const { processMediaDownload } = await import("@/workers/media-download.js");

beforeAll(() => {
  for (const [k, v] of Object.entries(REQUIRED_ENV)) process.env[k] = v;
  __resetLoggerForTests();
});

const APP_ID = "app-1";
const TENANT_ID = "tenant-1";
const MEDIA_ID = "media-1";
const KEY = `${TENANT_ID}/${MEDIA_ID}`;

function job(overrides: Partial<{ app_id: string; tenant_id: string; media_id: string }> = {}) {
  return { app_id: APP_ID, tenant_id: TENANT_ID, media_id: MEDIA_ID, ...overrides };
}

beforeEach(() => {
  storage.mediaObjectKey.mockImplementation((t: string, m: string) => `${t}/${m}`);
  storage.headMedia.mockResolvedValue(false);
  storage.putMedia.mockResolvedValue(undefined);
  wabaRepo.listWabasByTenant.mockResolvedValue([{ id: "waba-conn-1" }]);
  tokenResolver.resolveActiveWabaToken.mockResolvedValue({
    accessToken: "plain-token",
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  client.getMediaMetadata.mockResolvedValue({
    url: "https://cdn.meta/abc",
    mime_type: "image/jpeg",
    file_size: 1024,
  });
  client.downloadMedia.mockResolvedValue(Buffer.from("imgbytes"));
});

afterEach(() => {
  vi.clearAllMocks();
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe("processMediaDownload — idempotência", () => {
  it("key já no storage → retorna sem chamar o client", async () => {
    storage.headMedia.mockResolvedValueOnce(true);

    await processMediaDownload(job());

    expect(client.getMediaMetadata).not.toHaveBeenCalled();
    expect(client.downloadMedia).not.toHaveBeenCalled();
    expect(storage.putMedia).not.toHaveBeenCalled();
  });
});

describe("processMediaDownload — oversized", () => {
  it("file_size > MEDIA_MAX_BYTES → não baixa nem persiste", async () => {
    client.getMediaMetadata.mockResolvedValueOnce({
      url: "https://cdn.meta/big",
      mime_type: "video/mp4",
      file_size: MEDIA_MAX_BYTES + 1,
    });

    await processMediaDownload(job());

    expect(client.getMediaMetadata).toHaveBeenCalledWith(MEDIA_ID, "plain-token");
    expect(client.downloadMedia).not.toHaveBeenCalled();
    expect(storage.putMedia).not.toHaveBeenCalled();
  });
});

describe("processMediaDownload — happy path", () => {
  it("resolve token → metadata → download → put com a key correta", async () => {
    await processMediaDownload(job());

    expect(wabaRepo.listWabasByTenant).toHaveBeenCalledWith(APP_ID, TENANT_ID);
    expect(tokenResolver.resolveActiveWabaToken).toHaveBeenCalledWith("waba-conn-1");
    expect(client.getMediaMetadata).toHaveBeenCalledWith(MEDIA_ID, "plain-token");
    expect(client.downloadMedia).toHaveBeenCalledWith("https://cdn.meta/abc", "plain-token");
    expect(storage.putMedia).toHaveBeenCalledWith(KEY, Buffer.from("imgbytes"), "image/jpeg");
  });
});

describe("processMediaDownload — sem waba ativa", () => {
  it("nenhuma waba ativa → retorna sem download", async () => {
    wabaRepo.listWabasByTenant.mockResolvedValueOnce([]);

    await processMediaDownload(job());

    expect(tokenResolver.resolveActiveWabaToken).not.toHaveBeenCalled();
    expect(client.getMediaMetadata).not.toHaveBeenCalled();
    expect(client.downloadMedia).not.toHaveBeenCalled();
    expect(storage.putMedia).not.toHaveBeenCalled();
  });
});
