/**
 * Unit tests — sealOutboundJobSecrets / unsealOutboundJobSecrets
 * (src/lib/redact.ts) — fix A3 (audit 2026-06-02).
 *
 * Cobertura:
 *  - round-trip: seal + unseal restaura request_body + callback_secret
 *  - serialização: blob sealed NÃO contém PII em plaintext
 *  - AAD binding: swap de job_id falha decryption (auth tag mismatch)
 *  - callback_secret opcional (undefined preservado)
 *  - tampering: ciphertext modificado falha decryption
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { __resetEnvCacheForTests } from "@/config/env.js";
import { __resetKmsClientForTests } from "@/integration/kms-client.js";
import { __resetLoggerForTests } from "@/lib/logger.js";
import { sealOutboundJobSecrets, unsealOutboundJobSecrets } from "@/lib/job-seal.js";

const REQUIRED_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  LOG_LEVEL: "fatal",
  DATABASE_URL: "postgresql://bevox:pwd@localhost:5432/test",
  REDIS_URL: "redis://localhost:6379",
  KMS_PROVIDER: "local",
  KMS_KEY_ID: "bevox-meta-api/outbound-jobs/v1",
  KMS_LOCAL_MASTER_KEY: Buffer.alloc(32, 0x33).toString("base64"),
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

const APP_ID = "00000000-0000-7000-8000-000000000001";
const TENANT_ID = "00000000-0000-7000-8000-000000000002";
const JOB_ID = "00000000-0000-7000-8000-000000000003";

const REQUEST_BODY = {
  channel: "whatsapp",
  to: "5511987654321",
  type: "text",
  content: { body: "mensagem ultra confidencial" },
};
const CALLBACK_SECRET = "shared-hmac-secret-do-cliente";

describe("sealOutboundJobSecrets / unsealOutboundJobSecrets — round-trip", () => {
  it("seal + unseal restaura request_body e callback_secret intactos", async () => {
    const sealed = await sealOutboundJobSecrets({
      appId: APP_ID,
      tenantId: TENANT_ID,
      jobId: JOB_ID,
      secrets: { request_body: REQUEST_BODY, callback_secret: CALLBACK_SECRET },
    });

    const restored = await unsealOutboundJobSecrets(sealed);
    expect(restored.request_body).toEqual(REQUEST_BODY);
    expect(restored.callback_secret).toBe(CALLBACK_SECRET);
  });

  it("seal sem callback_secret — round-trip preserva undefined", async () => {
    const sealed = await sealOutboundJobSecrets({
      appId: APP_ID,
      tenantId: TENANT_ID,
      jobId: JOB_ID,
      secrets: { request_body: REQUEST_BODY },
    });

    const restored = await unsealOutboundJobSecrets(sealed);
    expect(restored.request_body).toEqual(REQUEST_BODY);
    expect(restored.callback_secret).toBeUndefined();
  });
});

describe("sealOutboundJobSecrets — at-rest serialization (Redis blob)", () => {
  it("JSON.stringify(sealed) NÃO contém PII nem o secret em plaintext", async () => {
    const sealed = await sealOutboundJobSecrets({
      appId: APP_ID,
      tenantId: TENANT_ID,
      jobId: JOB_ID,
      secrets: { request_body: REQUEST_BODY, callback_secret: CALLBACK_SECRET },
    });

    const serialized = JSON.stringify(sealed);
    expect(serialized).not.toContain("5511987654321");
    expect(serialized).not.toContain("mensagem ultra confidencial");
    expect(serialized).not.toContain(CALLBACK_SECRET);
  });

  it("sealed metadata expõe APENAS encryption_context não-sensível (app_id, tenant_id, job_id, kind)", async () => {
    const sealed = await sealOutboundJobSecrets({
      appId: APP_ID,
      tenantId: TENANT_ID,
      jobId: JOB_ID,
      secrets: { request_body: REQUEST_BODY, callback_secret: CALLBACK_SECRET },
    });

    expect(sealed.encryption_context).toEqual({
      kind: "outbound-job-v1",
      app_id: APP_ID,
      tenant_id: TENANT_ID,
      job_id: JOB_ID,
    });
    expect(sealed.algo).toBe("AES-256-GCM-v1");
    // nonce 12 bytes (16 base64 chars com padding), auth tag 16 bytes (24 base64 chars).
    expect(Buffer.from(sealed.nonce_b64, "base64").length).toBe(12);
    expect(Buffer.from(sealed.auth_tag_b64, "base64").length).toBe(16);
  });
});

describe("unsealOutboundJobSecrets — AAD binding (anti-swap)", () => {
  it("falha decryption se job_id no encryption_context for trocado (swap entre jobs)", async () => {
    const sealed = await sealOutboundJobSecrets({
      appId: APP_ID,
      tenantId: TENANT_ID,
      jobId: JOB_ID,
      secrets: { request_body: REQUEST_BODY, callback_secret: CALLBACK_SECRET },
    });

    const tampered = {
      ...sealed,
      encryption_context: {
        ...sealed.encryption_context,
        job_id: "00000000-0000-7000-8000-deadbeef0000",
      },
    };

    await expect(unsealOutboundJobSecrets(tampered)).rejects.toThrow();
  });

  it("falha decryption se tenant_id no encryption_context for trocado (swap entre tenants)", async () => {
    const sealed = await sealOutboundJobSecrets({
      appId: APP_ID,
      tenantId: TENANT_ID,
      jobId: JOB_ID,
      secrets: { request_body: REQUEST_BODY },
    });

    const tampered = {
      ...sealed,
      encryption_context: {
        ...sealed.encryption_context,
        tenant_id: "00000000-0000-7000-8000-000000000999",
      },
    };

    await expect(unsealOutboundJobSecrets(tampered)).rejects.toThrow();
  });
});

describe("unsealOutboundJobSecrets — tampering detection", () => {
  it("ciphertext adulterado (flip um byte) → auth tag falha → erro", async () => {
    const sealed = await sealOutboundJobSecrets({
      appId: APP_ID,
      tenantId: TENANT_ID,
      jobId: JOB_ID,
      secrets: { request_body: REQUEST_BODY },
    });

    const buf = Buffer.from(sealed.ciphertext_b64, "base64");
    buf[0] = buf[0]! ^ 0xff;
    const tampered = { ...sealed, ciphertext_b64: buf.toString("base64") };

    await expect(unsealOutboundJobSecrets(tampered)).rejects.toThrow();
  });
});
