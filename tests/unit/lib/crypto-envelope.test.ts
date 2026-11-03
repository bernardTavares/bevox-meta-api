import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { __resetEnvCacheForTests } from "@/config/env.js";
import { decryptToken, encryptToken } from "@/lib/crypto-envelope.js";
import { __resetKmsClientForTests } from "@/integration/kms-client.js";
import { __resetLoggerForTests } from "@/lib/logger.js";

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

beforeAll(() => {
  for (const [k, v] of Object.entries(REQUIRED_ENV)) process.env[k] = v;
  __resetEnvCacheForTests();
  __resetLoggerForTests();
  __resetKmsClientForTests();
});

beforeEach(() => {
  __resetKmsClientForTests();
});

afterEach(() => {
  __resetKmsClientForTests();
});

const KEK = "bevox-meta-api/waba-tokens/v1";

describe("encryptToken / decryptToken — round-trip", () => {
  it("cifra e decifra token Meta com mesmo contexto", async () => {
    const plaintext = Buffer.from("EAA-superfake-meta-token-xyz");
    const ctx = { tenant_id: "abc", waba_id: "waba-123", v: "1" };
    const env = await encryptToken(plaintext, KEK, ctx);

    expect(env.algo).toBe("AES-256-GCM-v1");
    expect(env.nonce.length).toBe(12);
    expect(env.authTag.length).toBe(16);
    expect(env.dekKeyId).toContain("local-kms");

    const out = await decryptToken(env);
    expect(out.toString()).toBe(plaintext.toString());
  });

  it("preserva bytes binários (não-UTF8)", async () => {
    const plaintext = Buffer.from([0xff, 0x00, 0x80, 0x7f, 0x01]);
    const ctx = { scope: "binary" };
    const env = await encryptToken(plaintext, KEK, ctx);
    const out = await decryptToken(env);
    expect(out.equals(plaintext)).toBe(true);
  });

  it("nonces são únicos entre cifragens (não-determinístico)", async () => {
    const plaintext = Buffer.from("same-token");
    const ctx = { tenant_id: "x" };
    const a = await encryptToken(plaintext, KEK, ctx);
    const b = await encryptToken(plaintext, KEK, ctx);
    expect(a.nonce.equals(b.nonce)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    // DEK também regenerada — ciphertext da DEK também distinto.
    expect(a.dekCiphertext.equals(b.dekCiphertext)).toBe(false);
  });
});

describe("encryptToken / decryptToken — AAD enforcement", () => {
  it("decifrar com encryption_context diferente falha (anti-swap)", async () => {
    const plaintext = Buffer.from("token-for-tenant-A");
    const ctxA = { tenant_id: "A", waba_id: "1" };
    const env = await encryptToken(plaintext, KEK, ctxA);

    const tampered = { ...env, encryptionContext: { tenant_id: "B", waba_id: "1" } };
    await expect(decryptToken(tampered)).rejects.toThrow();
  });

  it("decifrar com auth_tag adulterado falha", async () => {
    const plaintext = Buffer.from("xx");
    const ctx = { tenant_id: "A" };
    const env = await encryptToken(plaintext, KEK, ctx);
    const badTag = Buffer.from(env.authTag);
    badTag[0] = badTag[0]! ^ 0x01;
    await expect(decryptToken({ ...env, authTag: badTag })).rejects.toThrow();
  });

  it("decifrar com ciphertext adulterado falha", async () => {
    const plaintext = Buffer.from("yy");
    const ctx = { tenant_id: "A" };
    const env = await encryptToken(plaintext, KEK, ctx);
    const bad = Buffer.from(env.ciphertext);
    bad[0] = bad[0]! ^ 0x01;
    await expect(decryptToken({ ...env, ciphertext: bad })).rejects.toThrow();
  });

  it("decifrar com dek_ciphertext adulterado falha", async () => {
    const plaintext = Buffer.from("zz");
    const ctx = { tenant_id: "A" };
    const env = await encryptToken(plaintext, KEK, ctx);
    const bad = Buffer.from(env.dekCiphertext);
    bad[bad.length - 1] = bad[bad.length - 1]! ^ 0x01;
    await expect(decryptToken({ ...env, dekCiphertext: bad })).rejects.toThrow();
  });
});

describe("encryptToken — edge cases", () => {
  it("plaintext vazio lança", async () => {
    await expect(encryptToken(Buffer.alloc(0), KEK, { x: "1" })).rejects.toThrow(/empty/);
  });

  it("ordem de chaves do encryption_context não afeta decifragem", async () => {
    const plaintext = Buffer.from("order-stability");
    const env = await encryptToken(plaintext, KEK, { a: "1", b: "2", c: "3" });
    // Reordenamos as chaves no input — AAD deve ser canônica.
    const out = await decryptToken({
      ...env,
      encryptionContext: { c: "3", a: "1", b: "2" },
    });
    expect(out.toString()).toBe(plaintext.toString());
  });

  it("decifrar com algo desconhecido lança", async () => {
    const plaintext = Buffer.from("x");
    const env = await encryptToken(plaintext, KEK, { x: "1" });
    await expect(decryptToken({ ...env, algo: "AES-128-CTR" })).rejects.toThrow(/algo/);
  });
});
