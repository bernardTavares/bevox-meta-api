import { SignJWT } from "jose";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { buildServer } from "@/bootstrap/server.js";
import { __resetEnvCacheForTests } from "@/config/env.js";
import { __resetLoggerForTests } from "@/lib/logger.js";
import { uuidv7 } from "@/lib/uuid.js";

const ADMIN_KEY = "test-admin-key-1234";

const REQUIRED_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  LOG_LEVEL: "fatal",
  DATABASE_URL: "postgresql://bevox:pwd@localhost:5432/test",
  REDIS_URL: "redis://localhost:6379",
  KMS_PROVIDER: "local",
  KMS_KEY_ID: "test-key",
  KMS_LOCAL_MASTER_KEY: Buffer.alloc(32, 0x42).toString("base64"),
  ADMIN_API_KEY: ADMIN_KEY,
  META_APP_ID: "1234567890",
  OAUTH_CALLBACK_BASE_URL: "https://meta-api.bevox.test",
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
  closeRedis: async () => {},
  createBullMQConnection: () => ({ quit: async () => "OK" }),
}));

const appsRepo = vi.hoisted(() => ({
  findConsumerAppById: vi.fn(),
  findActiveAppKey: vi.fn(),
  listConsumerApps: vi.fn(),
  createConsumerAppWithKey: vi.fn(),
  setConsumerAppStatus: vi.fn(),
  rotateAppKey: vi.fn(),
}));
vi.mock("@/modules/apps/repository.js", () => appsRepo);

let app: Awaited<ReturnType<typeof buildServer>>;

async function adminToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ role: "admin" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("admin-1")
    .setAudience("bevox-meta-api-admin")
    .setIssuedAt(now)
    .setExpirationTime(now + 600)
    .sign(new TextEncoder().encode(ADMIN_KEY));
}

