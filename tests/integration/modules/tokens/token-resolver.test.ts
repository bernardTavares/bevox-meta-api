/**
 * Integração REAL de `resolveActiveWabaToken` — A25.
 *
 * Garante que a query ativa em `src/modules/wabas/token-resolver.ts` seleciona
 * o token correto sob múltiplos cenários, exercitando Postgres real (via
 * testcontainers) + envelope encryption real (MA-008 com KMS_PROVIDER=local):
 *
 *   1. três tokens coexistem (expirado, ativo, superseded) → retorna o ativo;
 *   2. quando só sobra superseded/expirado, retorna `metaUnavailable`
 *      (no_active_token);
 *   3. inserir um token novo (ativo, mais recente) → o resolver passa a
 *      retorná-lo no lugar do anterior;
 *   4. entre dois ativos não-superseded, retorna o mais recente (createdAt DESC).
 *
 * Estratégia: idêntica ao `media-flow.test.ts` — só configuramos env e
 * importamos `token-resolver` / `crypto-envelope` DEPOIS que o container
 * Postgres está pronto, para que `getDb()` use o pool apontado para ele.
 *
 * Roda via `pnpm test:integration` (requer Docker).
 */

import { migrate } from "drizzle-orm/node-postgres/migrator";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { EnvelopeOutput } from "@/lib/crypto-envelope.js";

// ---------------------------------------------------------------------------
// Env base (KMS local determinístico; DATABASE_URL é populada pós-container).
// ---------------------------------------------------------------------------

function setBaseEnv(): void {
  process.env.NODE_ENV = "test";
  process.env.LOG_LEVEL = "fatal";
  process.env.REDIS_URL = "redis://localhost:6379";
  process.env.KMS_PROVIDER = "local";
  process.env.KMS_KEY_ID = "test-key";
  process.env.KMS_LOCAL_MASTER_KEY = Buffer.alloc(32, 0x42).toString("base64");
  process.env.ADMIN_API_KEY = "test-admin-key-1234";
  process.env.META_APP_ID = "1234567890";
  process.env.META_APP_SECRET = "shh";
  process.env.OAUTH_CALLBACK_BASE_URL = "https://meta-api.bevox.test";
}

// Bindings preenchidos em beforeAll, após import dinâmico pós-env.
let resolveActiveWabaToken!: (id: string) => Promise<{
  accessToken: string;
  expiresAt: Date;
}>;
let encryptToken!: (
  plaintext: Buffer,
  kekKeyId: string,
  context: Record<string, string>,
) => Promise<EnvelopeOutput>;
let getDb!: () => any; // Drizzle DB; tipo concreto carregado dinamicamente
let closeDb!: () => Promise<void>;
let wabaConnections!: any;
let wabaTokens!: any;
let consumerApps!: any;
let tenants!: any;
let uuidv7!: () => string;
let eq!: (col: any, val: any) => any;

let container: StartedTestContainer | null = null;

const KEK = "bevox-meta-api/waba-tokens/v1";
const TENANT_ID = "11111111-1111-7111-8111-111111111111";
const APP_ID = "22222222-2222-7222-8222-222222222222";
const WABA_CONN_ID = "33333333-3333-7333-8333-333333333333";

interface InsertedToken {
  id: string;
  envelope: EnvelopeOutput;
  expiresAt: Date;
  refreshAt: Date;
  supersededAt: Date | null;
  createdAt: Date;
}

function ctxFor(): Record<string, string> {
  return { tenant_id: TENANT_ID, app_id: APP_ID, waba_id: WABA_CONN_ID, v: "1" };
}

