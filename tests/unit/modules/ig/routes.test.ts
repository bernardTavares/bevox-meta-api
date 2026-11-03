import { generateKeyPairSync } from "node:crypto";

import { SignJWT, importPKCS8 } from "jose";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { buildServer } from "@/bootstrap/server.js";
import { __resetEnvCacheForTests } from "@/config/env.js";
import { __resetKmsClientForTests } from "@/integration/kms-client.js";
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
  META_APP_SECRET: "shh",
  OAUTH_CALLBACK_BASE_URL: "https://meta-api.bevox.test",
};

const redisState = vi.hoisted(() => ({
  kv: new Map<string, { value: string; expiresAt: number }>(),
}));

vi.mock("@/lib/redis.js", () => ({
  getRedis: () => ({
    get: async (k: string) => {
      const e = redisState.kv.get(k);
      if (!e || e.expiresAt < Date.now()) {
        redisState.kv.delete(k);
        return null;
      }
      return e.value;
    },
    set: async (k: string, v: string, _m: string, ttl: number) => {
      redisState.kv.set(k, { value: v, expiresAt: Date.now() + ttl * 1000 });
      return "OK";
    },
    getdel: async (k: string) => {
      const e = redisState.kv.get(k);
      if (!e || e.expiresAt < Date.now()) {
        redisState.kv.delete(k);
        return null;
      }
      redisState.kv.delete(k);
      return e.value;
    },
    eval: async () => [1, 1000, 0],
    ping: async () => "PONG",
    quit: async () => "OK",
  }),
  closeRedis: async () => {
    // no-op
  },
  createBullMQConnection: () => ({}),
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

const igRepo = vi.hoisted(() => ({
  create: vi.fn(),
  findByMeta: vi.fn(),
  reconnect: vi.fn(),
  list: vi.fn(),
  findById: vi.fn(),
  disconnect: vi.fn(),
}));

vi.mock("@/modules/ig/repository.js", () => ({
  createIgConnectionWithToken: igRepo.create,
  findIgByTenantAndMetaId: igRepo.findByMeta,
  reconnectIg: igRepo.reconnect,
  listIgsByTenant: igRepo.list,
  findIgConnectionById: igRepo.findById,
  disconnectIg: igRepo.disconnect,
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
  __resetKmsClientForTests();
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
  redisState.kv.clear();
  idem.store.clear();
  fakeMeta.exchangeCode.mockResolvedValue({
    access_token: "EAA-ig-fake",
    token_type: "bearer",
    expires_in: 3600,
  });
  fakeMeta.discoverIgAccount.mockResolvedValue({
    meta_ig_id: "ig-acc-1",
    username: "acme",
    account_type: "BUSINESS",
  });
  igRepo.findByMeta.mockResolvedValue(null);
  igRepo.create.mockImplementation(async (input: any) => ({
    connection: {
      id: uuidv7(),
      tenantId: input.tenantId,
      appId: input.appId,
      metaIgId: input.metaIgId,
      username: input.username,
      accountType: input.accountType,
      createdAt: new Date(),
      updatedAt: new Date(),
      disconnectedAt: null,
    },
    token: { id: uuidv7() },
  }));
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("POST /v1/tenants/:tenant_id/ig-accounts/connect/init", () => {
  it("retorna oauth_url + state com scopes IG", async () => {
    const t = await token("ig:write");
    const res = await app.inject({
      method: "POST",
      url: `/v1/tenants/${TENANT_ID}/ig-accounts/connect/init`,
      headers: { authorization: `Bearer ${t}`, "idempotency-key": "ig-init" },
      payload: { redirect_url: "https://app.example.com/post" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const url = new URL(body.oauth_url);
    expect(url.searchParams.get("scope")).toContain("instagram_basic");
    expect(url.searchParams.get("scope")).toContain("instagram_manage_messages");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://meta-api.bevox.test/v1/oauth/ig/callback",
    );

    const stored = redisState.kv.get(`oauth:state:${body.state}`);
    expect(stored).toBeDefined();
    const payload = JSON.parse(stored!.value);
    expect(payload.channel).toBe("ig");
  });

  it("rejeita scope errado → 403", async () => {
    const t = await token("wabas:write");
    const res = await app.inject({
      method: "POST",
      url: `/v1/tenants/${TENANT_ID}/ig-accounts/connect/init`,
      headers: { authorization: `Bearer ${t}`, "idempotency-key": "ig-init-2" },
      payload: { redirect_url: "https://x.com" },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("GET /v1/oauth/ig/callback", () => {
  it("happy path: cifra com KEK ig + redireciona com ig_id", async () => {
    const state = uuidv7();
    redisState.kv.set(`oauth:state:${state}`, {
      value: JSON.stringify({
        app_id: APP_ID,
        tenant_id: TENANT_ID,
        channel: "ig",
        redirect_url: "https://app.example.com/post",
        created_at: Date.now(),
      }),
      expiresAt: Date.now() + 600_000,
    });

    const res = await app.inject({
      method: "GET",
      url: `/v1/oauth/ig/callback?code=ig-code&state=${state}`,
    });
    expect(res.statusCode).toBe(302);
    const loc = res.headers.location as string;
    expect(loc).toContain("ig_id=ig-acc-1");
    expect(loc).toContain("success=true");

    expect(igRepo.create).toHaveBeenCalledTimes(1);
    const args = igRepo.create.mock.calls[0]![0];
    expect(args.metaIgId).toBe("ig-acc-1");
    // KEK separada (MA-008): dek_key_id contém "ig-tokens"
    expect(args.envelope.dekKeyId).toContain("ig-tokens");
    // AAD inclui ig_id (anti-swap entre canais)
    expect(args.envelope.encryptionContext).toMatchObject({
      ig_id: "ig-acc-1",
      tenant_id: TENANT_ID,
    });
  });

  it("state com channel=waba é rejeitado em /v1/oauth/ig/callback", async () => {
    const state = uuidv7();
    redisState.kv.set(`oauth:state:${state}`, {
      value: JSON.stringify({
        app_id: APP_ID,
        tenant_id: TENANT_ID,
        channel: "waba",
        redirect_url: "https://x.com",
        created_at: Date.now(),
      }),
      expiresAt: Date.now() + 600_000,
    });

    const res = await app.inject({
      method: "GET",
      url: `/v1/oauth/ig/callback?code=c&state=${state}`,
    });
    expect(res.statusCode).toBe(400);
  });

  // A14 (audit 2026-06-02): a OpenAPI agora declara `error_reason` como
  // query opcional. Garantir que o handler aceita o parâmetro extra
  // emitido pela Meta (ex.: `user_denied`) e propaga o erro pro
  // redirect_url sem 500/400.
  it("aceita error_reason (declarado na OpenAPI) e redireciona com success=false", async () => {
    const state = uuidv7();
    redisState.kv.set(`oauth:state:${state}`, {
      value: JSON.stringify({
        app_id: APP_ID,
        tenant_id: TENANT_ID,
        channel: "ig",
        redirect_url: "https://app.example.com/post",
        created_at: Date.now(),
      }),
      expiresAt: Date.now() + 600_000,
    });

    const res = await app.inject({
      method: "GET",
      url:
        `/v1/oauth/ig/callback?state=${state}` +
        `&error=access_denied&error_reason=user_denied` +
        `&error_description=The+user+denied+your+request`,
    });
    expect(res.statusCode).toBe(302);
    const loc = res.headers.location as string;
    expect(loc).toContain("success=false");
    expect(loc).toContain("error=access_denied");
    expect(loc).toContain("error_description=");
  });
});

describe("GET /v1/tenants/:tenant_id/ig-accounts", () => {
  it("lista contas IG conectadas", async () => {
    const t = await token("ig:read");
    igRepo.list.mockResolvedValueOnce([
      {
        id: uuidv7(),
        tenantId: TENANT_ID,
        appId: APP_ID,
        metaIgId: "ig-1",
        username: "acme1",
        accountType: "BUSINESS",
        createdAt: new Date(),
        updatedAt: new Date(),
        disconnectedAt: null,
      },
    ]);
    const res = await app.inject({
      method: "GET",
      url: `/v1/tenants/${TENANT_ID}/ig-accounts`,
      headers: { authorization: `Bearer ${t}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data[0].username).toBe("acme1");
  });
});

describe("DELETE /v1/tenants/:tenant_id/ig-accounts/:ig_id", () => {
  it("desconecta IG ativa", async () => {
    const igId = uuidv7();
    igRepo.findById.mockResolvedValueOnce({
      id: igId,
      tenantId: TENANT_ID,
      appId: APP_ID,
      metaIgId: "x",
      username: "u",
      accountType: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      disconnectedAt: null,
    });
    igRepo.disconnect.mockResolvedValueOnce({
      id: igId,
      tenantId: TENANT_ID,
      appId: APP_ID,
      metaIgId: "x",
      username: "u",
      accountType: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      disconnectedAt: new Date(),
    });

    const t = await token("ig:write");
    const res = await app.inject({
      method: "DELETE",
      url: `/v1/tenants/${TENANT_ID}/ig-accounts/${igId}`,
      headers: { authorization: `Bearer ${t}`, "idempotency-key": "ig-d-1" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().disconnected_at).toBeTruthy();
  });

  it("já desconectada → 409", async () => {
    const igId = uuidv7();
    igRepo.findById.mockResolvedValueOnce({
      id: igId,
      tenantId: TENANT_ID,
      appId: APP_ID,
      metaIgId: "x",
      username: "u",
      accountType: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      disconnectedAt: new Date(Date.now() - 1000),
    });
    const t = await token("ig:write");
    const res = await app.inject({
      method: "DELETE",
      url: `/v1/tenants/${TENANT_ID}/ig-accounts/${igId}`,
      headers: { authorization: `Bearer ${t}`, "idempotency-key": "ig-d-2" },
    });
    expect(res.statusCode).toBe(409);
  });
});
