/**
 * Unit tests — processOutboundJob (src/workers/outbound-dispatcher.ts).
 *
 * Cobertura: happy path (sent + callback HMAC), erros retryable
 * (META_UNAVAILABLE / RATE_LIMITED → queued + re-throw), terminais
 * (META_REJECTED / INTERNAL / INVALID_INPUT → failed + callback sem
 * re-throw), best-effort de callback (timeout/network/non-2xx engolidos),
 * e callback opcional sem secret.
 *
 * Espelha o padrão de tests/unit/workers/webhook-delivery.test.ts:
 *   - mocks via vi.hoisted (undici, repository, service)
 *   - REQUIRED_ENV no beforeAll
 *   - import dinâmico do worker depois do mock
 */

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

// undici.request mocked p/ inspecionar o POST do callback.
const undiciState = vi.hoisted(() => ({
  request: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));
vi.mock("undici", () => ({
  request: (url: unknown, opts: unknown) => undiciState.request(url, opts),
}));

// Repository: incrementAttempts + updateJobStatus.
const msgRepo = vi.hoisted(() => ({
  incrementAttempts: vi.fn<(jobId: string) => Promise<void>>(async () => {}),
  updateJobStatus: vi.fn<(jobId: string, patch: unknown) => Promise<unknown>>(async () => null),
}));
vi.mock("@/modules/messages/repository.js", () => msgRepo);

// Service: sendMessage retorna SendMessageResponse ou lança AppError.
const msgService = vi.hoisted(() => ({
  sendMessage: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));
vi.mock("@/modules/messages/service.js", () => msgService);

// Redis e env — mockados para evitar conexão real.
vi.mock("@/lib/redis.js", () => ({
  getRedis: () => ({ ping: async () => "PONG", quit: async () => "OK" }),
  closeRedis: async () => {},
  createBullMQConnection: () => ({ quit: async () => "OK" }),
}));

// NOTE (A3 fix): NÃO mockamos @/config/env.js — `unsealOutboundJobSecrets`
// (chamado pelo worker) lê KMS_KEY_ID + KMS_LOCAL_MASTER_KEY via env() para
// decifrar o sealed_secrets do payload. Carregamos process.env real com o
// REQUIRED_ENV (cobertura igual a tests/unit/lib/job-seal.test.ts).
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = REQUIRED_ENV.LOG_LEVEL!;
process.env.DATABASE_URL = REQUIRED_ENV.DATABASE_URL!;
process.env.REDIS_URL = REQUIRED_ENV.REDIS_URL!;
process.env.KMS_PROVIDER = REQUIRED_ENV.KMS_PROVIDER!;
process.env.KMS_KEY_ID = REQUIRED_ENV.KMS_KEY_ID!;
process.env.KMS_LOCAL_MASTER_KEY = REQUIRED_ENV.KMS_LOCAL_MASTER_KEY!;
process.env.ADMIN_API_KEY = REQUIRED_ENV.ADMIN_API_KEY!;

const { __resetLoggerForTests } = await import("@/lib/logger.js");
const { __resetEnvCacheForTests } = await import("@/config/env.js");
const { __resetKmsClientForTests } = await import("@/integration/kms-client.js");
const { sealOutboundJobSecrets } = await import("@/lib/job-seal.js");
const { processOutboundJob } = await import("@/workers/outbound-dispatcher.js");
const { AppError } = await import("@/lib/errors.js");
const { uuidv7 } = await import("@/lib/uuid.js");
const { createHmac: nodeCreateHmac } = await import("node:crypto");

beforeAll(() => {
  for (const [k, v] of Object.entries(REQUIRED_ENV)) process.env[k] = v;
  __resetEnvCacheForTests();
  __resetLoggerForTests();
  __resetKmsClientForTests();
});

const APP_ID = "00000000-0000-7000-8000-000000000001";
const TENANT_ID = "00000000-0000-7000-8000-000000000002";

interface JobOverrides {
  job_id?: string;
  callback_url?: string;
  callback_secret?: string;
  channel?: "whatsapp" | "instagram";
  request_body?: Record<string, unknown>;
}

const DEFAULT_REQUEST_BODY: Record<string, unknown> = {
  to: "5511999999999",
  type: "text",
  text: { body: "hello" },
};

/**
 * Constrói o payload BullMQ pós-A3 (sealed_secrets envelope), espelhando o
 * formato emitido por `enqueueMessage` em src/modules/messages/service.ts.
 * Async para usar o seal real (KMS local).
 */
async function makePayload(overrides: JobOverrides = {}) {
  const jobId = overrides.job_id ?? uuidv7();
  const requestBody = overrides.request_body ?? DEFAULT_REQUEST_BODY;
  const sealed = await sealOutboundJobSecrets({
    appId: APP_ID,
    tenantId: TENANT_ID,
    jobId,
    secrets: {
      request_body: requestBody,
      ...(overrides.callback_secret !== undefined
        ? { callback_secret: overrides.callback_secret }
        : {}),
    },
  });
  return {
    job_id: jobId,
    app_id: APP_ID,
    tenant_id: TENANT_ID,
    idempotency_key: "idem-key-1",
    channel: overrides.channel ?? ("whatsapp" as const),
    sealed_secrets: sealed,
    callback_url: overrides.callback_url,
    // Mantemos request_body em escopo de teste para asserções de igualdade
    // com `sendMessage` mock — NÃO faz parte do payload BullMQ.
    _testRequestBody: requestBody,
  };
}

beforeEach(() => {
  undiciState.request.mockReset();
  msgRepo.incrementAttempts.mockClear();
  msgRepo.updateJobStatus.mockClear();
  msgService.sendMessage.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

afterAll(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("processOutboundJob — happy path", () => {
  it("sendMessage OK → updateJobStatus(sending → sent) + callback com HMAC-SHA256", async () => {
    const payload = await makePayload({
      callback_url: "https://app.example.com/cb",
      callback_secret: "shared-secret-123",
    });
    msgService.sendMessage.mockResolvedValueOnce({
      message_id: "msg-1",
      provider_message_id: "wamid.AAA",
      channel: "whatsapp",
      status: "sent",
    });
    undiciState.request.mockResolvedValueOnce({
      statusCode: 200,
      body: { dump: async () => undefined },
    });

    await processOutboundJob(payload);

    // Ordem de chamadas: incrementAttempts, updateJobStatus(sending), sendMessage, updateJobStatus(sent), callback.
    expect(msgRepo.incrementAttempts).toHaveBeenCalledTimes(1);
    expect(msgRepo.incrementAttempts).toHaveBeenCalledWith(payload.job_id);

    expect(msgRepo.updateJobStatus).toHaveBeenCalledTimes(2);
    expect(msgRepo.updateJobStatus).toHaveBeenNthCalledWith(1, payload.job_id, {
      status: "sending",
    });
    expect(msgRepo.updateJobStatus).toHaveBeenNthCalledWith(
      2,
      payload.job_id,
      expect.objectContaining({
        status: "sent",
        providerMessageId: "wamid.AAA",
        lastError: null,
        completedAt: expect.any(Date),
      }),
    );

    expect(msgService.sendMessage).toHaveBeenCalledTimes(1);
    expect(msgService.sendMessage).toHaveBeenCalledWith({
      appId: APP_ID,
      tenantId: TENANT_ID,
      idempotencyKey: `async:${payload.job_id}`,
      body: payload._testRequestBody,
    });

    // Callback enviado com body JSON canônico + HMAC.
    expect(undiciState.request).toHaveBeenCalledTimes(1);
    const [url, opts] = undiciState.request.mock.calls[0]! as [string, any];
    expect(url).toBe("https://app.example.com/cb");
    expect(opts.method).toBe("POST");
    expect(opts.headers["content-type"]).toBe("application/json");

    const body = JSON.parse(opts.body);
    expect(body).toEqual({
      job_id: payload.job_id,
      status: "sent",
      channel: "whatsapp",
      provider_message_id: "wamid.AAA",
      error: null,
    });

    // Assinatura: sha256=<hex(HMAC(secret, JSON.stringify(payload)))>.
    const expected = nodeCreateHmac("sha256", "shared-secret-123").update(opts.body).digest("hex");
    expect(opts.headers["x-bevox-signature-256"]).toBe(`sha256=${expected}`);
  });

  it("sem callback_url → não chama undici.request", async () => {
    const payload = await makePayload();
    msgService.sendMessage.mockResolvedValueOnce({
      message_id: "msg-1",
      provider_message_id: "wamid.BBB",
      channel: "whatsapp",
      status: "sent",
    });

    await processOutboundJob(payload);

    expect(undiciState.request).not.toHaveBeenCalled();
    expect(msgRepo.updateJobStatus).toHaveBeenLastCalledWith(
      payload.job_id,
      expect.objectContaining({ status: "sent" }),
    );
  });

  it("callback_url sem secret → POST sem x-bevox-signature-256", async () => {
    const payload = await makePayload({ callback_url: "https://app.example.com/cb" });
    msgService.sendMessage.mockResolvedValueOnce({
      message_id: "msg-1",
      provider_message_id: "wamid.CCC",
      channel: "whatsapp",
      status: "sent",
    });
    undiciState.request.mockResolvedValueOnce({
      statusCode: 200,
      body: { dump: async () => undefined },
    });

    await processOutboundJob(payload);

    expect(undiciState.request).toHaveBeenCalledTimes(1);
    const [, opts] = undiciState.request.mock.calls[0]! as [string, any];
    expect(opts.headers["content-type"]).toBe("application/json");
    expect(opts.headers["x-bevox-signature-256"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Erros retryable → queued + re-throw
// ---------------------------------------------------------------------------

describe("processOutboundJob — erros retryable", () => {
  it("META_UNAVAILABLE → updateJobStatus(queued, completedAt=null) + re-throw + sem callback", async () => {
    const payload = await makePayload({
      callback_url: "https://app.example.com/cb",
      callback_secret: "secret",
    });
    msgService.sendMessage.mockRejectedValueOnce(
      new AppError({ code: "META_UNAVAILABLE", message: "upstream 502" }),
    );

    await expect(processOutboundJob(payload)).rejects.toMatchObject({
      code: "META_UNAVAILABLE",
    });

    // updateJobStatus chamado 2x: sending, depois queued.
    expect(msgRepo.updateJobStatus).toHaveBeenCalledTimes(2);
    expect(msgRepo.updateJobStatus).toHaveBeenNthCalledWith(1, payload.job_id, {
      status: "sending",
    });
    expect(msgRepo.updateJobStatus).toHaveBeenNthCalledWith(2, payload.job_id, {
      status: "queued",
      lastError: "META_UNAVAILABLE: upstream 502",
      completedAt: null,
    });

    // Callback NÃO disparado em retryable (BullMQ vai retentar).
    expect(undiciState.request).not.toHaveBeenCalled();
  });

  it("RATE_LIMITED → queued + re-throw + sem callback", async () => {
    const payload = await makePayload({ callback_url: "https://app.example.com/cb" });
    msgService.sendMessage.mockRejectedValueOnce(
      new AppError({ code: "RATE_LIMITED", message: "slow down" }),
    );

    await expect(processOutboundJob(payload)).rejects.toMatchObject({ code: "RATE_LIMITED" });

    expect(msgRepo.updateJobStatus).toHaveBeenNthCalledWith(2, payload.job_id, {
      status: "queued",
      lastError: "RATE_LIMITED: slow down",
      completedAt: null,
    });
    expect(undiciState.request).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Erros terminais → failed + callback (sem re-throw)
// ---------------------------------------------------------------------------

describe("processOutboundJob — erros terminais", () => {
  it("META_REJECTED → failed + callback com error.code/message + sem re-throw", async () => {
    const payload = await makePayload({
      callback_url: "https://app.example.com/cb",
      callback_secret: "shared-secret-xyz",
    });
    msgService.sendMessage.mockRejectedValueOnce(
      new AppError({ code: "META_REJECTED", message: "invalid template" }),
    );
    undiciState.request.mockResolvedValueOnce({
      statusCode: 200,
      body: { dump: async () => undefined },
    });

    await expect(processOutboundJob(payload)).resolves.toBeUndefined();

    expect(msgRepo.updateJobStatus).toHaveBeenNthCalledWith(
      2,
      payload.job_id,
      expect.objectContaining({
        status: "failed",
        lastError: "META_REJECTED: invalid template",
        completedAt: expect.any(Date),
      }),
    );
    const completedAtArg = (msgRepo.updateJobStatus.mock.calls[1]![1] as { completedAt: unknown })
      .completedAt;
    expect(completedAtArg).toBeInstanceOf(Date);

    // Callback recebe payload de falha com error code+message.
    expect(undiciState.request).toHaveBeenCalledTimes(1);
    const [, opts] = undiciState.request.mock.calls[0]! as [string, any];
    const body = JSON.parse(opts.body);
    expect(body).toEqual({
      job_id: payload.job_id,
      status: "failed",
      channel: "whatsapp",
      provider_message_id: null,
      error: { code: "META_REJECTED", message: "invalid template" },
    });
    // HMAC presente.
    const expected = nodeCreateHmac("sha256", "shared-secret-xyz").update(opts.body).digest("hex");
    expect(opts.headers["x-bevox-signature-256"]).toBe(`sha256=${expected}`);
  });

  it("Erro genérico (Error puro) → code=INTERNAL, failed + callback + sem re-throw", async () => {
    const payload = await makePayload({ callback_url: "https://app.example.com/cb" });
    msgService.sendMessage.mockRejectedValueOnce(new Error("kaboom"));
    undiciState.request.mockResolvedValueOnce({
      statusCode: 200,
      body: { dump: async () => undefined },
    });

    await expect(processOutboundJob(payload)).resolves.toBeUndefined();

    expect(msgRepo.updateJobStatus).toHaveBeenNthCalledWith(
      2,
      payload.job_id,
      expect.objectContaining({
        status: "failed",
        lastError: "INTERNAL: kaboom",
        completedAt: expect.any(Date),
      }),
    );

    const [, opts] = undiciState.request.mock.calls[0]! as [string, any];
    expect(JSON.parse(opts.body)).toMatchObject({
      status: "failed",
      error: { code: "INTERNAL", message: "kaboom" },
    });
  });

  it("INVALID_INPUT → failed + callback + sem re-throw", async () => {
    const payload = await makePayload({ callback_url: "https://app.example.com/cb" });
    msgService.sendMessage.mockRejectedValueOnce(
      new AppError({ code: "INVALID_INPUT", message: "tenant not found" }),
    );
    undiciState.request.mockResolvedValueOnce({
      statusCode: 200,
      body: { dump: async () => undefined },
    });

    await expect(processOutboundJob(payload)).resolves.toBeUndefined();

    expect(msgRepo.updateJobStatus).toHaveBeenNthCalledWith(
      2,
      payload.job_id,
      expect.objectContaining({
        status: "failed",
        lastError: "INVALID_INPUT: tenant not found",
      }),
    );
    const [, opts] = undiciState.request.mock.calls[0]! as [string, any];
    expect(JSON.parse(opts.body)).toMatchObject({
      status: "failed",
      error: { code: "INVALID_INPUT", message: "tenant not found" },
    });
  });
});

// ---------------------------------------------------------------------------
// Callback delivery — best-effort
// ---------------------------------------------------------------------------

describe("processOutboundJob — callback best-effort", () => {
  it("callback retorna non-2xx (503) → log warn, job status preservado, sem throw", async () => {
    const payload = await makePayload({
      callback_url: "https://app.example.com/cb",
      callback_secret: "secret",
    });
    msgService.sendMessage.mockResolvedValueOnce({
      message_id: "msg-1",
      provider_message_id: "wamid.DDD",
      channel: "whatsapp",
      status: "sent",
    });
    undiciState.request.mockResolvedValueOnce({
      statusCode: 503,
      body: { dump: async () => undefined },
    });

    await expect(processOutboundJob(payload)).resolves.toBeUndefined();

    // Status "sent" persistido ANTES do callback non-2xx.
    expect(msgRepo.updateJobStatus).toHaveBeenLastCalledWith(
      payload.job_id,
      expect.objectContaining({ status: "sent", providerMessageId: "wamid.DDD" }),
    );
  });

  it("callback timeout/network (ECONNRESET) → engolido, sem throw, job status preservado", async () => {
    const payload = await makePayload({
      callback_url: "https://app.example.com/cb",
      callback_secret: "secret",
    });
    msgService.sendMessage.mockResolvedValueOnce({
      message_id: "msg-1",
      provider_message_id: "wamid.EEE",
      channel: "whatsapp",
      status: "sent",
    });
    undiciState.request.mockRejectedValueOnce(new Error("ECONNRESET"));

    await expect(processOutboundJob(payload)).resolves.toBeUndefined();

    expect(msgRepo.updateJobStatus).toHaveBeenLastCalledWith(
      payload.job_id,
      expect.objectContaining({ status: "sent", providerMessageId: "wamid.EEE" }),
    );
  });
});

// ---------------------------------------------------------------------------
// Ordem de operações
// ---------------------------------------------------------------------------

describe("processOutboundJob — ordem de operações", () => {
  it("incrementAttempts e updateJobStatus(sending) chamados ANTES de sendMessage", async () => {
    const payload = await makePayload();
    const order: string[] = [];
    msgRepo.incrementAttempts.mockImplementationOnce(async () => {
      order.push("increment");
    });
    msgRepo.updateJobStatus.mockImplementationOnce(async (_id, patch: any) => {
      order.push(`status:${patch.status}`);
      return null;
    });
    msgRepo.updateJobStatus.mockImplementationOnce(async (_id, patch: any) => {
      order.push(`status:${patch.status}`);
      return null;
    });
    msgService.sendMessage.mockImplementationOnce(async () => {
      order.push("send");
      return {
        message_id: "msg-1",
        provider_message_id: "wamid.FFF",
        channel: "whatsapp",
        status: "sent",
      };
    });

    await processOutboundJob(payload);

    expect(order).toEqual(["increment", "status:sending", "send", "status:sent"]);
  });
});
