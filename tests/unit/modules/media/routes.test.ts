import { generateKeyPairSync } from "node:crypto";

import { SignJWT, importPKCS8 } from "jose";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { buildServer } from "@/bootstrap/server.js";
import { __resetEnvCacheForTests } from "@/config/env.js";
import { setMetaOAuthClientForTests } from "@/integration/meta-client.js";
import { __resetLoggerForTests } from "@/lib/logger.js";
import { uuidv7 } from "@/lib/uuid.js";

const REQUIRED_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  LOG_LEVEL: "trace", // queremos capturar TODOS os logs p/ assert de URL.
  DATABASE_URL: "postgresql://bevox:pwd@localhost:5432/test",
  REDIS_URL: "redis://localhost:6379",
  KMS_PROVIDER: "local",
  KMS_KEY_ID: "test-key",
  KMS_LOCAL_MASTER_KEY: Buffer.alloc(32, 0x42).toString("base64"),
  ADMIN_API_KEY: "test-admin-key-1234",
  META_APP_ID: "1234567890",
  OAUTH_CALLBACK_BASE_URL: "https://meta-api.bevox.test",
  MEDIA_S3_ENDPOINT: "https://minio.bevox.test",
  MEDIA_S3_ACCESS_KEY: "ak",
  MEDIA_S3_SECRET_KEY: "sk",
  MEDIA_S3_BUCKET: "media",
  MEDIA_PRESIGN_TTL_SECONDS: "180",
};

vi.mock("@/lib/redis.js", () => ({
  getRedis: () => ({
    get: async () => null,
    set: async () => "OK",
    getdel: async () => null,
    eval: async () => [1, 1000, 0],
    ping: async () => "PONG",
    quit: async () => "OK",
  }),
  closeRedis: async () => {
    // no-op
  },
  createBullMQConnection: () => ({}),
}));

const PRESIGNED_URL =
  "https://minio.bevox.test/media/TENANT/MEDIA-1?X-Amz-Signature=SECRETSIGNATURE123";

const storage = vi.hoisted(() => ({
  head: vi.fn(),
  presign: vi.fn(),
}));
vi.mock("@/lib/media-storage.js", () => ({
  // mediaObjectKey real: valida path-traversal. Reimplementamos a regra mínima.
  mediaObjectKey: (tenantId: string, mediaId: string) => {
    const SAFE = /^[A-Za-z0-9._:-]+$/;
    if (!tenantId || !mediaId || !SAFE.test(tenantId) || !SAFE.test(mediaId)) {
      throw new Error("invalid media key part");
    }
    return `${tenantId}/${mediaId}`;
  },
  headMedia: storage.head,
  getPresignedUrl: storage.presign,
}));

const APP_ID = uuidv7();
const TENANT_ID = uuidv7();
const KEY_ID = uuidv7();

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_PKCS8 = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const PUBLIC_SPKI = publicKey.export({ type: "spki", format: "pem" }).toString();

vi.mock("@/modules/apps/repository.js", () => ({
  findConsumerAppById: vi.fn(async (id: string) => ({
    id,
    name: "test",
    description: null,
    status: "active" as const,
    currentPublicKeyPem: null,
    currentPublicKeyId: null,
    metadataJson: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  })),
  findActiveAppKey: vi.fn(async (appId: string, keyId: string) => ({
    id: keyId,
    appId,
    publicKeyPem: PUBLIC_SPKI,
    algo: "RS256" as const,
    validFrom: new Date(Date.now() - 60_000),
    validUntil: null,
    rotatedAt: null,
    createdAt: new Date(),
  })),
}));

const wabaRepo = vi.hoisted(() => ({
  list: vi.fn(),
}));
vi.mock("@/modules/wabas/repository.js", () => ({
  listWabasByTenant: wabaRepo.list,
  findWabaConnectionById: vi.fn(),
  disconnectWaba: vi.fn(),
  createWabaConnectionWithToken: vi.fn(),
  findWabaByTenantAndMetaId: vi.fn(),
  findWabaByMetaWabaId: vi.fn(),
  reconnectWaba: vi.fn(),
}));

const fakeMeta = {
  exchangeCode: vi.fn(),
  exchangeLongLivedToken: vi.fn(),
  discoverWaba: vi.fn(),
  subscribeWabaApp: vi.fn(),
  discoverIgAccount: vi.fn(),
  listPhoneNumbers: vi.fn(),
  updatePhoneNumberProfile: vi.fn(),
  createMessageTemplate: vi.fn(),
  getMessageTemplate: vi.fn(),
  deleteMessageTemplate: vi.fn(),
  sendWhatsAppMessage: vi.fn(),
  sendInstagramMessage: vi.fn(),
  getMediaMetadata: vi.fn(),
  downloadMedia: vi.fn(),
  getPhoneCoexInfo: vi.fn(),
  triggerSmbAppDataSync: vi.fn(),
};

