import { createHmac } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { buildServer } from "@/bootstrap/server.js";
import { __resetEnvCacheForTests } from "@/config/env.js";
import { __resetLoggerForTests } from "@/lib/logger.js";
import {
  __resetMetricsForTests,
  metaWebhookProcessedTotal,
  metaWebhookReceivedTotal,
} from "@/lib/metrics.js";
import { uuidv7 } from "@/lib/uuid.js";

/** Soma o counter para um outcome específico (0 se ausente). */
async function counterValue(
  counter: typeof metaWebhookReceivedTotal | typeof metaWebhookProcessedTotal,
  outcome: string,
): Promise<number> {
  const snapshot = await counter.get();
  const match = snapshot.values.find((v) => v.labels?.outcome === outcome);
  return match?.value ?? 0;
}

const WEBHOOK_SECRET = "meta-app-secret-test";
const VERIFY_TOKEN = "verify-token-test";

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
  META_APP_SECRET: "shh",
  META_WEBHOOK_VERIFY_TOKEN: VERIFY_TOKEN,
  META_WEBHOOK_APP_SECRET: WEBHOOK_SECRET,
  OAUTH_CALLBACK_BASE_URL: "https://meta-api.bevox.test",
};

const redisState = vi.hoisted(() => ({
  kv: new Map<string, string>(),
}));

vi.mock("@/lib/redis.js", () => ({
  getRedis: () => ({
    get: async (k: string) => redisState.kv.get(k) ?? null,
    set: async (k: string, v: string, _mode?: string, _ttl?: number, nx?: string) => {
      if (nx === "NX" && redisState.kv.has(k)) return null;
      redisState.kv.set(k, v);
      return "OK";
    },
    getdel: async () => null,
    eval: async () => [1, 1000, 0],
    ping: async () => "PONG",
    quit: async () => "OK",
  }),
  closeRedis: async () => {
    // no-op
  },
  createBullMQConnection: () => ({ quit: async () => "OK" }),
}));

const queueAdd = vi.hoisted(() => ({
  fn: vi.fn(async (_n: string, _p: unknown, _o?: unknown) => undefined),
}));
const mediaQueueAdd = vi.hoisted(() => ({
  fn: vi.fn(async (_n: string, _p: unknown, _o?: unknown) => undefined),
}));
vi.mock("@/lib/queues.js", () => ({
  OUTBOUND_QUEUE: "outbound-meta",
  WEBHOOK_DELIVERY_QUEUE: "webhook-delivery",
  MEDIA_DOWNLOAD_QUEUE: "media-download",
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
  getMediaDownloadQueue: () => ({ add: mediaQueueAdd.fn }),
  closeQueues: async () => {
    // no-op
  },
  __resetQueuesForTests: () => {},
}));

vi.mock("@/modules/apps/repository.js", () => ({
  findConsumerAppById: vi.fn(),
  findActiveAppKey: vi.fn(),
}));

const APP_ID = uuidv7();
const TENANT_ID = uuidv7();

