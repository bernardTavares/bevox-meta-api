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
  LOG_LEVEL: "fatal",
  DATABASE_URL: "postgresql://bevox:pwd@localhost:5432/test",
  REDIS_URL: "redis://localhost:6379",
  KMS_PROVIDER: "local",
  KMS_KEY_ID: "test-key",
  KMS_LOCAL_MASTER_KEY: Buffer.alloc(32, 0x42).toString("base64"),
  ADMIN_API_KEY: "test-admin-key-1234",
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
  closeRedis: async () => {
    // no-op
  },
  createBullMQConnection: () => ({
    quit: async () => "OK",
  }),
}));

const queueAdd = vi.hoisted(() => ({
  fn: vi.fn(async (_name: string, _payload: unknown, _opts?: unknown) => undefined),
}));

vi.mock("@/lib/queues.js", () => ({
  OUTBOUND_QUEUE: "outbound-meta",
  WEBHOOK_DELIVERY_QUEUE: "webhook-delivery",
  DEFAULT_JOB_OPTIONS: {},
  getOutboundQueue: () => ({ add: queueAdd.fn }),
  getWebhookDeliveryQueue: () => ({ add: queueAdd.fn }),
  closeQueues: async () => {
    // no-op
  },
  __resetQueuesForTests: () => {},
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
  findTenantById: vi.fn(async (appId: string, id: string) =>
    appId === APP_ID && id === TENANT_ID
      ? {
          id: TENANT_ID,
          appId: APP_ID,
          externalId: null,
          displayName: "T",
          metadataJson: {},
          status: "active",
          createdAt: new Date(),
          updatedAt: new Date(),
          deletedAt: null,
        }
      : null,
  ),
  insertTenant: vi.fn(),
  findTenantByExternalId: vi.fn(),
  listTenants: vi.fn(),
  updateTenant: vi.fn(),
  softDeleteTenant: vi.fn(),
  countActiveBindings: vi.fn(),
}));

vi.mock("@/modules/wabas/repository.js", () => ({
  listWabasByTenant: vi.fn(),
  findWabaConnectionById: vi.fn(),
  disconnectWaba: vi.fn(),
  createWabaConnectionWithToken: vi.fn(),
  findWabaByTenantAndMetaId: vi.fn(),
  reconnectWaba: vi.fn(),
}));
vi.mock("@/modules/wabas/token-resolver.js", () => ({
  resolveActiveWabaToken: vi.fn(),
}));
vi.mock("@/modules/phone-numbers/repository.js", () => ({
  upsertPhoneNumbers: vi.fn(),
  listPhoneNumbersByWaba: vi.fn(),
  findPhoneByMetaId: vi.fn(),
}));
vi.mock("@/modules/ig/repository.js", () => ({
  listIgsByTenant: vi.fn(),
  findIgConnectionById: vi.fn(),
  createIgConnectionWithToken: vi.fn(),
  findIgByTenantAndMetaId: vi.fn(),
  reconnectIg: vi.fn(),
  disconnectIg: vi.fn(),
}));

