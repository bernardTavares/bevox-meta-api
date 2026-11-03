import { describe, expect, it } from "vitest";

import { EnvValidationError, loadEnv } from "@/config/env.js";

// Master key dummy de 32 bytes em base64 — suficiente para passar refinamento
// quando KMS_PROVIDER=local. NUNCA usar em produção.
const DEV_MASTER_KEY = Buffer.alloc(32, 0x42).toString("base64");

const validBase = {
  NODE_ENV: "development",
  DATABASE_URL: "postgresql://bevox:pwd@localhost:5432/bevox_meta_api",
  REDIS_URL: "redis://localhost:6379",
  KMS_PROVIDER: "local",
  KMS_KEY_ID: "local-dev-key",
  KMS_LOCAL_MASTER_KEY: DEV_MASTER_KEY,
  ADMIN_API_KEY: "local-dev-admin-key-change-me",
} satisfies NodeJS.ProcessEnv;

describe("loadEnv — caminho feliz", () => {
  it("aceita configuração mínima de dev e aplica defaults", () => {
    const env = loadEnv(validBase);

    expect(env.NODE_ENV).toBe("development");
    expect(env.PORT).toBe(3000);
    expect(env.LOG_LEVEL).toBe("info");
    expect(env.JWT_ISSUER).toBe("bevox-meta-api");
    expect(env.JWT_MAX_AGE_SECONDS).toBe(300);
    expect(env.META_GRAPH_API_VERSION).toBe("v21.0");
    expect(env.WEBHOOK_DELIVERY_MAX_RETRIES).toBe(8);
  });

  it("coage PORT de string para number", () => {
    const env = loadEnv({ ...validBase, PORT: "8080" });
    expect(env.PORT).toBe(8080);
  });

  it("normaliza strings vazias para undefined em campos opcionais", () => {
    const env = loadEnv({ ...validBase, SENTRY_DSN: "   " });
    expect(env.SENTRY_DSN).toBeUndefined();
  });
});

describe("loadEnv — validação de campos obrigatórios", () => {
  it("rejeita DATABASE_URL ausente", () => {
    const { DATABASE_URL: _, ...rest } = validBase;
    expect(() => loadEnv(rest)).toThrow(EnvValidationError);
  });

  it("rejeita DATABASE_URL inválida", () => {
    expect(() => loadEnv({ ...validBase, DATABASE_URL: "not-a-url" })).toThrow(EnvValidationError);
  });

  it("rejeita ADMIN_API_KEY curto", () => {
    expect(() => loadEnv({ ...validBase, ADMIN_API_KEY: "abc" })).toThrow(EnvValidationError);
  });

  it("rejeita PORT inválido", () => {
    expect(() => loadEnv({ ...validBase, PORT: "0" })).toThrow(EnvValidationError);
    expect(() => loadEnv({ ...validBase, PORT: "70000" })).toThrow(EnvValidationError);
  });
});

describe("loadEnv — KMS local", () => {
  it("rejeita KMS_PROVIDER=local sem master key", () => {
    const { KMS_LOCAL_MASTER_KEY: _, ...rest } = validBase;
    expect(() => loadEnv(rest)).toThrow(/KMS_LOCAL_MASTER_KEY/);
  });

  it("rejeita master key curta (< 32 bytes)", () => {
    const shortKey = Buffer.alloc(16, 0x01).toString("base64");
    expect(() => loadEnv({ ...validBase, KMS_LOCAL_MASTER_KEY: shortKey })).toThrow(/≥ 32 bytes/);
  });
});

describe("loadEnv — JWT_PUBLIC_KEYS_JSON", () => {
  it("aceita default '{}'", () => {
    const env = loadEnv(validBase);
    expect(env.JWT_PUBLIC_KEYS_JSON).toBe("{}");
  });

  it("rejeita JSON inválido", () => {
    expect(() => loadEnv({ ...validBase, JWT_PUBLIC_KEYS_JSON: "{not-json" })).toThrow(
      /JSON válido/,
    );
  });

  it("rejeita JSON que não é objeto", () => {
    expect(() => loadEnv({ ...validBase, JWT_PUBLIC_KEYS_JSON: '["a","b"]' })).toThrow(
      /objeto JSON/,
    );
  });
});

