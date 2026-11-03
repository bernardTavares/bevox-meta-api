# Embedded Signup (gateway) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Adicionar suporte a WhatsApp Embedded Signup ao gateway: expor `config_id` no `connect/init` e um novo `POST .../wabas/connect/complete` que recebe o `code` do front, troca por token, descobre a WABA, registra o webhook per-WABA e persiste — reaproveitando a lógica do `handleWabaCallback`.

**Architecture:** Refatorar `handleWabaCallback` em 2 helpers (`validateActiveTenant`, `subscribeEncryptPersistWaba`) que o redirect e o novo `completeEmbeddedSignup` compartilham. O `complete` **sempre** chama `discoverWaba` (traz business_id/display_name/verified_status, obrigatórios). `exchangeCode` ganha `redirectUri?` opcional (ES não usa redirect).

**Tech Stack:** TypeScript strict, Fastify 5, Zod 4, Drizzle, Vitest 4. Sem deps novas.

**Spec:** `docs/superpowers/specs/2026-06-04-embedded-signup-gateway-design.md`. Decisões: manter os dois fluxos; registro de número fora de escopo; sempre `discoverWaba`.

---

## File Structure

- **Modify** `src/config/env.ts` — `META_ES_CONFIG_ID: optionalString` (bloco Meta).
- **Modify** `.env.example` — entrada `META_ES_CONFIG_ID=`.
- **Modify** `src/modules/wabas/schemas.ts` — `InitOAuthResponse.config_id?` + `embeddedSignupCompleteBodySchema`.
- **Modify** `src/integration/meta-client.ts` — `exchangeCode(code, redirectUri?)` opcional (interface + impl).
- **Modify** `src/modules/wabas/service.ts` — extrair `validateActiveTenant` + `subscribeEncryptPersistWaba`; rewire `handleWabaCallback`; `config_id` no `initWabaOAuth`; nova `completeEmbeddedSignup`.
- **Modify** `src/modules/wabas/routes.ts` — nova rota `POST .../connect/complete`.
- **Modify** `tests/unit/modules/wabas/routes.test.ts` — `META_ES_CONFIG_ID` no env + assert `config_id` no init.
- **Create** `tests/unit/modules/wabas/complete.test.ts` — testes do `connect/complete`.
- **Modify** `docs/architecture/openapi.yaml` — `config_id` no init + rota `complete`.

---

## Task 1: `config_id` no env e exposto no `connect/init`

**Files:**
- Test: `tests/unit/modules/wabas/routes.test.ts:11-22,231-262`
- Modify: `src/config/env.ts:61-62`, `.env.example`, `src/modules/wabas/schemas.ts:19-23`, `src/modules/wabas/service.ts:64-68`

- [ ] **Step 1: Teste que falha** — em `routes.test.ts`, adicionar `META_ES_CONFIG_ID` ao `REQUIRED_ENV` (após linha 21) e uma asserção no happy-path do init (após linha 261):

```ts
// no REQUIRED_ENV:
  META_ES_CONFIG_ID: "es-config-abc",
// no fim do teste "retorna oauth_url + state...":
    expect(body.config_id).toBe("es-config-abc");
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm test -- wabas/routes`
Expected: FAIL — `body.config_id` é `undefined`.

- [ ] **Step 3: Implementar**

`src/config/env.ts` — após `META_APP_SECRET: optionalString,` (linha 62):
```ts
  META_ES_CONFIG_ID: optionalString,
```

`.env.example` — junto das vars Meta:
```bash
# Embedded Signup: config_id de Facebook Login for Business (opcional).
# Se setado, /connect/init devolve este valor pro front rodar FB.login.
META_ES_CONFIG_ID=
```

`src/modules/wabas/schemas.ts` — `InitOAuthResponse` (linhas 19-23):
```ts
export interface InitOAuthResponse {
  oauth_url: string;
  state: string;
  expires_in_seconds: number;
  config_id?: string;
}
```

