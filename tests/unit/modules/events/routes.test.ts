import { generateKeyPairSync } from "node:crypto";
import { EventEmitter } from "node:events";

import { SignJWT, importPKCS8 } from "jose";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { buildServer } from "@/bootstrap/server.js";
import { __resetEnvCacheForTests } from "@/config/env.js";
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
  closeRedis: async () => {},
  createBullMQConnection: () => ({ quit: async () => "OK" }),
}));

const eventBus = vi.hoisted(() => {
  // Fake subscriber: EventEmitter — emite "message" quando publish é chamado.
  const subs: Array<{ channel: string; emitter: EventEmitter; quit: () => Promise<unknown> }> = [];
  return {
    subs,
    createEventSubscriber: (appId: string) => {
      const channel = `events:${appId}`;
      const emitter = new EventEmitter();
      const subscriber = Object.assign(emitter, {
        subscribe: async () => 1,
        unsubscribe: async () => 1,
        quit: async () => "OK",
      });
      const handle = { channel, emitter, quit: subscriber.quit };
      subs.push(handle);
      return { subscriber, channel };
    },
    publishEvent: vi.fn(async (msg: any) => {
      // Encontra subscriber para esse app e emite.
      const handle = subs.find((s) => s.channel === `events:${msg.app_id}`);
      handle?.emitter.emit("message", handle.channel, JSON.stringify(msg));
    }),
    closeEventBus: async () => {},
    __resetEventBusForTests: () => {
      subs.length = 0;
    },
  };
});
vi.mock("@/lib/event-bus.js", () => eventBus);

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