beforeAll(async () => {
  for (const [k, v] of Object.entries(REQUIRED_ENV)) process.env[k] = v;
  __resetEnvCacheForTests();
  __resetLoggerForTests();
  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  appsRepo.createConsumerAppWithKey.mockImplementation(async (input: any) => {
    const id = uuidv7();
    const keyId = uuidv7();
    return {
      app: {
        id,
        name: input.name,
        description: input.description,
        status: "active",
        currentPublicKeyPem: input.publicKeyPem,
        currentPublicKeyId: keyId,
        metadataJson: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      key: {
        id: keyId,
        appId: id,
        publicKeyPem: input.publicKeyPem,
        algo: "RS256",
        validFrom: new Date(),
        validUntil: null,
        rotatedAt: null,
        createdAt: new Date(),
      },
    };
  });
  appsRepo.listConsumerApps.mockResolvedValue([]);
  appsRepo.setConsumerAppStatus.mockResolvedValue(null);
  appsRepo.rotateAppKey.mockResolvedValue({
    newKey: { id: uuidv7(), appId: uuidv7(), publicKeyPem: "x", algo: "RS256" },
    supersededKeys: 1,
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("POST /admin/apps", () => {
  it("cria app + retorna private_key_pem uma única vez", async () => {
    const t = await adminToken();
    const res = await app.inject({
      method: "POST",
      url: "/admin/apps",
      headers: { authorization: `Bearer ${t}` },
      payload: { name: "bevox-v1" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.name).toBe("bevox-v1");
    expect(body.status).toBe("active");
    expect(body.private_key_pem).toMatch(/-----BEGIN PRIVATE KEY-----/);
    expect(body.key_id).toMatch(/^[0-9a-f-]{36}$/);

    const insertArgs = appsRepo.createConsumerAppWithKey.mock.calls[0]![0];
    expect(insertArgs.publicKeyPem).toMatch(/-----BEGIN PUBLIC KEY-----/);
  });

  it("rejeita sem admin auth → 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/apps",
      payload: { name: "x" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("body inválido (sem name) → 400", async () => {
    const t = await adminToken();
    const res = await app.inject({
      method: "POST",
      url: "/admin/apps",
      headers: { authorization: `Bearer ${t}` },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /admin/apps", () => {
  it("lista apps", async () => {
    appsRepo.listConsumerApps.mockResolvedValueOnce([
      {
        id: uuidv7(),
        name: "a",
        description: null,
        status: "active",
        currentPublicKeyPem: null,
        currentPublicKeyId: null,
        metadataJson: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    const t = await adminToken();
    const res = await app.inject({
      method: "GET",
      url: "/admin/apps",
      headers: { authorization: `Bearer ${t}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(1);
  });
});

describe("POST /admin/apps/:id/keys/rotate", () => {
  it("rotaciona key + retorna new_kid + private_key_pem", async () => {
    const appId = uuidv7();
    appsRepo.findConsumerAppById.mockResolvedValueOnce({
      id: appId,
      name: "x",
      description: null,
      status: "active",
      currentPublicKeyPem: "old",
      currentPublicKeyId: uuidv7(),
      metadataJson: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const newKid = uuidv7();
    appsRepo.rotateAppKey.mockResolvedValueOnce({
      newKey: { id: newKid, appId, publicKeyPem: "new", algo: "RS256" },
      supersededKeys: 1,
    });

    const t = await adminToken();
    const res = await app.inject({
      method: "POST",
      url: `/admin/apps/${appId}/keys/rotate`,
      headers: { authorization: `Bearer ${t}` },
      payload: { grace_window_days: 7 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.new_kid).toBe(newKid);
    expect(body.grace_window_days).toBe(7);
    expect(body.superseded_keys).toBe(1);
    expect(body.private_key_pem).toMatch(/-----BEGIN PRIVATE KEY-----/);

    const args = appsRepo.rotateAppKey.mock.calls[0]![0];
    expect(args.appId).toBe(appId);
    expect(args.graceWindowDays).toBe(7);
  });

  it("default grace = 14 dias quando não fornecido", async () => {
    const appId = uuidv7();
    appsRepo.findConsumerAppById.mockResolvedValueOnce({
      id: appId,
      name: "x",
      description: null,
      status: "active",
      currentPublicKeyPem: null,
      currentPublicKeyId: null,
      metadataJson: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    appsRepo.rotateAppKey.mockResolvedValueOnce({
      newKey: { id: uuidv7(), appId, publicKeyPem: "x", algo: "RS256" },
      supersededKeys: 0,
    });
    const t = await adminToken();
    const res = await app.inject({
      method: "POST",
      url: `/admin/apps/${appId}/keys/rotate`,
      headers: { authorization: `Bearer ${t}` },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(appsRepo.rotateAppKey.mock.calls[0]![0].graceWindowDays).toBe(14);
  });

  it("app deactivated → 409", async () => {
    const appId = uuidv7();
    appsRepo.findConsumerAppById.mockResolvedValueOnce({
      id: appId,
      name: "x",
      description: null,
      status: "deactivated",
      currentPublicKeyPem: null,
      currentPublicKeyId: null,
      metadataJson: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const t = await adminToken();
    const res = await app.inject({
      method: "POST",
      url: `/admin/apps/${appId}/keys/rotate`,
      headers: { authorization: `Bearer ${t}` },
      payload: {},
    });
    expect(res.statusCode).toBe(409);
  });

  it("app inexistente → 404", async () => {
    appsRepo.findConsumerAppById.mockResolvedValueOnce(null);
    const t = await adminToken();
    const res = await app.inject({
      method: "POST",
      url: `/admin/apps/${uuidv7()}/keys/rotate`,
      headers: { authorization: `Bearer ${t}` },
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /admin/apps/:id/deactivate", () => {
  it("muda status para deactivated", async () => {
    const appId = uuidv7();
    appsRepo.findConsumerAppById.mockResolvedValueOnce({
      id: appId,
      name: "x",
      description: null,
      status: "active",
      currentPublicKeyPem: null,
      currentPublicKeyId: null,
      metadataJson: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    appsRepo.setConsumerAppStatus.mockResolvedValueOnce({
      id: appId,
      name: "x",
      description: null,
      status: "deactivated",
      currentPublicKeyPem: null,
      currentPublicKeyId: null,
      metadataJson: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const t = await adminToken();
    const res = await app.inject({
      method: "POST",
      url: `/admin/apps/${appId}/deactivate`,
      headers: { authorization: `Bearer ${t}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("deactivated");
  });

  it("já deactivated → 409", async () => {
    const appId = uuidv7();
    appsRepo.findConsumerAppById.mockResolvedValueOnce({
      id: appId,
      name: "x",
      description: null,
      status: "deactivated",
      currentPublicKeyPem: null,
      currentPublicKeyId: null,
      metadataJson: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const t = await adminToken();
    const res = await app.inject({
      method: "POST",
      url: `/admin/apps/${appId}/deactivate`,
      headers: { authorization: `Bearer ${t}` },
    });
    expect(res.statusCode).toBe(409);
  });
});