`src/modules/wabas/service.ts` — `initWabaOAuth` return (linhas 64-68):
```ts
  return {
    oauth_url: oauthUrl,
    state,
    expires_in_seconds: STATE_TTL_SECONDS,
    config_id: env().META_ES_CONFIG_ID,
  };
```

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm test -- wabas/routes` → PASS. `pnpm typecheck` → limpo.

- [ ] **Step 5: Commit**

```bash
git add src/config/env.ts .env.example src/modules/wabas/schemas.ts src/modules/wabas/service.ts tests/unit/modules/wabas/routes.test.ts
git commit -m "feat(wabas): expoe config_id (Embedded Signup) no connect/init"
```

---

## Task 2: Refatorar `handleWabaCallback` em helpers compartilhados (sem mudança de comportamento)

**Files:**
- Modify: `src/modules/wabas/service.ts:94-203`
- Test (rede de segurança): `tests/unit/modules/wabas/callback.test.ts` (existente, deve continuar verde)

- [ ] **Step 1: Adicionar os helpers** em `service.ts` (após o bloco de constantes `TOKEN_REFRESH_WINDOW_SEC`, ~linha 80). Importar `WabaDiscovery`:

```ts
// no topo, ajustar import do meta-client:
import {
  buildWabaRedirectUri,
  buildWebhookCallbackUri,
  getMetaOAuthClient,
  type WabaDiscovery,
} from "@/integration/meta-client.js";
```

```ts
/** Valida que o tenant existe e está ativo (usado por callback e complete). */
async function validateActiveTenant(appId: string, tenantId: string): Promise<void> {
  const tenant = await findTenantById(appId, tenantId);
  if (!tenant) throw errors.notFound("tenant", tenantId);
  if (tenant.deletedAt !== null || tenant.status !== "active") {
    throw errors.conflict("tenant inactive", {
      status: tenant.status,
      deleted: tenant.deletedAt !== null,
    });
  }
}

/**
 * Registra o webhook per-WABA, cifra o token (AAD anti-swap) e persiste a
 * conexão (create ou reconnect). Compartilhado por callback (redirect) e
 * completeEmbeddedSignup (ES). Falha no subscribe aborta antes de persistir.
 */
async function subscribeEncryptPersistWaba(args: {
  appId: string;
  tenantId: string;
  accessToken: string;
  expiresIn: number | undefined;
  discovery: WabaDiscovery;
}): Promise<{ connectionId: string; reconnected: boolean }> {
  const cfg = env();
  if (!cfg.META_WEBHOOK_VERIFY_TOKEN) {
    throw errors.internal("META_WEBHOOK_VERIFY_TOKEN not configured");
  }
  await getMetaOAuthClient().subscribeWabaApp(args.discovery.meta_waba_id, args.accessToken, {
    callbackUri: buildWebhookCallbackUri(),
    verifyToken: cfg.META_WEBHOOK_VERIFY_TOKEN,
  });

  const ctx = {
    tenant_id: args.tenantId,
    waba_id: args.discovery.meta_waba_id,
    app_id: args.appId,
    v: "1",
  };
  const tokenBytes = Buffer.from(args.accessToken, "utf8");
  let envelope;
  try {
    envelope = await encryptToken(tokenBytes, WABA_KEK_ID, ctx);
  } finally {
    tokenBytes.fill(0);
  }

  const ttlSec = args.expiresIn ?? TOKEN_DEFAULT_TTL_SEC;
  const expiresAt = new Date(Date.now() + ttlSec * 1000);
  const refreshAt = new Date(Date.now() + Math.max(60, ttlSec - TOKEN_REFRESH_WINDOW_SEC) * 1000);

  const existing = await findWabaByTenantAndMetaId(args.tenantId, args.discovery.meta_waba_id);
  if (existing) {
    const r = await reconnectWaba(
      existing.id,
      { displayName: args.discovery.display_name, verifiedStatus: args.discovery.verified_status },
      envelope,
      expiresAt,
      refreshAt,
    );
    return { connectionId: r.connection.id, reconnected: true };
  }
  const r = await createWabaConnectionWithToken({
    tenantId: args.tenantId,
    appId: args.appId,
    metaBusinessId: args.discovery.meta_business_id,
    metaWabaId: args.discovery.meta_waba_id,
    displayName: args.discovery.display_name,
    verifiedStatus: args.discovery.verified_status,
    envelope,
    expiresAt,
    refreshAt,
  });
  return { connectionId: r.connection.id, reconnected: false };
}
```

- [ ] **Step 2: Reescrever `handleWabaCallback`** (linhas 105-186) pra usar os helpers. Substituir o bloco de validação de tenant + subscribe/encrypt/persist por:

```ts
  await validateActiveTenant(payload.app_id, payload.tenant_id);

  const meta = getMetaOAuthClient();
  const exchanged = await meta.exchangeCode(input.code, buildWabaRedirectUri());
  const discovery = await meta.discoverWaba(exchanged.access_token);

  const { connectionId, reconnected } = await subscribeEncryptPersistWaba({
    appId: payload.app_id,
    tenantId: payload.tenant_id,
    accessToken: exchanged.access_token,
    expiresIn: exchanged.expires_in,
    discovery,
  });

  const url = new URL(payload.redirect_url);
  url.searchParams.set("success", "true");
  url.searchParams.set("waba_id", discovery.meta_waba_id);
  url.searchParams.set("waba_connection_id", connectionId);
  if (reconnected) url.searchParams.set("reconnected", "true");

  return {
    redirectUrl: url.toString(),
    wabaConnectionId: connectionId,
    metaWabaId: discovery.meta_waba_id,
    reconnected,
  };
