/**
 * Unit tests para o pipeline de enqueue do inbound webhook (C3 fix —
 * alinhamento BullMQ × worker dead_letter, PRD §10.2).
 *
 * Quando processMetaWebhook persiste o InboundEvent e enfileira um job
 * webhook-delivery, ele DEVE explicitamente carregar:
 *   - attempts = WEBHOOK_DELIVERY_MAX_RETRIES (default 8)
 *   - backoff = { type: "bevox-prd-10-2" } (custom strategy do worker,
 *     PRD §10.2: [0s, 30s, 2min, 10min, 1h, 6h])
 *
 * Sem isso, o worker grava `failed` na N-ésima tentativa, BullMQ encerra
 * antes do branch terminal (`totalAttempts >= MAX_ATTEMPTS`), e o evento
 * jamais entra em `dead_letter` → `listDeadLetterDeliveries` retorna 0 →
 * replay admin não recupera nada.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type * as QueuesModule from "@/lib/queues.js";

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

const webhookQueueAdd = vi.hoisted(() => ({
  fn: vi.fn(async (_n: string, _p: unknown, _o?: unknown) => undefined),
}));
const mediaQueueAdd = vi.hoisted(() => ({
  fn: vi.fn(async (_n: string, _p: unknown, _o?: unknown) => undefined),
}));
vi.mock("@/lib/queues.js", async () => {
  const actual = await vi.importActual<typeof QueuesModule>("@/lib/queues.js");
  return {
    ...actual,
    getOutboundQueue: () => ({ add: webhookQueueAdd.fn }),
    getWebhookDeliveryQueue: () => ({ add: webhookQueueAdd.fn }),
    getMediaDownloadQueue: () => ({ add: mediaQueueAdd.fn }),
    closeQueues: async () => {},
    __resetQueuesForTests: () => {},
  };
});

vi.mock("@/lib/event-bus.js", () => ({
  publishEvent: vi.fn(async () => {}),
}));

const APP_ID = "00000000-0000-7000-8000-000000000001";
const TENANT_ID = "00000000-0000-7000-8000-000000000002";

vi.mock("@/modules/wabas/repository.js", () => ({
  findWabaByMetaWabaId: vi.fn(async (metaWabaId: string) =>
    metaWabaId === "WABA-1"
      ? {
          id: "00000000-0000-7000-8000-00000000000a",
          tenantId: TENANT_ID,
          appId: APP_ID,
          metaBusinessId: "biz",
          metaWabaId,
          displayName: "X",
          verifiedStatus: "VERIFIED",
          createdAt: new Date(),
          updatedAt: new Date(),
          disconnectedAt: null,
        }
      : null,
  ),
  disconnectWabaByMetaWabaId: wabaExtra.disconnectWabaByMetaWabaId,
}));

vi.mock("@/modules/ig/repository.js", () => ({
  findIgByMetaIgId: vi.fn(async () => null),
}));

const inboundRepo = vi.hoisted(() => ({
  insertInboundEvent: vi.fn(),
  listActiveSubscriptions: vi.fn(),
}));
const wabaExtra = vi.hoisted(() => ({ disconnectWabaByMetaWabaId: vi.fn() }));
vi.mock("@/modules/inbound/repository.js", () => inboundRepo);

const { __resetLoggerForTests } = await import("@/lib/logger.js");
const { __resetEnvCacheForTests } = await import("@/config/env.js");
const { processMetaWebhook } = await import("@/modules/inbound/service.js");
const queues = await import("@/lib/queues.js");

beforeAll(() => {
  for (const [k, v] of Object.entries(REQUIRED_ENV)) process.env[k] = v;
  __resetEnvCacheForTests();
  __resetLoggerForTests();
});

beforeEach(() => {
  webhookQueueAdd.fn.mockClear();
  mediaQueueAdd.fn.mockClear();
  inboundRepo.insertInboundEvent.mockImplementation(async (input: any) => ({
    id: "00000000-0000-7000-8000-0000000000ee",
    ...input,
    receivedAt: new Date("2024-01-01T00:00:00Z"),
    dispatchedAt: null,
  }));
  inboundRepo.listActiveSubscriptions.mockResolvedValue([
    {
      id: "00000000-0000-7000-8000-0000000000ff",
      appId: APP_ID,
      tenantId: TENANT_ID,
      url: "https://app.example.com/in",
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
  wabaExtra.disconnectWabaByMetaWabaId.mockResolvedValue({
    id: "00000000-0000-7000-8000-00000000000a",
    metaWabaId: "WABA-1",
    disconnectedAt: new Date(),
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

/**
 * PRD §10.2 backoff schedule, em milissegundos.
 *  0s, 30s, 2min, 10min, 1h, 6h
 */
const PRD_BACKOFF_MS = [0, 30_000, 120_000, 600_000, 3_600_000, 21_600_000];

function buildWaPayload(messageId: string = "wamid.c3.1") {
  return {
    object: "whatsapp_business_account" as const,
    entry: [
      {
        id: "WABA-1",
        changes: [
          {
            field: "messages",
            value: { messages: [{ id: messageId, type: "text" }] },
          },
        ],
      },
    ],
  };
}

