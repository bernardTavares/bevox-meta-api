import { generateKeyPairSync } from "node:crypto";

import { SignJWT, importPKCS8 } from "jose";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { buildServer } from "@/bootstrap/server.js";
import { __resetEnvCacheForTests } from "@/config/env.js";
import { __resetKmsClientForTests } from "@/integration/kms-client.js";
import { __resetLoggerForTests } from "@/lib/logger.js";
import { uuidv7 } from "@/lib/uuid.js";
import { setVerifierClientForTests } from "@/modules/webhooks/service.js";

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

const queueAdd = vi.hoisted(() => ({
  fn: vi.fn(async (_n: string, _p: unknown, _o?: unknown) => undefined),
}));
vi.mock("@/lib/queues.js", () => ({
  OUTBOUND_QUEUE: "outbound-meta",
  WEBHOOK_DELIVERY_QUEUE: "webhook-delivery",
  DEFAULT_JOB_OPTIONS: {},
  WEBHOOK_BACKOFF_STRATEGY: "bevox-prd-10-2",
  WEBHOOK_BACKOFF_SCHEDULE_MS: [0, 30_000, 120_000, 600_000, 3_600_000, 21_600_000],
  getWebhookBackoffDelay: (_n: number) => 0,
  webhookDeliveryJobOptions: () => ({
    attempts: 8,
    backoff: { type: "bevox-prd-10-2" },
  }),
  getOutboundQueue: () => ({ add: queueAdd.fn }),
  getWebhookDeliveryQueue: () => ({ add: queueAdd.fn }),
  closeQueues: async () => {},
  __resetQueuesForTests: () => {},
}));

const APP_ID = uuidv7();
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

const idem = vi.hoisted(() => {
  const store = new Map<string, unknown>();
  return {
    store,
    findRecordSpy: vi.fn(async (a: string, k: string) => store.get(`${a}:${k}`) ?? null),
    saveRecordSpy: vi.fn(async (input: any) => {
      const k = `${input.appId}:${input.key}`;
      if (!store.has(k)) store.set(k, input);
    }),
  };
});
vi.mock("@/modules/idempotency/repository.js", () => ({
  findIdempotencyRecord: idem.findRecordSpy,
  saveIdempotencyRecord: idem.saveRecordSpy,
}));

vi.mock("@/modules/tenants/repository.js", () => ({
  findTenantById: vi.fn(async (_appId: string, _id: string) => ({
    id: _id,
    appId: _appId,
    externalId: null,
    displayName: "T",
    metadataJson: {},
    status: "active",
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  })),
  insertTenant: vi.fn(),
  findTenantByExternalId: vi.fn(),
  listTenants: vi.fn(),
  updateTenant: vi.fn(),
  softDeleteTenant: vi.fn(),
  countActiveBindings: vi.fn(),
}));

const subRepo = vi.hoisted(() => ({
  findSubscriptionById: vi.fn(),
  findSubscriptionScoped: vi.fn(),
  insertSubscription: vi.fn(),
  listSubscriptionsByApp: vi.fn(),
  setSubscriptionStatus: vi.fn(),
  listDeadLetterDeliveries: vi.fn(),
  resetDeliveryForReplay: vi.fn(),
  findOrCreateDelivery: vi.fn(),
  updateDeliveryAttempt: vi.fn(),
}));
vi.mock("@/modules/webhooks/repository.js", () => subRepo);

let app: Awaited<ReturnType<typeof buildServer>>;
let signingKey: Awaited<ReturnType<typeof importPKCS8>>;

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

const verifier = {
  verify: vi.fn<(url: string, ch: string) => Promise<{ ok: boolean; reason?: string }>>(
    async () => ({ ok: true }),
  ),
};