```

(Remover o `void env();` órfão da linha ~189 — o helper já chama `env()`.)

- [ ] **Step 3: Rodar a rede de segurança**

Run: `pnpm test -- wabas/callback && pnpm typecheck`
Expected: PASS — comportamento idêntico (callback.test.ts verde). Se `WabaDiscovery` não for exportado por `meta-client.ts`, exportá-lo (já é um `export interface`).

- [ ] **Step 4: Commit**

```bash
git add src/modules/wabas/service.ts
git commit -m "refactor(wabas): extrai helpers compartilhados de handleWabaCallback"
```

---

## Task 3: `exchangeCode` com `redirect_uri` opcional

**Files:**
- Modify: `src/integration/meta-client.ts` (interface `MetaOAuthClient` ~linha 126; impl `UndiciMetaOAuthClient.exchangeCode` ~linha 259-278)

- [ ] **Step 1: Tornar opcional na interface** (`MetaOAuthClient.exchangeCode`):

```ts
  exchangeCode(code: string, redirectUri?: string): Promise<ExchangeCodeResult>;
```

- [ ] **Step 2: Condicionar no impl** (`UndiciMetaOAuthClient.exchangeCode`):

```ts
  async exchangeCode(code: string, redirectUri?: string): Promise<ExchangeCodeResult> {
    const cfg = env();
    if (!cfg.META_APP_ID || !cfg.META_APP_SECRET) {
      throw errors.internal("META_APP_ID/META_APP_SECRET not configured");
    }
    const query: Record<string, string> = {
      client_id: cfg.META_APP_ID,
      client_secret: cfg.META_APP_SECRET,
      code,
    };
    if (redirectUri) query.redirect_uri = redirectUri;
    const body = (await metaGet("/oauth/access_token", query)) as Partial<ExchangeCodeResult>;
    if (typeof body.access_token !== "string") {
      throw errors.metaRejected("Meta /oauth/access_token returned no access_token", {});
    }
    return {
      access_token: body.access_token,
      token_type: body.token_type ?? "bearer",
      expires_in: body.expires_in,
    };
  }
```

- [ ] **Step 3: Verificar** — os 2 callers (`wabas/service.ts`, `ig/service.ts`) seguem passando o redirect_uri, então nada quebra.

Run: `pnpm typecheck && pnpm test`
Expected: PASS (suíte inteira verde).

- [ ] **Step 4: Commit**

```bash
git add src/integration/meta-client.ts
git commit -m "feat(meta-client): exchangeCode com redirect_uri opcional (Embedded Signup)"
```

---

## Task 4: `completeEmbeddedSignup` + rota `POST .../connect/complete` (TDD)

**Files:**
- Test: `tests/unit/modules/wabas/complete.test.ts` (criar)
- Modify: `src/modules/wabas/schemas.ts`, `src/modules/wabas/service.ts`, `src/modules/wabas/routes.ts`

- [ ] **Step 1: Schema** em `schemas.ts` (após `oauthCallbackQuerySchema`):

```ts
export const embeddedSignupCompleteBodySchema = z.object({
  code: z.string().min(1).max(2048),
  waba_id: z.string().min(1).max(64).optional(),
  phone_number_id: z.string().min(1).max(64).optional(),
});