let app: Awaited<ReturnType<typeof buildServer>>;
let signingKey: Awaited<ReturnType<typeof importPKCS8>>;
let logSink: string[];

async function token(scope: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ scope })
    .setProtectedHeader({ alg: "RS256", kid: KEY_ID })
    .setIssuer(APP_ID)
    .setAudience("bevox-meta-api")
    .setIssuedAt(now)
    .setExpirationTime(now + 60)
    .sign(signingKey);
}

beforeAll(async () => {
  for (const [k, v] of Object.entries(REQUIRED_ENV)) process.env[k] = v;
  __resetEnvCacheForTests();
  __resetLoggerForTests();
  setMetaOAuthClientForTests(fakeMeta);
  signingKey = await importPKCS8(PRIVATE_PKCS8, "RS256");
  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  setMetaOAuthClientForTests(null);
});

beforeEach(() => {
  logSink = [];
  // Captura tudo que o request logger emite.
  const orig = process.stdout.write.bind(process.stdout);
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: any, ...rest: any[]) => {
    logSink.push(typeof chunk === "string" ? chunk : chunk.toString());
    return orig(chunk, ...rest);
  });
  wabaRepo.list.mockResolvedValue([
    {
      id: uuidv7(),
      tenantId: TENANT_ID,
      appId: APP_ID,
      metaBusinessId: "biz",
      metaWabaId: "waba-meta",
      displayName: "X",
      verifiedStatus: "VERIFIED",
      createdAt: new Date(),
      updatedAt: new Date(),
      disconnectedAt: null,
    },
  ]);
  storage.head.mockResolvedValue(true);
  storage.presign.mockResolvedValue(PRESIGNED_URL);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("GET /v1/media/:media_key", () => {
  it("sem auth → 401", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/media/MEDIA-1",
      headers: { "x-tenant-id": TENANT_ID },
    });
    expect(res.statusCode).toBe(401);
  });

  it("sem scope media:read → 403", async () => {
    const t = await token("messages:write");
    const res = await app.inject({
      method: "GET",
      url: "/v1/media/MEDIA-1",
      headers: { authorization: `Bearer ${t}`, "x-tenant-id": TENANT_ID },
    });
    expect(res.statusCode).toBe(403);
  });

  it("app↔tenant inválido (sem waba) → 403", async () => {
    wabaRepo.list.mockResolvedValueOnce([]);
    const t = await token("media:read");
    const res = await app.inject({
      method: "GET",
      url: "/v1/media/MEDIA-1",
      headers: { authorization: `Bearer ${t}`, "x-tenant-id": TENANT_ID },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
  });

  it("X-Tenant-Id ausente → 400", async () => {
    const t = await token("media:read");
    const res = await app.inject({
      method: "GET",
      url: "/v1/media/MEDIA-1",
      headers: { authorization: `Bearer ${t}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it("media_key malformada (path-traversal) → 400", async () => {
    const t = await token("media:read");
    const res = await app.inject({
      method: "GET",
      url: "/v1/media/..%2F..%2Fetc",
      headers: { authorization: `Bearer ${t}`, "x-tenant-id": TENANT_ID },
    });
    expect(res.statusCode).toBe(400);
  });

  it("objeto presente → 302 redirect para URL pré-assinada (e URL NÃO é logada)", async () => {
    const t = await token("media:read");
    const res = await app.inject({
      method: "GET",
      url: "/v1/media/MEDIA-1",
      headers: { authorization: `Bearer ${t}`, "x-tenant-id": TENANT_ID },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(PRESIGNED_URL);

    // Segurança: a URL pré-assinada (e sua assinatura) NUNCA aparece no log.
    const allLogs = logSink.join("");
    expect(allLogs).not.toContain(PRESIGNED_URL);
    expect(allLogs).not.toContain("SECRETSIGNATURE123");
  });

  it("objeto ainda não baixado → 202 processing", async () => {
    storage.head.mockResolvedValueOnce(false);
    const t = await token("media:read");
    const res = await app.inject({
      method: "GET",
      url: "/v1/media/MEDIA-1",
      headers: { authorization: `Bearer ${t}`, "x-tenant-id": TENANT_ID },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ status: "processing" });
  });
});