const eventsRepo = vi.hoisted(() => ({
  listEventsForReplay: vi.fn(),
  listEventsForPolling: vi.fn(),
  ackEvents: vi.fn(),
}));
vi.mock("@/modules/events/repository.js", () => eventsRepo);

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
  signingKey = await importPKCS8(PRIVATE_PKCS8, "RS256");
  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  eventBus.__resetEventBusForTests();
  eventsRepo.listEventsForReplay.mockResolvedValue([]);
  eventsRepo.listEventsForPolling.mockResolvedValue([]);
  eventsRepo.ackEvents.mockResolvedValue(0);
  idem.store.clear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("GET /v1/events/stream — auth", () => {
  it("rejeita sem scope events:read → 403", async () => {
    const t = await token("messages:write");
    const res = await app.inject({
      method: "GET",
      url: "/v1/events/stream",
      headers: { authorization: `Bearer ${t}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("sem token → 401", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/events/stream" });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /v1/events/stream — validação (rotas streaming não rodam end-to-end via inject — replay/format-SSE coberto em integration tests)", () => {
  it("cursor inválido (não-UUIDv7) → 400", async () => {
    const t = await token("events:read");
    const res = await app.inject({
      method: "GET",
      url: `/v1/events/stream?cursor=not-a-uuid`,
      headers: { authorization: `Bearer ${t}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it("X-Tenant-Id inválido (não-UUIDv7) → 400", async () => {
    const t = await token("events:read");
    const res = await app.inject({
      method: "GET",
      url: `/v1/events/stream?cursor=${uuidv7()}`,
      headers: { authorization: `Bearer ${t}`, "x-tenant-id": "abc" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /v1/events — polling", () => {
  it("retorna eventos não-acked + next_cursor quando bate limit", async () => {
    const TENANT_ID = uuidv7();
    const event1 = {
      id: uuidv7(),
      appId: APP_ID,
      tenantId: TENANT_ID,
      eventType: "message.received",
      metaEventId: "wamid.1",
      payloadJson: { hello: "world" },
      receivedAt: new Date("2024-01-01T00:00:00Z"),
      dispatchedAt: null,
    };
    const event2 = { ...event1, id: uuidv7(), metaEventId: "wamid.2" };
    eventsRepo.listEventsForPolling.mockResolvedValueOnce([event1, event2]);

    const t = await token("events:read");
    const res = await app.inject({
      method: "GET",
      url: "/v1/events?limit=2",
      headers: { authorization: `Bearer ${t}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toHaveLength(2);
    expect(body.data[0].event_id).toBe(event1.id);
    expect(body.data[0].dispatched_at).toBeNull();
    expect(body.next_cursor).toBe(event2.id);

    expect(eventsRepo.listEventsForPolling).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: APP_ID,
        limit: 2,
        undispatchedOnly: true,
      }),
    );
  });

  it("limit > 500 → 400", async () => {
    const t = await token("events:read");
    const res = await app.inject({
      method: "GET",
      url: "/v1/events?limit=501",
      headers: { authorization: `Bearer ${t}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it("include_acked=true passa undispatchedOnly=false", async () => {
    eventsRepo.listEventsForPolling.mockResolvedValueOnce([]);
    const t = await token("events:read");
    await app.inject({
      method: "GET",
      url: "/v1/events?include_acked=true",
      headers: { authorization: `Bearer ${t}` },
    });
    expect(eventsRepo.listEventsForPolling).toHaveBeenCalledWith(
      expect.objectContaining({ undispatchedOnly: false }),
    );
  });

  it("X-Tenant-Id filtra polling por tenant", async () => {
    const TENANT_ID = uuidv7();
    eventsRepo.listEventsForPolling.mockResolvedValueOnce([]);
    const t = await token("events:read");
    await app.inject({
      method: "GET",
      url: "/v1/events",
      headers: { authorization: `Bearer ${t}`, "x-tenant-id": TENANT_ID },
    });
    expect(eventsRepo.listEventsForPolling).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT_ID }),
    );
  });

  it("rejeita scope errado", async () => {
    const t = await token("messages:write");
    const res = await app.inject({
      method: "GET",
      url: "/v1/events",
      headers: { authorization: `Bearer ${t}` },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("POST /v1/events/ack", () => {
  it("acka eventos e retorna count", async () => {
    eventsRepo.ackEvents.mockResolvedValueOnce(3);
    const ids = [uuidv7(), uuidv7(), uuidv7()];
    const t = await token("events:read");
    const res = await app.inject({
      method: "POST",
      url: "/v1/events/ack",
      headers: { authorization: `Bearer ${t}`, "idempotency-key": "ack-1" },
      payload: { event_ids: ids },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ acked: 3, requested: 3 });
    expect(eventsRepo.ackEvents).toHaveBeenCalledWith(APP_ID, ids);
  });

  it("rejeita event_ids vazio → 400", async () => {
    const t = await token("events:read");
    const res = await app.inject({
      method: "POST",
      url: "/v1/events/ack",
      headers: { authorization: `Bearer ${t}`, "idempotency-key": "ack-2" },
      payload: { event_ids: [] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejeita event_ids > 500 → 400", async () => {
    const ids = Array.from({ length: 501 }, () => uuidv7());
    const t = await token("events:read");
    const res = await app.inject({
      method: "POST",
      url: "/v1/events/ack",
      headers: { authorization: `Bearer ${t}`, "idempotency-key": "ack-3" },
      payload: { event_ids: ids },
    });
    expect(res.statusCode).toBe(400);
  });

  it("exige Idempotency-Key", async () => {
    const t = await token("events:read");
    const res = await app.inject({
      method: "POST",
      url: "/v1/events/ack",
      headers: { authorization: `Bearer ${t}` },
      payload: { event_ids: [uuidv7()] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejeita scope errado", async () => {
    const t = await token("messages:write");
    const res = await app.inject({
      method: "POST",
      url: "/v1/events/ack",
      headers: { authorization: `Bearer ${t}`, "idempotency-key": "ack-4" },
      payload: { event_ids: [uuidv7()] },
    });
    expect(res.statusCode).toBe(403);
  });
});