export type EmbeddedSignupCompleteBody = z.infer<typeof embeddedSignupCompleteBodySchema>;
```

- [ ] **Step 2: Escrever o teste que falha** — criar `tests/unit/modules/wabas/complete.test.ts`. O harness combina o de `routes.test.ts` (Redis + auth JWT `token()` + idempotency + tenants) com os mocks de meta-client + wabas/repository do `callback.test.ts`. Conteúdo:

```ts
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
  META_APP_SECRET: "shhh",
  META_WEBHOOK_VERIFY_TOKEN: "verify-tok-123",
  OAUTH_CALLBACK_BASE_URL: "https://meta-api.bevox.test",
};

const redisState = vi.hoisted(() => ({
  kv: new Map<string, { value: string; expiresAt: number }>(),
  rl: new Map<string, { tokens: number; ts: number; expiresAt: number }>(),
}));

vi.mock("@/lib/redis.js", () => {
  const get = vi.fn(async (key: string) => {
    const e = redisState.kv.get(key);
    if (!e || e.expiresAt < Date.now()) return null;
    return e.value;
  });
  const set = vi.fn(async (key: string, value: string, _m: string, ttl: number) => {
    redisState.kv.set(key, { value, expiresAt: Date.now() + ttl * 1000 });
    return "OK";
  });
  const getdel = vi.fn(async (key: string) => {
    const e = redisState.kv.get(key);
    redisState.kv.delete(key);
    return e ? e.value : null;
  });
  const evalFn = vi.fn(async () => [1, 1000, 0]);
  const fake = { get, set, getdel, eval: evalFn, ping: async () => "PONG", quit: async () => "OK" };
  return { getRedis: () => fake, closeRedis: async () => {}, createBullMQConnection: () => fake };
});

const APP_ID = uuidv7();
const KEY_ID = uuidv7();
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_PKCS8 = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const PUBLIC_SPKI = publicKey.export({ type: "spki", format: "pem" }).toString();

vi.mock("@/modules/apps/repository.js", () => ({
  findConsumerAppById: vi.fn(async (id: string) => ({
    id, name: "test", description: null, status: "active" as const,
    currentPublicKeyPem: null, currentPublicKeyId: null, metadataJson: {},
    createdAt: new Date(), updatedAt: new Date(),
  })),
  findActiveAppKey: vi.fn(async (appId: string, keyId: string) => ({
    id: keyId, appId, publicKeyPem: PUBLIC_SPKI, algo: "RS256" as const,
    validFrom: new Date(Date.now() - 60_000), validUntil: null, rotatedAt: null, createdAt: new Date(),
  })),
}));

const idem = vi.hoisted(() => {
  const store = new Map<string, unknown>();
  return {
    store,
    find: vi.fn(async (a: string, k: string) => store.get(`${a}:${k}`) ?? null),
    save: vi.fn(async (input: any) => {
      const k = `${input.appId}:${input.key}`;
      if (!store.has(k)) store.set(k, input);
    }),
  };
});
vi.mock("@/modules/idempotency/repository.js", () => ({
  findIdempotencyRecord: idem.find,
  saveIdempotencyRecord: idem.save,
}));

const tenantState = vi.hoisted(() => ({ findById: vi.fn() }));
vi.mock("@/modules/tenants/repository.js", () => ({
  findTenantById: tenantState.findById,
  insertTenant: vi.fn(), findTenantByExternalId: vi.fn(), listTenants: vi.fn(),
  updateTenant: vi.fn(), softDeleteTenant: vi.fn(), countActiveBindings: vi.fn(),
}));