const msgRepo = vi.hoisted(() => ({
  insertOutboundJob: vi.fn(),
  insertQueuedJob: vi.fn(),
  findOutboundJob: vi.fn(),
  updateJobStatus: vi.fn(),
  incrementAttempts: vi.fn(),
}));
vi.mock("@/modules/messages/repository.js", () => msgRepo);

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
  idem.store.clear();
  msgRepo.insertQueuedJob.mockImplementation(async (input: any) => ({
    id: uuidv7(),
    ...input,
    attempts: 0,
    status: "queued",
    providerMessageId: null,
    lastError: null,
    createdAt: new Date(),
    completedAt: null,
  }));
  msgRepo.findOutboundJob.mockResolvedValue(null);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("POST /v1/messages/async", () => {
  it("enfileira job e retorna 202 com job_id+status=queued", async () => {
    const t = await token("messages:write");
    const res = await app.inject({
      method: "POST",
      url: "/v1/messages/async",
      headers: {
        authorization: `Bearer ${t}`,
        "x-tenant-id": TENANT_ID,
        "idempotency-key": "async-1",
      },
      payload: {
        channel: "whatsapp",
        to: "5511",
        type: "text",
        content: { body: "Olá!" },
        callback_url: "https://app.example.com/cb",
        callback_secret: "secret-1234",
      },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.status).toBe("queued");
    expect(body.job_id).toMatch(/^[0-9a-f-]{36}$/);

    expect(msgRepo.insertQueuedJob).toHaveBeenCalledTimes(1);
    expect(queueAdd.fn).toHaveBeenCalledTimes(1);
    const [jobName, payload, opts] = queueAdd.fn.mock.calls[0]!;
    expect(jobName).toBe("send");
    expect(payload).toMatchObject({
      app_id: APP_ID,
      tenant_id: TENANT_ID,
      channel: "whatsapp",
      callback_url: "https://app.example.com/cb",
    });
    expect(opts).toEqual({ jobId: body.job_id });
  });

  it("payload persistido na DB tem PII redacted", async () => {
    const t = await token("messages:write");
    await app.inject({
      method: "POST",
      url: "/v1/messages/async",
      headers: {
        authorization: `Bearer ${t}`,
        "x-tenant-id": TENANT_ID,
        "idempotency-key": "async-2",
      },
      payload: {
        channel: "whatsapp",
        to: "5511",
        type: "text",
        content: { body: "secreto" },
      },
    });
    const insertArgs = msgRepo.insertQueuedJob.mock.calls[0]![0];
    expect(JSON.stringify(insertArgs.payloadJson)).not.toContain("secreto");
  });

  // Fix A3 (audit 2026-06-02): valida que o payload enfileirado em BullMQ
  // (e portanto persistido em Redis) NÃO contém PII (número, conteúdo) nem
  // o callback_secret em plaintext. Tudo isso vai dentro do bloco sealed
  // (envelope AES-256-GCM); o worker decifra no consumo.
  it("BullMQ job payload (Redis at-rest) NÃO contém PII nem callback_secret em plaintext (A3 fix)", async () => {
    const t = await token("messages:write");
    const SECRET_BODY = "ULTRA-PRIVATE-MESSAGE-CONTENT";
    const PHONE_TO = "5511987654321";
    const CALLBACK_SECRET = "ULTRA-PRIVATE-HMAC-SECRET";
    const res = await app.inject({
      method: "POST",
      url: "/v1/messages/async",
      headers: {
        authorization: `Bearer ${t}`,
        "x-tenant-id": TENANT_ID,
        "idempotency-key": "async-a3-seal",
      },
      payload: {
        channel: "whatsapp",
        to: PHONE_TO,
        type: "text",
        content: { body: SECRET_BODY },
        callback_url: "https://app.example.com/cb",
        callback_secret: CALLBACK_SECRET,
      },
    });
    expect(res.statusCode).toBe(202);
    expect(queueAdd.fn).toHaveBeenCalledTimes(1);
    const [, queuePayload] = queueAdd.fn.mock.calls[0]!;

    // Serialização exata (BullMQ usa JSON.stringify ao gravar em Redis).
    const serialized = JSON.stringify(queuePayload);
    expect(serialized).not.toContain(SECRET_BODY);
    expect(serialized).not.toContain(PHONE_TO);
    expect(serialized).not.toContain(CALLBACK_SECRET);

    // Shape esperado: sealed_secrets presente; request_body/callback_secret
    // (plaintext) ausentes da estrutura.
    const p = queuePayload as Record<string, unknown>;
    expect(p).toHaveProperty("sealed_secrets");
    expect(p).not.toHaveProperty("request_body");
    expect(p).not.toHaveProperty("callback_secret");

    // sealed_secrets carrega ciphertext + AAD com binding ao job.
    const sealed = p.sealed_secrets as Record<string, unknown>;
    expect(typeof sealed.ciphertext_b64).toBe("string");
    expect(typeof sealed.dek_ciphertext_b64).toBe("string");
    expect(typeof sealed.nonce_b64).toBe("string");
    expect(typeof sealed.auth_tag_b64).toBe("string");
    expect(sealed.algo).toBe("AES-256-GCM-v1");

    const ctx = sealed.encryption_context as Record<string, string>;
    expect(ctx.kind).toBe("outbound-job-v1");
    expect(ctx.app_id).toBe(APP_ID);
    expect(ctx.tenant_id).toBe(TENANT_ID);
    expect(ctx.job_id).toBe((res.json() as { job_id: string }).job_id);

    // callback_url permanece plaintext (não é segredo, ops debug).
    expect(p.callback_url).toBe("https://app.example.com/cb");
  });

  it("rejeita scope errado", async () => {
    const t = await token("templates:read");
    const res = await app.inject({
      method: "POST",
      url: "/v1/messages/async",
      headers: {
        authorization: `Bearer ${t}`,
        "x-tenant-id": TENANT_ID,
        "idempotency-key": "async-3",
      },
      payload: { channel: "whatsapp", to: "x", type: "text", content: { body: "x" } },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("GET /v1/jobs/:job_id", () => {
  it("retorna status do job existente", async () => {
    const jobId = uuidv7();
    msgRepo.findOutboundJob.mockResolvedValueOnce({
      id: jobId,
      tenantId: TENANT_ID,
      appId: APP_ID,
      idempotencyKey: "k",
      channel: "whatsapp",
      payloadJson: {},
      status: "sent",
      attempts: 1,
      providerMessageId: "wamid.x",
      lastError: null,
      createdAt: new Date("2024-01-01"),
      completedAt: new Date("2024-01-01T00:00:01Z"),
    });
    const t = await token("messages:write");
    const res = await app.inject({
      method: "GET",
      url: `/v1/jobs/${jobId}`,
      headers: { authorization: `Bearer ${t}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("sent");
    expect(body.provider_message_id).toBe("wamid.x");
    expect(body.attempts).toBe(1);
  });

  it("job inexistente → 404", async () => {
    msgRepo.findOutboundJob.mockResolvedValueOnce(null);
    const t = await token("messages:write");
    const res = await app.inject({
      method: "GET",
      url: `/v1/jobs/${uuidv7()}`,
      headers: { authorization: `Bearer ${t}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it("job de outro app é tratado como 404 (scoped por app_id)", async () => {
    msgRepo.findOutboundJob.mockResolvedValueOnce(null);
    const t = await token("messages:write");
    const res = await app.inject({
      method: "GET",
      url: `/v1/jobs/${uuidv7()}`,
      headers: { authorization: `Bearer ${t}` },
    });
    expect(res.statusCode).toBe(404);
    // findOutboundJob foi chamado com APP_ID — cabeça do scoped check.
    expect(msgRepo.findOutboundJob).toHaveBeenCalledWith(APP_ID, expect.any(String));
  });
});

// ---------------------------------------------------------------------------
// A11 — GET /v1/messages/:message_id
// ---------------------------------------------------------------------------

describe("GET /v1/messages/:message_id (A11)", () => {
  it("retorna 200 com MessageDetailResponse para mensagem existente (status=sent)", async () => {
    const messageId = uuidv7();
    const sentAt = new Date("2026-06-02T10:00:00Z");
    msgRepo.findOutboundJob.mockResolvedValueOnce({
      id: messageId,
      tenantId: TENANT_ID,
      appId: APP_ID,
      idempotencyKey: "k-a11",
      channel: "whatsapp",
      payloadJson: {},
      status: "sent",
      attempts: 1,
      providerMessageId: "wamid.a11",
      lastError: null,
      createdAt: new Date("2026-06-02T09:59:00Z"),
      completedAt: sentAt,
    });
    const t = await token("messages:write");
    const res = await app.inject({
      method: "GET",
      url: `/v1/messages/${messageId}`,
      headers: { authorization: `Bearer ${t}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual({
      message_id: messageId,
      provider_message_id: "wamid.a11",
      status: "sent",
      error: null,
      sent_at: sentAt.toISOString(),
    });
  });

  it("status=failed expõe error object e status=failed", async () => {
    const messageId = uuidv7();
    msgRepo.findOutboundJob.mockResolvedValueOnce({
      id: messageId,
      tenantId: TENANT_ID,
      appId: APP_ID,
      idempotencyKey: "k-fail",
      channel: "whatsapp",
      payloadJson: {},
      status: "failed",
      attempts: 3,
      providerMessageId: null,
      lastError: "Meta rejected: 131000",
      createdAt: new Date("2026-06-02T09:00:00Z"),
      completedAt: new Date("2026-06-02T09:00:05Z"),
    });
    const t = await token("messages:write");
    const res = await app.inject({
      method: "GET",
      url: `/v1/messages/${messageId}`,
      headers: { authorization: `Bearer ${t}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("failed");
    expect(body.error).toEqual({ code: "META_REJECTED", message: "Meta rejected: 131000" });
    expect(body.provider_message_id).toBeNull();
  });

  it("status interno `sending` é mapeado para `queued` no contrato público", async () => {
    const messageId = uuidv7();
    msgRepo.findOutboundJob.mockResolvedValueOnce({
      id: messageId,
      tenantId: TENANT_ID,
      appId: APP_ID,
      idempotencyKey: "k-sending",
      channel: "whatsapp",
      payloadJson: {},
      status: "sending",
      attempts: 1,
      providerMessageId: null,
      lastError: null,
      createdAt: new Date("2026-06-02T09:00:00Z"),
      completedAt: null,
    });
    const t = await token("messages:write");
    const res = await app.inject({
      method: "GET",
      url: `/v1/messages/${messageId}`,
      headers: { authorization: `Bearer ${t}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("queued");
    expect(res.json().sent_at).toBeNull();
  });

  it("status interno `expired` é mapeado para `failed` no contrato público", async () => {
    const messageId = uuidv7();
    msgRepo.findOutboundJob.mockResolvedValueOnce({
      id: messageId,
      tenantId: TENANT_ID,
      appId: APP_ID,
      idempotencyKey: "k-expired",
      channel: "whatsapp",
      payloadJson: {},
      status: "expired",
      attempts: 5,
      providerMessageId: null,
      lastError: "exhausted retries",
      createdAt: new Date("2026-06-02T08:00:00Z"),
      completedAt: new Date("2026-06-02T08:30:00Z"),
    });
    const t = await token("messages:write");
    const res = await app.inject({
      method: "GET",
      url: `/v1/messages/${messageId}`,
      headers: { authorization: `Bearer ${t}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("failed");
  });

  it("mensagem inexistente → 404 NOT_FOUND", async () => {
    msgRepo.findOutboundJob.mockResolvedValueOnce(null);
    const t = await token("messages:write");
    const res = await app.inject({
      method: "GET",
      url: `/v1/messages/${uuidv7()}`,
      headers: { authorization: `Bearer ${t}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
  });

  it("mensagem de outro app → 404 (scoped por app_id no repository, defesa contra IDOR)", async () => {
    // O mock vai sempre retornar null porque findOutboundJob filtra por
    // app_id; aqui validamos que a route invoca findOutboundJob com o
    // app_id do JWT (não o id passado pelo cliente).
    msgRepo.findOutboundJob.mockResolvedValueOnce(null);
    const otherAppMessageId = uuidv7();
    const t = await token("messages:write");
    const res = await app.inject({
      method: "GET",
      url: `/v1/messages/${otherAppMessageId}`,
      headers: { authorization: `Bearer ${t}` },
    });
    expect(res.statusCode).toBe(404);
    expect(msgRepo.findOutboundJob).toHaveBeenCalledWith(APP_ID, otherAppMessageId);
  });

  it("UUID inválido no path → 400 (zod validation)", async () => {
    const t = await token("messages:write");
    const res = await app.inject({
      method: "GET",
      url: `/v1/messages/not-a-uuid`,
      headers: { authorization: `Bearer ${t}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejeita sem scope messages:write", async () => {
    const t = await token("templates:read");
    const res = await app.inject({
      method: "GET",
      url: `/v1/messages/${uuidv7()}`,
      headers: { authorization: `Bearer ${t}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("rejeita sem Authorization → 401", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/v1/messages/${uuidv7()}`,
    });
    expect(res.statusCode).toBe(401);
  });
});
