/**
 * Integração REAL do media storage path contra um MinIO (S3-compatible)
 * subido via testcontainers. Diferente dos unit tests (que mockam o storage),
 * este exercita IO de verdade: putMedia → headMedia → getPresignedUrl → GET,
 * e o worker `processMediaDownload` gravando bytes reais no bucket.
 *
 * Requer Docker. Roda via `pnpm test:integration`.
 *
 * Estratégia de env:
 *   - O `env()` é singleton cacheado e o `media-storage` cacheia o S3Client.
 *   - Setamos `process.env.MEDIA_S3_*` SÓ depois que o container expõe a porta
 *     mapeada (em beforeAll), chamamos `__resetEnvCacheForTests()` e então
 *     importamos dinamicamente os módulos `media-storage`/`media-download`,
 *     garantindo que o S3Client seja construído com o endpoint do container.
 *
 * Mock só do que é externo ao storage: o Graph client (via
 * setMetaOAuthClientForTests) + repo de wabas + token-resolver. O storage
 * (putMedia/headMedia/...) é REAL.
 */

import { CreateBucketCommand, HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { request } from "undici";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { MediaMetadata, MetaOAuthClient } from "@/integration/meta-client.js";

// --- mocks dos colaboradores externos ao storage -----------------------------
// O worker resolve a waba ativa + o token; aqui são determinísticos.
const wabaRepo = vi.hoisted(() => ({
  listWabasByTenant: vi.fn(),
}));
vi.mock("@/modules/wabas/repository.js", () => wabaRepo);

const tokenResolver = vi.hoisted(() => ({
  resolveActiveWabaToken: vi.fn(),
}));
vi.mock("@/modules/wabas/token-resolver.js", () => tokenResolver);

// --- env base obrigatório (Postgres/Redis/KMS não são tocados aqui) ----------
const ROOT_USER = "minioadmin";
const ROOT_PASSWORD = "minioadmin123";
const BUCKET = "bevox-media-test";
const MEDIA_MAX_BYTES = 1_048_576; // 1 MiB — pequeno o bastante p/ testar oversized
const PRESIGN_TTL = 180;

function setBaseEnv(): void {
  process.env.NODE_ENV = "test";
  process.env.LOG_LEVEL = "fatal";
  process.env.DATABASE_URL = "postgresql://bevox:pwd@localhost:5432/test";
  process.env.REDIS_URL = "redis://localhost:6379";
  process.env.KMS_PROVIDER = "local";
  process.env.KMS_KEY_ID = "test-key";
  process.env.KMS_LOCAL_MASTER_KEY = Buffer.alloc(32, 0x42).toString("base64");
  process.env.ADMIN_API_KEY = "test-admin-key-1234";
  process.env.MEDIA_S3_REGION = "us-east-1";
  process.env.MEDIA_S3_ACCESS_KEY = ROOT_USER;
  process.env.MEDIA_S3_SECRET_KEY = ROOT_PASSWORD;
  process.env.MEDIA_S3_BUCKET = BUCKET;
  process.env.MEDIA_MAX_BYTES = String(MEDIA_MAX_BYTES);
  process.env.MEDIA_PRESIGN_TTL_SECONDS = String(PRESIGN_TTL);
}

// Bindings preenchidos em beforeAll após import dinâmico (pós-env).
let putMedia!: (key: string, bytes: Buffer, contentType: string) => Promise<void>;
let headMedia!: (key: string) => Promise<boolean>;
let getPresignedUrl!: (key: string, ttlSeconds: number) => Promise<string>;
let mediaObjectKey!: (tenantId: string, mediaId: string) => string;
let processMediaDownload!: (job: {
  app_id: string;
  tenant_id: string;
  media_id: string;
}) => Promise<void>;
let setMetaOAuthClientForTests!: (client: MetaOAuthClient | null) => void;

let container: StartedTestContainer | null = null;

const TENANT_ID = "tenant-int-1";
const APP_ID = "app-int-1";

function job(mediaId: string) {
  return { app_id: APP_ID, tenant_id: TENANT_ID, media_id: mediaId };
}

/**
 * Stub do MetaOAuthClient: só os métodos de mídia importam. Os mocks por teste
 * substituem getMediaMetadata/downloadMedia conforme o cenário.
 */
function makeMediaClient(over: Partial<MetaOAuthClient>): MetaOAuthClient {
  const notImpl = () => {
    throw new Error("not implemented in integration stub");
  };
  return {
    exchangeCode: notImpl,
    exchangeLongLivedToken: notImpl,
    discoverWaba: notImpl,
    discoverIgAccount: notImpl,
    listPhoneNumbers: notImpl,
    updatePhoneNumberProfile: notImpl,
    createMessageTemplate: notImpl,
    getMessageTemplate: notImpl,
    deleteMessageTemplate: notImpl,
    sendWhatsAppMessage: notImpl,
    sendInstagramMessage: notImpl,
    getMediaMetadata: notImpl,
    downloadMedia: notImpl,
    ...over,
  } as MetaOAuthClient;
}

beforeAll(async () => {
  container = await new GenericContainer("minio/minio:latest")
    .withCommand(["server", "/data"])
    .withEnvironment({
      MINIO_ROOT_USER: ROOT_USER,
      MINIO_ROOT_PASSWORD: ROOT_PASSWORD,
    })
    .withExposedPorts(9000)
    .withWaitStrategy(Wait.forHttp("/minio/health/ready", 9000).forStatusCode(200))
    .start();

  const endpoint = `http://${container.getHost()}:${container.getMappedPort(9000)}`;

  // Env precisa do endpoint mapeado ANTES de qualquer env()/s3() ser chamado.
  setBaseEnv();
  process.env.MEDIA_S3_ENDPOINT = endpoint;

  // Flush do singleton de env e import dinâmico pós-env: o S3Client do
  // media-storage será construído lendo o endpoint do container.
  const envMod = await import("@/config/env.js");
  envMod.__resetEnvCacheForTests();

  const storage = await import("@/lib/media-storage.js");
  putMedia = storage.putMedia;
  headMedia = storage.headMedia;
  getPresignedUrl = storage.getPresignedUrl;
  mediaObjectKey = storage.mediaObjectKey;

  const worker = await import("@/workers/media-download.js");
  processMediaDownload = worker.processMediaDownload;

  const metaClient = await import("@/integration/meta-client.js");
  setMetaOAuthClientForTests = metaClient.setMetaOAuthClientForTests;

  // Cria o bucket de teste (mesmo SDK, mesmo endpoint/creds que o storage usa).
  const admin = new S3Client({
    endpoint,
    region: "us-east-1",
    credentials: { accessKeyId: ROOT_USER, secretAccessKey: ROOT_PASSWORD },
    forcePathStyle: true,
  });
  try {
    await admin.send(new HeadBucketCommand({ Bucket: BUCKET }));
  } catch {
    await admin.send(new CreateBucketCommand({ Bucket: BUCKET }));
  }
  admin.destroy();
}, 120_000);

afterEach(() => {
  setMetaOAuthClientForTests(null);
  vi.clearAllMocks();
  // re-arma defaults do worker (waba ativa + token plaintext)
  wabaRepo.listWabasByTenant.mockResolvedValue([{ id: "waba-conn-int-1" }]);
  tokenResolver.resolveActiveWabaToken.mockResolvedValue({
    accessToken: "plain-token",
    expiresAt: new Date(Date.now() + 3_600_000),
  });
});

afterAll(async () => {
  setMetaOAuthClientForTests?.(null);
  if (container) {
    await container.stop();
    container = null;
  }
}, 60_000);

describe("media-flow (MinIO testcontainer) — storage round-trip", () => {
  it("putMedia → headMedia → getPresignedUrl → GET retorna os mesmos bytes", async () => {
    const key = mediaObjectKey(TENANT_ID, "roundtrip-1");
    const payload = Buffer.from("hello-minio-roundtrip-ção", "utf8");

    await putMedia(key, payload, "application/octet-stream");

    expect(await headMedia(key)).toBe(true);

    const url = await getPresignedUrl(key, PRESIGN_TTL);
    expect(typeof url).toBe("string");
    expect(url).toContain("X-Amz-Signature");

    const res = await request(url, { method: "GET" });
    expect(res.statusCode).toBe(200);
    const got = Buffer.from(await res.body.arrayBuffer());
    expect(got.equals(payload)).toBe(true);
  });

  it("headMedia retorna false p/ key inexistente", async () => {
    expect(await headMedia(mediaObjectKey(TENANT_ID, "does-not-exist"))).toBe(false);
  });
});

describe("media-flow (MinIO testcontainer) — processMediaDownload", () => {
  it("happy path: baixa via Graph mock e persiste bytes reais no MinIO", async () => {
    const mediaId = "media-happy-1";
    const bytes = Buffer.from("real-image-bytes");
    const meta: MediaMetadata = {
      url: "https://cdn.meta/happy",
      mime_type: "image/jpeg",
      file_size: bytes.length,
    };
    const getMediaMetadata = vi.fn().mockResolvedValue(meta);
    const downloadMedia = vi.fn().mockResolvedValue(bytes);
    setMetaOAuthClientForTests(makeMediaClient({ getMediaMetadata, downloadMedia }));

    await processMediaDownload(job(mediaId));

    expect(getMediaMetadata).toHaveBeenCalledWith(mediaId, "plain-token");
    expect(downloadMedia).toHaveBeenCalledWith("https://cdn.meta/happy", "plain-token");
    expect(await headMedia(mediaObjectKey(TENANT_ID, mediaId))).toBe(true);
  });

  it("oversized: file_size > MEDIA_MAX_BYTES → não persiste nada", async () => {
    const mediaId = "media-oversized-1";
    const meta: MediaMetadata = {
      url: "https://cdn.meta/big",
      mime_type: "video/mp4",
      file_size: MEDIA_MAX_BYTES + 1,
    };
    const getMediaMetadata = vi.fn().mockResolvedValue(meta);
    const downloadMedia = vi.fn();
    setMetaOAuthClientForTests(makeMediaClient({ getMediaMetadata, downloadMedia }));

    await processMediaDownload(job(mediaId));

    expect(downloadMedia).not.toHaveBeenCalled();
    expect(await headMedia(mediaObjectKey(TENANT_ID, mediaId))).toBe(false);
  });

  it("idempotente: 2 chamadas → 1 objeto, downloadMedia chamado 1x", async () => {
    const mediaId = "media-idempotent-1";
    const bytes = Buffer.from("idempotent-bytes");
    const meta: MediaMetadata = {
      url: "https://cdn.meta/idem",
      mime_type: "image/png",
      file_size: bytes.length,
    };
    const getMediaMetadata = vi.fn().mockResolvedValue(meta);
    const downloadMedia = vi.fn().mockResolvedValue(bytes);
    setMetaOAuthClientForTests(makeMediaClient({ getMediaMetadata, downloadMedia }));

    await processMediaDownload(job(mediaId));
    await processMediaDownload(job(mediaId));

    expect(downloadMedia).toHaveBeenCalledTimes(1);
    expect(await headMedia(mediaObjectKey(TENANT_ID, mediaId))).toBe(true);
  });
});