const wabaRepo = vi.hoisted(() => ({
  createWabaConnectionWithToken: vi.fn(),
  findWabaByTenantAndMetaId: vi.fn(),
  reconnectWaba: vi.fn(),
  findWabaConnectionById: vi.fn(),
}));
vi.mock("@/modules/wabas/repository.js", () => ({
  createWabaConnectionWithToken: wabaRepo.createWabaConnectionWithToken,
  findWabaByTenantAndMetaId: wabaRepo.findWabaByTenantAndMetaId,
  reconnectWaba: wabaRepo.reconnectWaba,
  findWabaConnectionById: wabaRepo.findWabaConnectionById,
  disconnectWaba: vi.fn(),
  listWabasByTenant: vi.fn(),
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
};

let app: Awaited<ReturnType<typeof buildServer>>;
let signingKey: Awaited<ReturnType<typeof importPKCS8>>;
const TENANT_ID = uuidv7();

async function token(scope: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ scope })
    .setProtectedHeader({ alg: "RS256", kid: KEY_ID })
    .setIssuer(APP_ID).setAudience("bevox-meta-api")
    .setIssuedAt(now).setExpirationTime(now + 60).sign(signingKey);
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
  redisState.rl.clear();
  idem.store.clear();
  tenantState.findById.mockImplementation(async (appId: string, id: string) =>
    appId === APP_ID && id === TENANT_ID
      ? { id: TENANT_ID, appId: APP_ID, status: "active", deletedAt: null }
      : null,
  );
  fakeMeta.exchangeCode.mockResolvedValue({ access_token: "EAA-es", token_type: "bearer", expires_in: 3600 });
  fakeMeta.discoverWaba.mockResolvedValue({
    meta_business_id: "biz-1", meta_waba_id: "waba-1",
    display_name: "Acme WA", verified_status: "VERIFIED",
  });
  fakeMeta.subscribeWabaApp.mockResolvedValue(undefined);
  wabaRepo.findWabaByTenantAndMetaId.mockResolvedValue(null);
  wabaRepo.createWabaConnectionWithToken.mockImplementation(async (input: any) => ({
    connection: { id: uuidv7(), ...input }, token: { id: uuidv7() },
  }));
  wabaRepo.findWabaConnectionById.mockImplementation(async (_a: string, _t: string, id: string) => ({
    id, tenantId: TENANT_ID, metaBusinessId: "biz-1", metaWabaId: "waba-1",
    displayName: "Acme WA", verifiedStatus: "VERIFIED",
    createdAt: new Date(), updatedAt: new Date(), disconnectedAt: null,
  }));
});

afterEach(() => vi.clearAllMocks());

const URL_BASE = `/v1/tenants/${TENANT_ID}/wabas/connect/complete`;