describe("loadEnv — restrições de produção", () => {
  const prodBase = {
    ...validBase,
    NODE_ENV: "production",
    KMS_PROVIDER: "aws",
    META_APP_ID: "123",
    META_APP_SECRET: "secret",
    META_WEBHOOK_VERIFY_TOKEN: "verify",
    META_WEBHOOK_APP_SECRET: "appsecret",
    WEBHOOK_DELIVERY_SIGNING_SECRET: "signing",
    JWT_PUBLIC_KEYS_JSON: '{"kid-1":"-----BEGIN PUBLIC KEY-----..."}',
    MEDIA_S3_ENDPOINT: "https://minio.bevox.internal",
    MEDIA_S3_ACCESS_KEY: "minio-access",
    MEDIA_S3_SECRET_KEY: "minio-secret",
    MEDIA_S3_BUCKET: "bevox-media",
  };

  it("rejeita KMS_PROVIDER=local em produção", () => {
    expect(() => loadEnv({ ...prodBase, KMS_PROVIDER: "local" })).toThrow(
      /local é proibido em produção/,
    );
  });

  it("rejeita LOG_LEVEL=debug em produção", () => {
    expect(() => loadEnv({ ...prodBase, LOG_LEVEL: "debug" })).toThrow(/PII risk/);
  });

  it("rejeita META_APP_ID ausente em produção", () => {
    const { META_APP_ID: _, ...rest } = prodBase;
    expect(() => loadEnv(rest)).toThrow(/META_APP_ID.*obrigatório/);
  });

  it("rejeita JWT_PUBLIC_KEYS_JSON vazio em produção", () => {
    expect(() => loadEnv({ ...prodBase, JWT_PUBLIC_KEYS_JSON: "{}" })).toThrow(
      /ao menos uma chave/,
    );
  });

  it("rejeita MEDIA_S3_ENDPOINT ausente em produção", () => {
    const { MEDIA_S3_ENDPOINT: _, ...rest } = prodBase;
    expect(() => loadEnv(rest)).toThrow(/MEDIA_S3_ENDPOINT.*obrigatório/);
  });

  it("rejeita MEDIA_S3_ENDPOINT sem TLS em produção", () => {
    expect(() =>
      loadEnv({ ...prodBase, MEDIA_S3_ENDPOINT: "http://minio.bevox.internal" }),
    ).toThrow(/https:\/\/ em produção/);
  });

  it("aceita configuração de produção bem formada", () => {
    const env = loadEnv(prodBase);
    expect(env.NODE_ENV).toBe("production");
    expect(env.KMS_PROVIDER).toBe("aws");
    expect(env.MEDIA_S3_REGION).toBe("us-east-1");
    expect(env.MEDIA_MAX_BYTES).toBe(26_214_400);
    expect(env.MEDIA_PRESIGN_TTL_SECONDS).toBe(180);
  });
});

describe("EnvValidationError", () => {
  it("expõe lista estruturada de issues", () => {
    try {
      loadEnv({ ...validBase, DATABASE_URL: "not-a-url", ADMIN_API_KEY: "x" });
      expect.fail("loadEnv deveria ter lançado");
    } catch (err) {
      expect(err).toBeInstanceOf(EnvValidationError);
      const e = err as EnvValidationError;
      const paths = e.issues.map((i) => i.path);
      expect(paths).toContain("DATABASE_URL");
      expect(paths).toContain("ADMIN_API_KEY");
    }
  });
});

describe("loadEnv — KMS_PROVIDER=gcp", () => {
  const gcpBase = {
    ...validBase,
    KMS_PROVIDER: "gcp",
    KMS_KEY_ID: "projects/p/locations/us-east4/keyRings/bevox-meta-api",
  } satisfies NodeJS.ProcessEnv;

  it("aceita gcp com KMS_KEY_ID = path de keyRing válido", () => {
    const env = loadEnv(gcpBase);
    expect(env.KMS_PROVIDER).toBe("gcp");
    expect(env.KMS_KEY_ID).toContain("keyRings/bevox-meta-api");
  });

  it("rejeita gcp com KMS_KEY_ID que não é path de keyRing", () => {
    expect(() => loadEnv({ ...gcpBase, KMS_KEY_ID: "local-dev-key" })).toThrow(EnvValidationError);
  });

  it("aceita gcp em produção (destrava NODE_ENV=production)", () => {
    const prod = {
      ...gcpBase,
      NODE_ENV: "production",
      LOG_LEVEL: "info",
      META_APP_ID: "123",
      META_APP_SECRET: "secret",
      META_WEBHOOK_VERIFY_TOKEN: "verify",
      META_WEBHOOK_APP_SECRET: "appsecret",
      WEBHOOK_DELIVERY_SIGNING_SECRET: "signing",
      MEDIA_S3_ENDPOINT: "https://minio.example",
      MEDIA_S3_ACCESS_KEY: "ak",
      MEDIA_S3_SECRET_KEY: "sk",
      MEDIA_S3_BUCKET: "bucket",
      JWT_PUBLIC_KEYS_JSON: '{"kid-1":"-----BEGIN PUBLIC KEY-----abc"}',
    } satisfies NodeJS.ProcessEnv;
    expect(() => loadEnv(prod)).not.toThrow();
  });
});
