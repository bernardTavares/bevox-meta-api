import { beforeAll, describe, expect, it, vi } from "vitest";

import { __resetEnvCacheForTests } from "@/config/env.js";
import { GcpKmsClient } from "@/integration/kms-client.js";
import { decryptToken, encryptToken } from "@/lib/crypto-envelope.js";
import type { KeyManagementServiceClient } from "@google-cloud/kms";

const GCP_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  LOG_LEVEL: "fatal",
  DATABASE_URL: "postgresql://bevox:pwd@localhost:5432/test",
  REDIS_URL: "redis://localhost:6379",
  KMS_PROVIDER: "gcp",
  KMS_KEY_ID: "projects/p/locations/us-east4/keyRings/bevox-meta-api",
  ADMIN_API_KEY: "test-admin-key-1234",
};

beforeAll(() => {
  for (const [k, v] of Object.entries(GCP_ENV)) process.env[k] = v as string;
  __resetEnvCacheForTests();
});

const KEK = "bevox-meta-api/waba-tokens/v1";
const CTX = { tenant_id: "abc", waba_id: "waba-1" };

function makeFakeClient() {
  const calls: {
    encryptName?: string;
    decryptName?: string;
    encryptAad?: Buffer;
    decryptAad?: Buffer;
  } = {};
  const encrypt = vi.fn(
    async (req: { name: string; plaintext: Buffer; additionalAuthenticatedData: Buffer }) => {
      calls.encryptName = req.name;
      calls.encryptAad = Buffer.from(req.additionalAuthenticatedData);
      return [{ ciphertext: Buffer.from(req.plaintext), name: `${req.name}/cryptoKeyVersions/1` }];
    },
  );
  const decrypt = vi.fn(
    async (req: { name: string; ciphertext: Buffer; additionalAuthenticatedData: Buffer }) => {
      calls.decryptName = req.name;
      calls.decryptAad = Buffer.from(req.additionalAuthenticatedData);
      return [{ plaintext: Buffer.from(req.ciphertext) }];
    },
  );
  return { calls, encrypt, decrypt };
}

function clientOf(fake: ReturnType<typeof makeFakeClient>): KeyManagementServiceClient {
  return fake as unknown as KeyManagementServiceClient;
}

describe("GcpKmsClient.generateDataKey", () => {
  it("gera DEK de 32 bytes e chama encrypt com o resource e AAD corretos", async () => {
    const fake = makeFakeClient();
    const kms = new GcpKmsClient(clientOf(fake));
    const dk = await kms.generateDataKey(KEK, CTX);
    expect(dk.plaintext.length).toBe(32);
    expect(dk.keyId).toBe(KEK);
    expect(fake.calls.encryptName).toBe(
      "projects/p/locations/us-east4/keyRings/bevox-meta-api/cryptoKeys/waba-tokens",
    );
    expect(fake.encrypt).toHaveBeenCalledOnce();
  });

  it("mapeia as 3 KEKs lógicas para cryptoKeys distintas", async () => {
    const fake = makeFakeClient();
    const kms = new GcpKmsClient(clientOf(fake));
    await kms.generateDataKey("bevox-meta-api/ig-tokens/v1", CTX);
    expect(fake.calls.encryptName).toContain("/cryptoKeys/ig-tokens");
    await kms.generateDataKey("bevox-meta-api/webhook-secrets/v1", CTX);
    expect(fake.calls.encryptName).toContain("/cryptoKeys/webhook-secrets");
  });

  it("rejeita ID lógico desconhecido", async () => {
    const fake = makeFakeClient();
    const kms = new GcpKmsClient(clientOf(fake));
    await expect(kms.generateDataKey("bevox-meta-api/unknown/v1", CTX)).rejects.toThrow(
      /Unknown GCP KEK id/,
    );
  });
});

describe("GcpKmsClient.decryptDataKey", () => {
  it("round-trip: decifra a DEK cifrada por generateDataKey", async () => {
    const fake = makeFakeClient();
    const kms = new GcpKmsClient(clientOf(fake));
    const dk = await kms.generateDataKey(KEK, CTX);
    const dek = await kms.decryptDataKey(dk.ciphertext, dk.keyId, CTX);
    expect(dek.equals(dk.plaintext)).toBe(true);
    expect(dek.length).toBe(32);
    expect(fake.calls.decryptName).toBe(
      "projects/p/locations/us-east4/keyRings/bevox-meta-api/cryptoKeys/waba-tokens",
    );
  });

  it("usa AAD byte-idêntico na cifra e na decifra", async () => {
    const fake = makeFakeClient();
    const kms = new GcpKmsClient(clientOf(fake));
    const dk = await kms.generateDataKey(KEK, CTX);
    const aadOnEncrypt = Buffer.from(fake.calls.encryptAad as Buffer);
    await kms.decryptDataKey(dk.ciphertext, dk.keyId, CTX);
    expect((fake.calls.decryptAad as Buffer).equals(aadOnEncrypt)).toBe(true);
  });
});