vi.mock("@/modules/wabas/repository.js", () => ({
  findWabaByMetaWabaId: vi.fn(async (metaWabaId: string) =>
    metaWabaId === "WABA-1"
      ? {
          id: uuidv7(),
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
  findWabaByTenantAndMetaId: vi.fn(),
  listWabasByTenant: vi.fn(),
  findWabaConnectionById: vi.fn(),
  disconnectWaba: vi.fn(),
  createWabaConnectionWithToken: vi.fn(),
  reconnectWaba: vi.fn(),
}));

vi.mock("@/modules/ig/repository.js", () => ({
  findIgByMetaIgId: vi.fn(),
  findIgByTenantAndMetaId: vi.fn(),
  listIgsByTenant: vi.fn(),
  findIgConnectionById: vi.fn(),
  createIgConnectionWithToken: vi.fn(),
  reconnectIg: vi.fn(),
  disconnectIg: vi.fn(),
}));

const inboundRepo = vi.hoisted(() => ({
  insertInboundEvent: vi.fn(),
  listActiveSubscriptions: vi.fn(),
}));
vi.mock("@/modules/inbound/repository.js", () => inboundRepo);

let app: Awaited<ReturnType<typeof buildServer>>;

function sign(body: string): string {
  return "sha256=" + createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
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
  redisState.kv.clear();
  __resetMetricsForTests();
  inboundRepo.insertInboundEvent.mockImplementation(async (input: any) => ({
    id: uuidv7(),
    ...input,
    receivedAt: new Date(),
    dispatchedAt: null,
  }));
  inboundRepo.listActiveSubscriptions.mockResolvedValue([]);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("GET /webhooks/meta", () => {
  it("retorna challenge quando verify_token bate", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/webhooks/meta?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=42`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("42");
  });

  it("rejeita verify_token errado → 403", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/webhooks/meta?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=42`,
    });
    expect(res.statusCode).toBe(403);
  });

  it("query incompleta → 400", async () => {
    const res = await app.inject({ method: "GET", url: "/webhooks/meta" });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /webhooks/meta — HMAC", () => {
  it("rejeita sem assinatura → 401", async () => {
    const body = JSON.stringify({ object: "whatsapp_business_account", entry: [] });
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/meta",
      headers: { "content-type": "application/json" },
      payload: body,
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejeita assinatura com secret errado → 401", async () => {
    const body = JSON.stringify({ object: "whatsapp_business_account", entry: [] });
    const badSig = "sha256=" + createHmac("sha256", "wrong-secret").update(body).digest("hex");
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/meta",
      headers: { "content-type": "application/json", "x-hub-signature-256": badSig },
      payload: body,
    });
    expect(res.statusCode).toBe(401);
  });

  it("aceita assinatura válida → 200", async () => {
    const body = JSON.stringify({ object: "whatsapp_business_account", entry: [] });
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/meta",
      headers: { "content-type": "application/json", "x-hub-signature-256": sign(body) },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
  });
});