describe("processMetaWebhook — enqueue contract (C3)", () => {
  it("enqueues webhook-delivery job with explicit attempts = WEBHOOK_DELIVERY_MAX_RETRIES (default 8)", async () => {
    await processMetaWebhook(buildWaPayload("wamid.c3.attempts") as never);

    expect(webhookQueueAdd.fn).toHaveBeenCalledTimes(1);
    const [, , opts] = webhookQueueAdd.fn.mock.calls[0]! as [string, unknown, any];
    expect(opts).toBeDefined();
    expect(opts.attempts).toBe(8);
  });

  it("enqueues webhook-delivery job referencing the PRD §10.2 backoff strategy", async () => {
    await processMetaWebhook(buildWaPayload("wamid.c3.backoff") as never);

    expect(webhookQueueAdd.fn).toHaveBeenCalledTimes(1);
    const [, , opts] = webhookQueueAdd.fn.mock.calls[0]! as [string, unknown, any];
    expect(opts.backoff).toBeDefined();
    // O job aponta para a strategy registrada nos settings do worker
    // webhook-delivery; o worker concretiza o delay via getWebhookBackoffDelay.
    expect(opts.backoff).toEqual({ type: queues.WEBHOOK_BACKOFF_STRATEGY });
  });

  it("preserva jobId determinístico (idempotência de enqueue)", async () => {
    await processMetaWebhook(buildWaPayload("wamid.c3.jobid") as never);

    const [, , opts] = webhookQueueAdd.fn.mock.calls[0]! as [string, unknown, any];
    expect(opts.jobId).toMatch(/.+:.+/);
  });
});

describe("getWebhookBackoffDelay — PRD §10.2 strategy", () => {
  it("retorna a sequência [0,30s,2min,10min,1h,6h] indexada por attemptsMade (1..6)", () => {
    // attemptsMade é 1-indexed: 1 = depois da 1ª falha, etc.
    for (let i = 0; i < PRD_BACKOFF_MS.length; i++) {
      const attemptsMade = i + 1;
      expect(queues.getWebhookBackoffDelay(attemptsMade)).toBe(PRD_BACKOFF_MS[i]);
    }
  });

  it("para attemptsMade além do array, repete o último valor (6h)", () => {
    expect(queues.getWebhookBackoffDelay(7)).toBe(PRD_BACKOFF_MS[PRD_BACKOFF_MS.length - 1]);
    expect(queues.getWebhookBackoffDelay(99)).toBe(PRD_BACKOFF_MS[PRD_BACKOFF_MS.length - 1]);
  });

  it("attemptsMade <= 0 → 0", () => {
    expect(queues.getWebhookBackoffDelay(0)).toBe(0);
    expect(queues.getWebhookBackoffDelay(-1)).toBe(0);
  });
});

describe("processMetaWebhook — COEX event types", () => {
  it("smb_message_echoes → whatsapp.message_echo + dedup pelo id do echo", async () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WABA-1",
          changes: [
            {
              field: "smb_message_echoes",
              value: {
                message_echoes: [{ id: "wamid.echo.1", from: "1555", to: "1650", type: "text" }],
              },
            },
          ],
        },
      ],
    };
    await processMetaWebhook(payload as never);
    const insert = inboundRepo.insertInboundEvent.mock.calls[0]![0];
    expect(insert.eventType).toBe("whatsapp.message_echo");
    expect(insert.metaEventId).toBe("wamid.echo.1");
  });

  it("smb_app_state_sync → whatsapp.contact_synced", async () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WABA-1",
          changes: [
            {
              field: "smb_app_state_sync",
              value: { state_sync: [{ type: "contact", action: "add" }] },
            },
          ],
        },
      ],
    };
    await processMetaWebhook(payload as never);
    expect(inboundRepo.insertInboundEvent.mock.calls[0]![0].eventType).toBe(
      "whatsapp.contact_synced",
    );
  });

  it("history → whatsapp.history_synced", async () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WABA-1",
          changes: [
            {
              field: "history",
              value: { history: [{ metadata: { phase: 0, progress: 55 }, threads: [] }] },
            },
          ],
        },
      ],
    };
    await processMetaWebhook(payload as never);
    expect(inboundRepo.insertInboundEvent.mock.calls[0]![0].eventType).toBe(
      "whatsapp.history_synced",
    );
  });
});

describe("processMetaWebhook — PARTNER_REMOVED disconnect", () => {
  it("account_update/PARTNER_REMOVED → desconecta a WABA e entrega waba.connection_changed", async () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WABA-1",
          changes: [
            {
              field: "account_update",
              value: {
                event: "PARTNER_REMOVED",
                waba_info: { waba_id: "WABA-1" },
                disconnection_info: { reason: "PRIMARY_INACTIVITY" },
              },
            },
          ],
        },
      ],
    };
    await processMetaWebhook(payload as never);
    expect(wabaExtra.disconnectWabaByMetaWabaId).toHaveBeenCalledWith("WABA-1");
    expect(inboundRepo.insertInboundEvent.mock.calls[0]![0].eventType).toBe(
      "waba.connection_changed",
    );
  });

  it("account_update SEM PARTNER_REMOVED → não desconecta", async () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WABA-1",
          changes: [{ field: "account_update", value: { event: "PHONE_NUMBER_ADDED" } }],
        },
      ],
    };
    await processMetaWebhook(payload as never);
    expect(wabaExtra.disconnectWabaByMetaWabaId).not.toHaveBeenCalled();
  });
});