describe("GcpKmsClient — erros (nunca vaza segredo)", () => {
  it("embrulha erro da API GCP no encrypt", async () => {
    const fake = makeFakeClient();
    fake.encrypt.mockRejectedValueOnce(new Error("PERMISSION_DENIED"));
    const kms = new GcpKmsClient(clientOf(fake));
    await expect(kms.generateDataKey(KEK, CTX)).rejects.toThrow(/GCP KMS encrypt failed/);
  });

  it("lança se encrypt não retorna ciphertext", async () => {
    const fake = makeFakeClient();
    fake.encrypt.mockResolvedValueOnce([{ name: "x" }] as unknown as Awaited<
      ReturnType<typeof fake.encrypt>
    >);
    const kms = new GcpKmsClient(clientOf(fake));
    await expect(kms.generateDataKey(KEK, CTX)).rejects.toThrow(/empty ciphertext/);
  });

  it("embrulha erro da API GCP no decrypt", async () => {
    const fake = makeFakeClient();
    fake.decrypt.mockRejectedValueOnce(new Error("NOT_FOUND"));
    const kms = new GcpKmsClient(clientOf(fake));
    await expect(kms.decryptDataKey(Buffer.alloc(40), KEK, CTX)).rejects.toThrow(
      /GCP KMS decrypt failed/,
    );
  });

  it("lança se a DEK decifrada não tem 32 bytes", async () => {
    const fake = makeFakeClient();
    fake.decrypt.mockResolvedValueOnce([{ plaintext: Buffer.alloc(16) }]);
    const kms = new GcpKmsClient(clientOf(fake));
    await expect(kms.decryptDataKey(Buffer.alloc(40), KEK, CTX)).rejects.toThrow(
      /DEK length != 32/,
    );
  });
});

describe("GcpKmsClient.healthCheck (A19 v2)", () => {
  // A19 v2: healthCheck faz roundtrip encrypt+decrypt do sentinel "readyz-probe"
  // sobre o cryptoKey webhook-secrets (exercita cryptoKeyEncrypterDecrypter — a
  // perm que o runtime de fato usa), em vez de getKeyRing (que exigia viewer).
  const PROBE_KEY =
    "projects/p/locations/us-east4/keyRings/bevox-meta-api/cryptoKeys/webhook-secrets";

  it("encrypt+decrypt roundtrip do sentinel resolve em sucesso", async () => {
    const encrypt = vi.fn(async (req: { name: string; plaintext: Buffer }) => [
      { ciphertext: Buffer.from(req.plaintext) },
    ]);
    const decrypt = vi.fn(async (req: { name: string; ciphertext: Buffer }) => [
      { plaintext: Buffer.from(req.ciphertext) },
    ]);
    const kms = new GcpKmsClient({ encrypt, decrypt } as unknown as KeyManagementServiceClient);
    await expect(kms.healthCheck()).resolves.toBeUndefined();
    expect(encrypt).toHaveBeenCalledOnce();
    expect(encrypt.mock.calls[0]![0].name).toBe(PROBE_KEY);
    expect(Buffer.from(encrypt.mock.calls[0]![0].plaintext).toString()).toBe("readyz-probe");
    expect(decrypt.mock.calls[0]![0].name).toBe(PROBE_KEY);
  });

  it("lança erro embrulhado 'GCP KMS healthCheck failed' se encrypt falhar", async () => {
    const encrypt = vi.fn(async () => {
      throw new Error("UNAUTHENTICATED: bad WIF token");
    });
    const kms = new GcpKmsClient({ encrypt } as unknown as KeyManagementServiceClient);
    await expect(kms.healthCheck()).rejects.toThrow(/GCP KMS healthCheck failed/);
  });

  it("lança se o roundtrip não recupera o sentinel", async () => {
    const encrypt = vi.fn(async (req: { name: string; plaintext: Buffer }) => [
      { ciphertext: Buffer.from(req.plaintext) },
    ]);
    const decrypt = vi.fn(async () => [{ plaintext: Buffer.from("WRONG") }]);
    const kms = new GcpKmsClient({ encrypt, decrypt } as unknown as KeyManagementServiceClient);
    await expect(kms.healthCheck()).rejects.toThrow(/GCP KMS healthCheck failed/);
  });
});

describe("GcpKmsClient — round-trip via crypto-envelope", () => {
  it("encryptToken→decryptToken com GcpKmsClient (mock) recupera o token", async () => {
    const fake = makeFakeClient();
    const kms = new GcpKmsClient(clientOf(fake));
    const plaintext = Buffer.from("EAA-fake-meta-token-xyz");
    const envelope = await encryptToken(plaintext, KEK, CTX, kms);
    expect(envelope.algo).toBe("AES-256-GCM-v1");
    expect(envelope.dekKeyId).toBe(KEK);
    const out = await decryptToken(envelope, kms);
    expect(out.toString()).toBe(plaintext.toString());
  });
});