beforeAll(async () => {
  for (const [k, v] of Object.entries(REQUIRED_ENV)) process.env[k] = v;
  __resetEnvCacheForTests();
  __resetLoggerForTests();
  __resetKmsClientForTests();
  setVerifierClientForTests(verifier);
  signingKey = await importPKCS8(PRIVATE_PKCS8, "RS256");
  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  setVerifierClientForTests(null);
});

beforeEach(() => {
  idem.store.clear();
  verifier.verify.mockResolvedValue({ ok: true });
  subRepo.insertSubscription.mockImplementation(async (input: any) => ({
    id: uuidv7(),
    appId: input.appId,
    tenantId: input.tenantId,
    url: input.url,
    eventTypesFilter: input.eventTypesFilter,
    status: "active",
    secretCiphertext: input.secretCiphertext,
    secretDekCiphertext: input.secretDekCiphertext,
    secretDekKeyId: input.secretDekKeyId,
    secretEncryptionContext: input.secretEncryptionContext,
    secretAlgo: input.secretAlgo,
    secretNonce: input.secretNonce,
    secretAuthTag: input.secretAuthTag,
    createdAt: new Date(),
  }));
  subRepo.listSubscriptionsByApp.mockResolvedValue([]);
  subRepo.setSubscriptionStatus.mockResolvedValue(null);
  subRepo.listDeadLetterDeliveries.mockResolvedValue([]);
  subRepo.resetDeliveryForReplay.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("POST /v1/webhooks/subscriptions", () => {
  it("happy path: verifica URL + cria + retorna signing_secret uma vez", async () => {
    const t = await token("webhooks:write");
    const res = await app.inject({
      method: "POST",
      url: "/v1/webhooks/subscriptions",
      headers: { authorization: `Bearer ${t}`, "idempotency-key": "sub-1" },
      payload: {
        delivery_mode: "push",
        url: "https://app.example.com/in",
        event_types_filter: ["message.received"],
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.delivery_mode).toBe("push");
    expect(body.url).toBe("https://app.example.com/in");
    expect(body.signing_secret).toMatch(/^[A-Za-z0-9+/=]{40,}$/);

    expect(verifier.verify).toHaveBeenCalledWith(
      "https://app.example.com/in",
      expect.stringMatching(/^[0-9a-f]{32}$/),
    );
    expect(subRepo.insertSubscription).toHaveBeenCalledTimes(1);
  });

  it("rejeita URL http:// → 400", async () => {
    const t = await token("webhooks:write");
    const res = await app.inject({
      method: "POST",
      url: "/v1/webhooks/subscriptions",
      headers: { authorization: `Bearer ${t}`, "idempotency-key": "sub-2" },
      payload: { delivery_mode: "push", url: "http://app.example.com/in" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("verificação falha → 400 INVALID_INPUT", async () => {
    verifier.verify.mockResolvedValueOnce({ ok: false, reason: "challenge mismatch" });
    const t = await token("webhooks:write");
    const res = await app.inject({
      method: "POST",
      url: "/v1/webhooks/subscriptions",
      headers: { authorization: `Bearer ${t}`, "idempotency-key": "sub-3" },
      payload: { delivery_mode: "push", url: "https://app.example.com/in" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details.reason).toContain("challenge mismatch");
    expect(subRepo.insertSubscription).not.toHaveBeenCalled();
  });

  it("rejeita scope errado → 403", async () => {
    const t = await token("webhooks:read");
    const res = await app.inject({
      method: "POST",
      url: "/v1/webhooks/subscriptions",
      headers: { authorization: `Bearer ${t}`, "idempotency-key": "sub-4" },
      payload: { delivery_mode: "push", url: "https://x.com" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("delivery_mode != push → 400 (V1 só push)", async () => {
    const t = await token("webhooks:write");
    const res = await app.inject({
      method: "POST",
      url: "/v1/webhooks/subscriptions",
      headers: { authorization: `Bearer ${t}`, "idempotency-key": "sub-5" },
      payload: { delivery_mode: "sse", url: "https://x.com" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /v1/webhooks/subscriptions", () => {
  it("lista subscriptions do app", async () => {
    subRepo.listSubscriptionsByApp.mockResolvedValueOnce([
      {
        id: uuidv7(),
        appId: APP_ID,
        tenantId: null,
        url: "https://x",
        eventTypesFilter: [],
        status: "active",
        secretCiphertext: Buffer.from(""),
        secretDekCiphertext: Buffer.from(""),
        secretDekKeyId: "",
        secretEncryptionContext: {},
        secretAlgo: "",
        secretNonce: Buffer.from(""),
        secretAuthTag: Buffer.from(""),
        createdAt: new Date(),
      },
    ]);
    const t = await token("webhooks:read");
    const res = await app.inject({
      method: "GET",
      url: "/v1/webhooks/subscriptions",
      headers: { authorization: `Bearer ${t}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(1);
    // signing_secret NUNCA aparece em list.
    expect(JSON.stringify(res.json())).not.toContain("signing_secret");
  });
});

describe("DELETE /v1/webhooks/subscriptions/:id", () => {
  it("desabilita subscription ativa", async () => {
    const subId = uuidv7();
    subRepo.findSubscriptionScoped.mockResolvedValueOnce({
      id: subId,
      appId: APP_ID,
      tenantId: null,
      url: "https://x",
      eventTypesFilter: [],
      status: "active",
      createdAt: new Date(),
    });
    subRepo.setSubscriptionStatus.mockResolvedValueOnce({
      id: subId,
      appId: APP_ID,
      tenantId: null,
      url: "https://x",
      eventTypesFilter: [],
      status: "disabled",
      createdAt: new Date(),
    });
    const t = await token("webhooks:write");
    const res = await app.inject({
      method: "DELETE",
      url: `/v1/webhooks/subscriptions/${subId}`,
      headers: { authorization: `Bearer ${t}`, "idempotency-key": "del-1" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("disabled");
  });

  it("já disabled → 409", async () => {
    subRepo.findSubscriptionScoped.mockResolvedValueOnce({
      id: "x",
      appId: APP_ID,
      tenantId: null,
      url: "https://x",
      eventTypesFilter: [],
      status: "disabled",
      createdAt: new Date(),
    });
    const t = await token("webhooks:write");
    const res = await app.inject({
      method: "DELETE",
      url: `/v1/webhooks/subscriptions/${uuidv7()}`,
      headers: { authorization: `Bearer ${t}`, "idempotency-key": "del-2" },
    });
    expect(res.statusCode).toBe(409);
  });
});

describe("POST /admin/subscriptions/:id/replay", () => {
  it("admin replay enfileira jobs para cada dead_letter", async () => {
    subRepo.listDeadLetterDeliveries.mockResolvedValueOnce([
      { id: "del-1", inboundEventId: "evt-1" },
      { id: "del-2", inboundEventId: "evt-2" },
    ]);
    const subId = uuidv7();
    const t = await adminToken();
    const res = await app.inject({
      method: "POST",
      url: `/admin/subscriptions/${subId}/replay`,
      headers: { authorization: `Bearer ${t}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ subscription_id: subId, replayed: 2 });
    expect(subRepo.resetDeliveryForReplay).toHaveBeenCalledTimes(2);
    expect(queueAdd.fn).toHaveBeenCalledTimes(2);
  });

  it("rejeita sem admin auth → 401", async () => {
    const subId = uuidv7();
    const res = await app.inject({
      method: "POST",
      url: `/admin/subscriptions/${subId}/replay`,
    });
    expect(res.statusCode).toBe(401);
  });

  it("consumer JWT (não admin) → 401", async () => {
    const t = await token("webhooks:write");
    const subId = uuidv7();
    const res = await app.inject({
      method: "POST",
      url: `/admin/subscriptions/${subId}/replay`,
      headers: { authorization: `Bearer ${t}` },
    });
    expect(res.statusCode).toBe(401);
  });
});