describe("POST /webhooks/meta — processing", () => {
  it("WhatsApp messages → persiste InboundEvent message.received e enfileira deliveries", async () => {
    inboundRepo.listActiveSubscriptions.mockResolvedValueOnce([
      {
        id: uuidv7(),
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
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WABA-1",
          changes: [
            {
              field: "messages",
              value: {
                messages: [{ id: "wamid.1", type: "text" }],
              },
            },
          ],
        },
      ],
    };
    const body = JSON.stringify(payload);
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/meta",
      headers: { "content-type": "application/json", "x-hub-signature-256": sign(body) },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    const r = res.json();
    expect(r.events_persisted).toBe(1);
    expect(r.deliveries_enqueued).toBe(1);

    const insertArgs = inboundRepo.insertInboundEvent.mock.calls[0]![0];
    expect(insertArgs.eventType).toBe("message.received");
    expect(insertArgs.appId).toBe(APP_ID);
    expect(insertArgs.tenantId).toBe(TENANT_ID);
    expect(insertArgs.metaEventId).toBe("wamid.1");

    expect(queueAdd.fn).toHaveBeenCalledWith(
      "deliver",
      expect.objectContaining({ event_type: "message.received" }),
      expect.objectContaining({ jobId: expect.any(String) }),
    );
  });

  it("WhatsApp text → payloadJson PRESERVA conteúdo da mensagem (não [REDACTED]) e scrub secrets", async () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WABA-1",
          changes: [
            {
              field: "messages",
              value: {
                messages: [
                  { id: "wamid.content.1", type: "text", text: { body: "olá quero agendar" } },
                ],
                contacts: [{ profile: { name: "João" } }],
                // secret embutido (simula campo sensível em payload bruto)
                access_token: "should-be-scrubbed",
              },
            },
          ],
        },
      ],
    };
    const body = JSON.stringify(payload);
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/meta",
      headers: { "content-type": "application/json", "x-hub-signature-256": sign(body) },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().events_persisted).toBe(1);

    const insertArgs = inboundRepo.insertInboundEvent.mock.calls[0]![0];
    // Conteúdo da mensagem DEVE chegar intacto aos consumidores (bug fix).
    expect(insertArgs.payloadJson.messages[0].text.body).toBe("olá quero agendar");
    expect(insertArgs.payloadJson.contacts[0].profile.name).toBe("João");
    // Secrets DEVEM continuar scrubbed at rest.
    expect(insertArgs.payloadJson.access_token).toBe("[REDACTED]");
  });

  it("WhatsApp media (image) → persiste media refs no payloadJson + enfileira download", async () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WABA-1",
          changes: [
            {
              field: "messages",
              value: {
                messages: [
                  {
                    id: "wamid.media.1",
                    type: "image",
                    image: {
                      id: "MEDIA-ID-123",
                      mime_type: "image/jpeg",
                      caption: "uma foto",
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const body = JSON.stringify(payload);
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/meta",
      headers: { "content-type": "application/json", "x-hub-signature-256": sign(body) },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().events_persisted).toBe(1);

    // Media DEVE estar no payloadJson PERSISTIDO (worker re-lê do DB).
    const insertArgs = inboundRepo.insertInboundEvent.mock.calls[0]![0];
    expect(insertArgs.payloadJson.media).toEqual([
      {
        media_key: "MEDIA-ID-123",
        mime_type: "image/jpeg",
        filename: null,
        caption: "uma foto",
      },
    ]);

    // Download enfileirado com app_id/tenant_id/media_id resolvidos.
    expect(mediaQueueAdd.fn).toHaveBeenCalledWith(
      "download",
      { app_id: APP_ID, tenant_id: TENANT_ID, media_id: "MEDIA-ID-123" },
      expect.objectContaining({ attempts: expect.any(Number) }),
    );
  });

  it("WhatsApp text → sem media no payload, sem download enfileirado", async () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WABA-1",
          changes: [
            { field: "messages", value: { messages: [{ id: "wamid.txt", type: "text" }] } },
          ],
        },
      ],
    };
    const body = JSON.stringify(payload);
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/meta",
      headers: { "content-type": "application/json", "x-hub-signature-256": sign(body) },
      payload: body,
    });
    expect(res.statusCode).toBe(200);

    const insertArgs = inboundRepo.insertInboundEvent.mock.calls[0]![0];
    expect(insertArgs.payloadJson.media).toBeUndefined();
    expect(mediaQueueAdd.fn).not.toHaveBeenCalled();
  });

  it("WhatsApp media de WABA órfã → NÃO enfileira download (sem tenant)", async () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WABA-UNKNOWN",
          changes: [
            {
              field: "messages",
              value: {
                messages: [
                  { id: "wamid.orphan.media", type: "image", image: { id: "ORPHAN-MEDIA" } },
                ],
              },
            },
          ],
        },
      ],
    };
    const body = JSON.stringify(payload);
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/meta",
      headers: { "content-type": "application/json", "x-hub-signature-256": sign(body) },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    // Media ainda é persistida no payload (para investigação), mas sem download.
    const insertArgs = inboundRepo.insertInboundEvent.mock.calls[0]![0];
    expect(insertArgs.payloadJson.media).toBeDefined();
    expect(mediaQueueAdd.fn).not.toHaveBeenCalled();
  });

  it("statuses → classifica como message.status_updated", async () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WABA-1",
          changes: [
            {
              field: "messages",
              value: { statuses: [{ id: "wamid.1", status: "delivered" }] },
            },
          ],
        },
      ],
    };
    const body = JSON.stringify(payload);
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/meta",
      headers: { "content-type": "application/json", "x-hub-signature-256": sign(body) },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(inboundRepo.insertInboundEvent.mock.calls[0]![0].eventType).toBe(
      "message.status_updated",
    );
  });

  it("dedupe: mesmo meta_event_id na 2ª chamada não persiste novamente", async () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WABA-1",
          changes: [
            { field: "messages", value: { messages: [{ id: "wamid.dup", type: "text" }] } },
          ],
        },
      ],
    };
    const body = JSON.stringify(payload);
    const headers = {
      "content-type": "application/json",
      "x-hub-signature-256": sign(body),
    };
    const r1 = await app.inject({ method: "POST", url: "/webhooks/meta", headers, payload: body });
    const r2 = await app.inject({ method: "POST", url: "/webhooks/meta", headers, payload: body });
    expect(r1.json().events_persisted).toBe(1);
    expect(r2.json().events_persisted).toBe(0);
    expect(r2.json().events_deduplicated).toBe(1);
    // Insert chamado apenas 1x.
    expect(inboundRepo.insertInboundEvent).toHaveBeenCalledTimes(1);
  });

  it("WABA órfã (não casa com nenhum tenant) → persiste sem app/tenant, sem deliveries", async () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WABA-UNKNOWN",
          changes: [
            { field: "messages", value: { messages: [{ id: "wamid.orphan", type: "text" }] } },
          ],
        },
      ],
    };
    const body = JSON.stringify(payload);
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/meta",
      headers: { "content-type": "application/json", "x-hub-signature-256": sign(body) },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().events_persisted).toBe(1);
    expect(res.json().deliveries_enqueued).toBe(0);
    expect(inboundRepo.insertInboundEvent.mock.calls[0]![0].appId).toBeNull();
  });

  it("event_types_filter exclui eventType → não enfileira", async () => {
    inboundRepo.listActiveSubscriptions.mockResolvedValueOnce([
      {
        id: uuidv7(),
        appId: APP_ID,
        tenantId: TENANT_ID,
        url: "https://x",
        eventTypesFilter: ["message.status_updated"], // só status, não received
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
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WABA-1",
          changes: [{ field: "messages", value: { messages: [{ id: "wamid.x", type: "text" }] } }],
        },
      ],
    };
    const body = JSON.stringify(payload);
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/meta",
      headers: { "content-type": "application/json", "x-hub-signature-256": sign(body) },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(queueAdd.fn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// A4 fix (audit 2026-06-02): HMAC roda ANTES de JSON.parse — vetor DoS
// pré-HMAC removido. Payloads inválidos forjados não consomem CPU de parse.
// A6 fix: counter `bevox_meta_api_meta_webhook_received_total` emitido para
// cada outcome de validação.
// ---------------------------------------------------------------------------

describe("A4/A6 — HMAC-first + metric emission", () => {
  it("payload JSON inválido COM assinatura correta → 400 parse_error", async () => {
    const malformed = '{"object": "whatsapp_business_account", "entry": [{';
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/meta",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": sign(malformed),
      },
      payload: malformed,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_INPUT");
  });

  it("payload JSON inválido SEM assinatura correta → 401 antes do parse (A4 DoS guard)", async () => {
    const malformed = '{"junk": <not-valid>}';
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/meta",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": "sha256=wrong-hex",
      },
      payload: malformed,
    });
    // Hoje retornaria 401 INVALID_SIGNATURE em vez de 400 INVALID_INPUT —
    // o parser nem tentou tocar no JSON pq HMAC falhou primeiro.
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("UNAUTHENTICATED");
  });

  it("payload JSON gigante forjado sem assinatura → 401 sem custo de parse", async () => {
    // 5MB de garbage. Antes do A4 fix, JSON.parse aceitaria começar a comer
    // CPU mesmo com assinatura inválida (vetor DoS).
    const huge = "[" + "0,".repeat(500_000) + "0]";
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/meta",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": "sha256=" + "a".repeat(64),
      },
      payload: huge,
    });
    expect(res.statusCode).toBe(401);
  });

  it("ausência total de X-Hub-Signature-256 → 401 missing_signature", async () => {
    const body = JSON.stringify({ object: "whatsapp_business_account", entry: [] });
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/meta",
      headers: { "content-type": "application/json" },
      payload: body,
    });
    expect(res.statusCode).toBe(401);
  });

  // -------------------------------------------------------------------------
  // A6: cada outcome de validação DEVE incrementar o counter labeled.
  // Antes do fix, HMAC inválido caía no error handler 401 sem instrumentação.
  // -------------------------------------------------------------------------

  it("A6: HMAC inválido incrementa meta_webhook_received_total{outcome=invalid_signature}", async () => {
    expect(await counterValue(metaWebhookReceivedTotal, "invalid_signature")).toBe(0);

    const body = JSON.stringify({ object: "whatsapp_business_account", entry: [] });
    const badSig = "sha256=" + createHmac("sha256", "wrong-secret").update(body).digest("hex");
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/meta",
      headers: { "content-type": "application/json", "x-hub-signature-256": badSig },
      payload: body,
    });
    expect(res.statusCode).toBe(401);
    expect(await counterValue(metaWebhookReceivedTotal, "invalid_signature")).toBe(1);
    expect(await counterValue(metaWebhookReceivedTotal, "ok")).toBe(0);
  });

  it("A6: header ausente incrementa missing_signature (não invalid_signature)", async () => {
    const body = JSON.stringify({ object: "whatsapp_business_account", entry: [] });
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/meta",
      headers: { "content-type": "application/json" },
      payload: body,
    });
    expect(res.statusCode).toBe(401);
    expect(await counterValue(metaWebhookReceivedTotal, "missing_signature")).toBe(1);
    expect(await counterValue(metaWebhookReceivedTotal, "invalid_signature")).toBe(0);
  });

  it("A6: HMAC válido + JSON inválido incrementa parse_error", async () => {
    const malformed = '{"object": "whatsapp_business_account", "entry": [{';
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/meta",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": sign(malformed),
      },
      payload: malformed,
    });
    expect(res.statusCode).toBe(400);
    expect(await counterValue(metaWebhookReceivedTotal, "parse_error")).toBe(1);
  });

  it("A6: caminho-feliz incrementa outcome=ok E processed_total=persisted", async () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WABA-1",
          changes: [
            { field: "messages", value: { messages: [{ id: "wamid.a6.ok", type: "text" }] } },
          ],
        },
      ],
    };
    const body = JSON.stringify(payload);
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/meta",
      headers: { "content-type": "application/json", "x-hub-signature-256": sign(body) },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(await counterValue(metaWebhookReceivedTotal, "ok")).toBe(1);
    expect(await counterValue(metaWebhookProcessedTotal, "persisted")).toBe(1);
    expect(await counterValue(metaWebhookProcessedTotal, "deduplicated")).toBe(0);
    expect(await counterValue(metaWebhookProcessedTotal, "orphan")).toBe(0);
  });

  it("A6: replay do mesmo meta_event_id incrementa processed_total{outcome=deduplicated}", async () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WABA-1",
          changes: [
            { field: "messages", value: { messages: [{ id: "wamid.a6.dup", type: "text" }] } },
          ],
        },
      ],
    };
    const body = JSON.stringify(payload);
    const headers = {
      "content-type": "application/json",
      "x-hub-signature-256": sign(body),
    };
    await app.inject({ method: "POST", url: "/webhooks/meta", headers, payload: body });
    await app.inject({ method: "POST", url: "/webhooks/meta", headers, payload: body });

    expect(await counterValue(metaWebhookProcessedTotal, "persisted")).toBe(1);
    expect(await counterValue(metaWebhookProcessedTotal, "deduplicated")).toBe(1);
  });

  it("A6: WABA órfã incrementa processed_total{outcome=orphan} (e NÃO persisted)", async () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WABA-UNKNOWN",
          changes: [
            {
              field: "messages",
              value: { messages: [{ id: "wamid.a6.orphan", type: "text" }] },
            },
          ],
        },
      ],
    };
    const body = JSON.stringify(payload);
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/meta",
      headers: { "content-type": "application/json", "x-hub-signature-256": sign(body) },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(await counterValue(metaWebhookProcessedTotal, "orphan")).toBe(1);
    expect(await counterValue(metaWebhookProcessedTotal, "persisted")).toBe(0);
  });
});