async function insertToken(opts: {
  plaintext: string;
  expiresAt: Date;
  supersededAt?: Date | null;
  createdAt?: Date;
}): Promise<InsertedToken> {
  const id = uuidv7();
  const envelope = await encryptToken(Buffer.from(opts.plaintext, "utf8"), KEK, ctxFor());
  const createdAt = opts.createdAt ?? new Date();
  const refreshAt = new Date(opts.expiresAt.getTime() - 24 * 3600_000);
  await getDb()
    .insert(wabaTokens)
    .values({
      id,
      wabaConnectionId: WABA_CONN_ID,
      ciphertext: envelope.ciphertext,
      dekCiphertext: envelope.dekCiphertext,
      dekKeyId: envelope.dekKeyId,
      encryptionContext: envelope.encryptionContext,
      algo: envelope.algo,
      nonce: envelope.nonce,
      authTag: envelope.authTag,
      expiresAt: opts.expiresAt,
      refreshAt,
      createdAt,
      supersededAt: opts.supersededAt ?? null,
    });
  return {
    id,
    envelope,
    expiresAt: opts.expiresAt,
    refreshAt,
    supersededAt: opts.supersededAt ?? null,
    createdAt,
  };
}

beforeAll(async () => {
  container = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({
      POSTGRES_DB: "bevox_meta_api_test",
      POSTGRES_USER: "bevox",
      POSTGRES_PASSWORD: "bevox_test_password",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();

  const url = `postgresql://bevox:bevox_test_password@${container.getHost()}:${container.getMappedPort(
    5432,
  )}/bevox_meta_api_test`;

  // Env precisa do DATABASE_URL ANTES de qualquer env()/getDb() ser invocado.
  setBaseEnv();
  process.env.DATABASE_URL = url;

  // Flush singletons (env/kms/db) e importa pós-env. Mesmo padrão do
  // tests/integration/media-flow.test.ts.
  const envMod = await import("@/config/env.js");
  envMod.__resetEnvCacheForTests();
  const kmsMod = await import("@/integration/kms-client.js");
  kmsMod.__resetKmsClientForTests();
  const dbMod = await import("@/db/client.js");
  dbMod.__resetDbStateForTests();

  const drizzleOrm = await import("drizzle-orm");
  eq = drizzleOrm.eq;

  const schema = await import("@db/schema/index.js");
  wabaTokens = schema.wabaTokens;
  wabaConnections = schema.wabaConnections;
  consumerApps = schema.consumerApps;
  tenants = schema.tenants;

  const uuidMod = await import("@/lib/uuid.js");
  uuidv7 = uuidMod.uuidv7;

  const cryptoMod = await import("@/lib/crypto-envelope.js");
  encryptToken = cryptoMod.encryptToken;

  // Aplica migrations no banco do container.
  getDb = dbMod.getDb;
  closeDb = dbMod.closeDb;
  await migrate(getDb() as any, { migrationsFolder: "./db/migrations" });

  // Seed mínimo necessário para satisfazer FKs do waba_tokens.
  await getDb().insert(consumerApps).values({
    id: APP_ID,
    name: "test-app",
    description: null,
    status: "active",
    metadataJson: {},
  });
  await getDb().insert(tenants).values({
    id: TENANT_ID,
    appId: APP_ID,
    externalId: "tenant-int-token-resolver",
    displayName: "Tenant Token Resolver",
    metadataJson: {},
    status: "active",
  });
  await getDb().insert(wabaConnections).values({
    id: WABA_CONN_ID,
    tenantId: TENANT_ID,
    appId: APP_ID,
    metaBusinessId: "biz-1",
    metaWabaId: "waba-1",
    displayName: "WABA Test",
    verifiedStatus: "VERIFIED",
  });

  const resolverMod = await import("@/modules/wabas/token-resolver.js");
  resolveActiveWabaToken = resolverMod.resolveActiveWabaToken;
}, 120_000);

afterAll(async () => {
  if (closeDb) await closeDb();
  if (container) {
    await container.stop();
    container = null;
  }
}, 60_000);

describe("resolveActiveWabaToken — query de seleção (MA-008)", () => {
  it("retorna o token ATIVO quando coexistem expirado, ativo e superseded", async () => {
    // Limpa qualquer resíduo de testes anteriores na conexão.
    await getDb().delete(wabaTokens).where(eq(wabaTokens.wabaConnectionId, WABA_CONN_ID));

    const now = Date.now();
    const expired = await insertToken({
      plaintext: "EXPIRED-TOKEN",
      expiresAt: new Date(now - 3600_000), // 1h atrás
      createdAt: new Date(now - 7 * 24 * 3600_000),
    });
    const active = await insertToken({
      plaintext: "ACTIVE-TOKEN",
      expiresAt: new Date(now + 7 * 24 * 3600_000),
      createdAt: new Date(now - 24 * 3600_000),
    });
    const superseded = await insertToken({
      plaintext: "SUPERSEDED-TOKEN",
      // ainda dentro da janela de expiresAt — só `superseded_at` o exclui.
      expiresAt: new Date(now + 30 * 24 * 3600_000),
      supersededAt: new Date(now - 12 * 3600_000),
      createdAt: new Date(now - 2 * 24 * 3600_000),
    });

    const resolved = await resolveActiveWabaToken(WABA_CONN_ID);
    expect(resolved.accessToken).toBe("ACTIVE-TOKEN");
    // Sanidade: não confundimos o ativo com os outros.
    expect(resolved.accessToken).not.toBe("EXPIRED-TOKEN");
    expect(resolved.accessToken).not.toBe("SUPERSEDED-TOKEN");
    expect(resolved.expiresAt.getTime()).toBe(active.expiresAt.getTime());
    // E o resolver não muta os outros rows.
    expect(expired.id).not.toBe(active.id);
    expect(superseded.id).not.toBe(active.id);
  });

  it("lança META_UNAVAILABLE quando não há token ativo (todos expired/superseded)", async () => {
    await getDb().delete(wabaTokens).where(eq(wabaTokens.wabaConnectionId, WABA_CONN_ID));

    const now = Date.now();
    await insertToken({
      plaintext: "EXPIRED-ONLY",
      expiresAt: new Date(now - 60_000),
    });
    await insertToken({
      plaintext: "STILL-VALID-BUT-SUPERSEDED",
      expiresAt: new Date(now + 24 * 3600_000),
      supersededAt: new Date(now - 60_000),
    });

    await expect(resolveActiveWabaToken(WABA_CONN_ID)).rejects.toMatchObject({
      code: "META_UNAVAILABLE",
    });
  });

  it("após inserir token novo (mais recente), o resolver passa a retorná-lo", async () => {
    await getDb().delete(wabaTokens).where(eq(wabaTokens.wabaConnectionId, WABA_CONN_ID));

    const now = Date.now();
    const older = await insertToken({
      plaintext: "OLDER-ACTIVE",
      expiresAt: new Date(now + 7 * 24 * 3600_000),
      createdAt: new Date(now - 5 * 24 * 3600_000),
    });
    const first = await resolveActiveWabaToken(WABA_CONN_ID);
    expect(first.accessToken).toBe("OLDER-ACTIVE");

    // Rotaciona: insere mais recente e marca o anterior como superseded
    // (semelhante ao fluxo de refresh em token-refresh worker).
    const newer = await insertToken({
      plaintext: "NEWER-ACTIVE",
      expiresAt: new Date(now + 30 * 24 * 3600_000),
      createdAt: new Date(now - 60_000),
    });
    // Marca o antigo como superseded — força a query a desambiguar via
    // supersededAt em vez de só createdAt DESC.
    await getDb()
      .update(wabaTokens)
      .set({ supersededAt: new Date(now - 30_000) })
      .where(eq(wabaTokens.id, older.id));

    const second = await resolveActiveWabaToken(WABA_CONN_ID);
    expect(second.accessToken).toBe("NEWER-ACTIVE");
    expect(second.expiresAt.getTime()).toBe(newer.expiresAt.getTime());
  });

  it("entre dois ativos não-superseded, retorna o mais recente por createdAt DESC", async () => {
    await getDb().delete(wabaTokens).where(eq(wabaTokens.wabaConnectionId, WABA_CONN_ID));

    const now = Date.now();
    await insertToken({
      plaintext: "TOKEN-CREATED-EARLIER",
      expiresAt: new Date(now + 7 * 24 * 3600_000),
      createdAt: new Date(now - 3 * 24 * 3600_000),
    });
    await insertToken({
      plaintext: "TOKEN-CREATED-LATER",
      expiresAt: new Date(now + 5 * 24 * 3600_000),
      createdAt: new Date(now - 60_000),
    });

    const resolved = await resolveActiveWabaToken(WABA_CONN_ID);
    expect(resolved.accessToken).toBe("TOKEN-CREATED-LATER");
  });
});