describe("POST .../wabas/connect/complete", () => {
  it("happy path: troca code (sem redirect_uri), descobre, subscribe, persiste, 200", async () => {
    const t = await token("wabas:write");
    const res = await app.inject({
      method: "POST", url: URL_BASE,
      headers: { authorization: `Bearer ${t}`, "idempotency-key": "es-1" },
      payload: { code: "es-code", waba_id: "waba-1", phone_number_id: "phone-1" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().meta_waba_id).toBe("waba-1");
    expect(fakeMeta.exchangeCode).toHaveBeenCalledWith("es-code");
    expect(fakeMeta.discoverWaba).toHaveBeenCalledTimes(1);
    expect(fakeMeta.subscribeWabaApp).toHaveBeenCalledWith("waba-1", "EAA-es", {
      callbackUri: "https://meta-api.bevox.test/webhooks/meta", verifyToken: "verify-tok-123",
    });
    const insert = wabaRepo.createWabaConnectionWithToken.mock.calls[0]![0];
    expect(insert.metaBusinessId).toBe("biz-1");
    expect(insert.displayName).toBe("Acme WA");
    expect(Buffer.isBuffer(insert.envelope.ciphertext)).toBe(true);
  });

  it("waba_id hint que não casa com o descoberto → 400", async () => {
    const t = await token("wabas:write");
    const res = await app.inject({
      method: "POST", url: URL_BASE,
      headers: { authorization: `Bearer ${t}`, "idempotency-key": "es-2" },
      payload: { code: "es-code", waba_id: "waba-OUTRO" },
    });
    expect(res.statusCode).toBe(400);
    expect(wabaRepo.createWabaConnectionWithToken).not.toHaveBeenCalled();
  });

  it("subscribe falha → 5xx e NÃO persiste", async () => {
    fakeMeta.subscribeWabaApp.mockRejectedValueOnce(new Error("meta down"));
    const t = await token("wabas:write");
    const res = await app.inject({
      method: "POST", url: URL_BASE,
      headers: { authorization: `Bearer ${t}`, "idempotency-key": "es-3" },
      payload: { code: "es-code" },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(500);
    expect(wabaRepo.createWabaConnectionWithToken).not.toHaveBeenCalled();
  });

  it("sem scope wabas:write → 403", async () => {
    const t = await token("tenants:read");
    const res = await app.inject({
      method: "POST", url: URL_BASE,
      headers: { authorization: `Bearer ${t}`, "idempotency-key": "es-4" },
      payload: { code: "es-code" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("exige Idempotency-Key", async () => {
    const t = await token("wabas:write");
    const res = await app.inject({
      method: "POST", url: URL_BASE,
      headers: { authorization: `Bearer ${t}` },
      payload: { code: "es-code" },
    });
    expect(res.statusCode).toBe(400);
  });
});
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `pnpm test -- wabas/complete`
Expected: FAIL — rota `/connect/complete` não existe (404) / `completeEmbeddedSignup` indefinida.

- [ ] **Step 4: Implementar o service** — em `service.ts`, após `handleWabaCallback` (~linha 203):

```ts
export interface CompleteEmbeddedSignupInput {
  appId: string;
  tenantId: string;
  code: string;
  wabaIdHint?: string;
  phoneNumberIdHint?: string;
}

export async function completeEmbeddedSignup(
  input: CompleteEmbeddedSignupInput,
): Promise<WabaConnectionResponse> {
  await validateActiveTenant(input.appId, input.tenantId);

  const meta = getMetaOAuthClient();
  // ES: code vem do widget → exchange SEM redirect_uri (ver spec §4).
  const exchanged = await meta.exchangeCode(input.code);
  // SEMPRE descobrir: discoverWaba é o único que traz business_id/display_name/
  // verified_status (obrigatórios no persist + AAD). O hint é só cross-check.
  const discovery = await meta.discoverWaba(exchanged.access_token);
  if (input.wabaIdHint && input.wabaIdHint !== discovery.meta_waba_id) {
    throw errors.invalidInput("waba_id hint does not match discovered WABA", {
      hint: input.wabaIdHint,
      discovered: discovery.meta_waba_id,
    });
  }

  const { connectionId } = await subscribeEncryptPersistWaba({
    appId: input.appId,
    tenantId: input.tenantId,
    accessToken: exchanged.access_token,
    expiresIn: exchanged.expires_in,
    discovery,
  });

  const conn = await findWabaConnectionById(input.appId, input.tenantId, connectionId);
  if (!conn) throw errors.internal("waba connection not found after persist");
  return toResponse(conn);
}
```

- [ ] **Step 5: Implementar a rota** — em `routes.ts`, importar o schema novo e o service:

```ts
// import:
import {
  embeddedSignupCompleteBodySchema,
  initOAuthBodySchema,
  listWabasQuerySchema,
  oauthCallbackQuerySchema,
  tenantIdParamSchema,
  wabaIdParamSchema,
} from "./schemas.js";
import {
  completeEmbeddedSignup,
  disconnectWaba,
  handleWabaCallback,
  initWabaOAuth,
  listWabas,
} from "./service.js";
```

E adicionar a rota (após o `connect/init`, ~linha 33):

```ts
  // ----- POST /v1/tenants/:tenant_id/wabas/connect/complete (Embedded Signup) -----
  app.post(
    "/v1/tenants/:tenant_id/wabas/connect/complete",
    {
      preHandler: [
        app.requireAuth({ scopes: ["wabas:write"] }),
        app.requireRateLimit(),
        app.requireIdempotency(),
      ],
    },
    async (req) => {
      const { tenant_id } = tenantIdParamSchema.parse(req.params);
      const body = embeddedSignupCompleteBodySchema.parse(req.body);
      return completeEmbeddedSignup({
        appId: req.auth!.appId,
        tenantId: tenant_id,
        code: body.code,
        wabaIdHint: body.waba_id,
        phoneNumberIdHint: body.phone_number_id,
      });
    },
  );
```

- [ ] **Step 6: Rodar e ver passar**

Run: `pnpm test -- wabas/complete` → PASS. `pnpm typecheck && pnpm test` → tudo verde.

- [ ] **Step 7: Commit**

```bash
git add src/modules/wabas/schemas.ts src/modules/wabas/service.ts src/modules/wabas/routes.ts tests/unit/modules/wabas/complete.test.ts
git commit -m "feat(wabas): connect/complete (Embedded Signup) — exchange+discover+subscribe+persist"
```

---

## Task 5: OpenAPI

**Files:**
- Modify: `docs/architecture/openapi.yaml`

- [ ] **Step 1: `config_id` na resposta do `connect/init`** — no response schema de `POST /v1/tenants/{tenant_id}/wabas/connect/init`, adicionar à lista de properties:

```yaml
                  config_id:
                    type: string
                    description: Embedded Signup config_id (presente se META_ES_CONFIG_ID setado). Front roda FB.login com ele.
```

- [ ] **Step 2: Nova rota `connect/complete`** — adicionar após o bloco do `connect/init`:

```yaml
  /v1/tenants/{tenant_id}/wabas/connect/complete:
    parameters:
      - $ref: "#/components/parameters/TenantIdPath"
    post:
      tags: [wabas]
      summary: Completar Embedded Signup (POST do code vindo do widget)
      operationId: completeWabaEmbeddedSignup
      parameters:
        - $ref: "#/components/parameters/IdempotencyKey"
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [code]
              properties:
                code: { type: string }
                waba_id: { type: string }
                phone_number_id: { type: string }
      responses:
        "200":
          description: WABA conectada
          content:
            application/json:
              schema: { $ref: "#/components/schemas/WabaConnection" }
        "400": { $ref: "#/components/responses/BadRequest" }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "403": { $ref: "#/components/responses/Forbidden" }
        "422": { $ref: "#/components/responses/IdempotencyConflict" }
        "429": { $ref: "#/components/responses/RateLimited" }
```

> Ajustar os `$ref` de parâmetros/responses pros nomes reais do arquivo (conferir os já usados em `connect/init` e nas outras rotas — copiar os refs exatos).

- [ ] **Step 3: Validar e commitar**

Run: `pnpm openapi:check` (se existir) ou `pnpm typecheck`.

```bash
git add docs/architecture/openapi.yaml
git commit -m "docs(api): config_id no connect/init + rota connect/complete (Embedded Signup)"
```

---

## Itens de verificação empírica (pós-implementação, staging — NÃO bloqueiam o merge)

1. **`redirect_uri` no exchange de ES:** confirmar que a Meta aceita `/oauth/access_token` sem `redirect_uri` pra um code de ES. Se exigir, passar `buildWabaRedirectUri()` também no `completeEmbeddedSignup`.
2. **`discoverWaba` com token de System User (ES):** confirmar que o `/debug_token` + `granular_scopes` retorna o business da mesma forma; se diferir, ajustar a descoberta.

Ambos precisam de um `config_id` real + um run de ES real (front + conta de teste).

---

## Self-Review

**Spec coverage:** §1 config (Task 1) ✓; §2 connect/complete (Task 4) ✓; §3 refactor (Task 2) ✓; §4 exchangeCode opcional (Task 3) ✓; §5 OpenAPI (Task 5) ✓; decisões "sempre discoverWaba" (Task 4 service) ✓ e "registro fora de escopo" (não implementado) ✓.

**Placeholder scan:** sem TBD; todo código mostrado; o único "ajustar $ref" no OpenAPI é instrução concreta (copiar os refs já usados no arquivo).

**Type consistency:** `subscribeEncryptPersistWaba({appId, tenantId, accessToken, expiresIn, discovery})` e `validateActiveTenant(appId, tenantId)` idênticos em Task 2 (def) e Task 4 (uso). `WabaDiscovery` importado em Task 2. `embeddedSignupCompleteBodySchema` def em Task 4 Step 1, usado em routes Task 4 Step 5. `exchangeCode(code, redirectUri?)` (Task 3) usado sem 2º arg em `completeEmbeddedSignup` (Task 4). `findWabaConnectionById` já importado em `service.ts` (usado por `disconnectWaba`).
