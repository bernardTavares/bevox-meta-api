/**
 * Configuração tipada do bevox-meta-api.
 *
 * Contrato: todas as variáveis de ambiente que o serviço consome passam por
 * este schema Zod antes de serem usadas em qualquer ponto do código. Não
 * existe `process.env.X` espalhado pelo runtime — apenas `env().X`.
 *
 * Referências:
 *  - .env.example (lista canônica de variáveis)
 *  - PRD §11/§12/§13
 *  - ADRs MA-002 (JWT), MA-007 (observabilidade), MA-008 (envelope encryption)
 */

import { config as loadDotenv } from "dotenv";
import { z } from "zod";

// Carrega .env primeiro, depois .env.local (override). Idempotente: se o
// arquivo não existir, dotenv silencia. NODE_ENV=test pula para evitar
// poluição em testes.
if (process.env.NODE_ENV !== "test") {
  loadDotenv({ path: ".env" });
  loadDotenv({ path: ".env.local", override: true });
}

// ---------------------------------------------------------------------------
// Sub-schemas
// ---------------------------------------------------------------------------

const NodeEnvSchema = z.enum(["development", "test", "staging", "production"]);
const LogLevelSchema = z.enum(["trace", "debug", "info", "warn", "error", "fatal"]);
const KmsProviderSchema = z.enum(["local", "aws", "gcp"]);

// String "vazia ou ausente" → undefined; string preenchida → trim. Útil para
// permitir valores em branco em dev sem quebrar `z.url()` etc.
const optionalString = z
  .string()
  .transform((v) => v.trim())
  .transform((v) => (v.length === 0 ? undefined : v))
  .optional();

// ---------------------------------------------------------------------------
// Schema principal
// ---------------------------------------------------------------------------

const baseSchema = z.object({
  // Runtime
  NODE_ENV: NodeEnvSchema.default("development"),
  PORT: z.coerce.number().int().positive().max(65535).default(3000),
  LOG_LEVEL: LogLevelSchema.default("info"),
  // Build identity — injetado pelo Dockerfile (--build-arg BUILD_SHA=<git-sha>);
  // exposto no /healthz para diagnosticar "prod está na versão X?" sem ssh.
  BUILD_SHA: z.string().default("unknown"),

  // Postgres + Redis (obrigatórios em qualquer ambiente)
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),

  // KMS / envelope encryption (MA-008)
  KMS_PROVIDER: KmsProviderSchema.default("local"),
  KMS_KEY_ID: z.string().min(1, "KMS_KEY_ID é obrigatório"),
  KMS_LOCAL_MASTER_KEY: optionalString,

  // Meta credentials (Embedded Signup + webhooks)
  META_APP_ID: optionalString,
  META_APP_SECRET: optionalString,
  META_ES_CONFIG_ID: optionalString,
  META_GRAPH_API_VERSION: z.string().default("v21.0"),
  META_WEBHOOK_VERIFY_TOKEN: optionalString,
  META_WEBHOOK_APP_SECRET: optionalString,
  // Base URL pública onde a Meta envia callbacks OAuth (deve casar com o
  // valid OAuth redirect URI registrado no Meta App). Sem trailing slash.
  // Ex.: "https://meta-api.example.com" → "/v1/oauth/waba/callback".
  OAUTH_CALLBACK_BASE_URL: optionalString,

  // JWT (MA-002) — RS256, vida ≤ 5min
  JWT_ISSUER: z.string().default("bevox-meta-api"),
  JWT_AUDIENCE: z.string().default("bevox-meta-api"),
  JWT_MAX_AGE_SECONDS: z.coerce.number().int().positive().max(900).default(300),
  JWT_PUBLIC_KEYS_JSON: z.string().default("{}"),

  // Admin endpoints
  ADMIN_API_KEY: z.string().min(8, "ADMIN_API_KEY precisa ter ≥ 8 caracteres"),

  // Webhook delivery (MA-005 modo push)
  WEBHOOK_DELIVERY_SIGNING_SECRET: optionalString,
  WEBHOOK_DELIVERY_MAX_RETRIES: z.coerce.number().int().min(0).max(20).default(8),

  // Observabilidade (MA-007)
  SENTRY_DSN: optionalString,
  OTEL_EXPORTER_OTLP_ENDPOINT: optionalString,
  OTEL_SERVICE_NAME: z.string().default("bevox-meta-api"),
  // A17 fix: workers tsx (outbound/webhook/token/cleanup/media) expõem
  // /metrics num servidor HTTP dedicado nessa porta para o Prometheus
  // scrape. 0 desativa (não recomendado em prod — ServiceMonitor não
  // alcança o pod). Default 9090, dentre o range não-privilegiado.
  WORKER_METRICS_PORT: z.coerce.number().int().min(0).max(65535).default(9090),

  // Storage de mídia S3-compatible (MinIO em V1; ADR-012). Privado do meta-api.
  // Key = {tenant_id}/{media_id}; URLs pré-assinadas TTL curto, NUNCA logadas.
  MEDIA_S3_ENDPOINT: optionalString,
  MEDIA_S3_ACCESS_KEY: optionalString,
  MEDIA_S3_SECRET_KEY: optionalString,
  MEDIA_S3_BUCKET: optionalString,
  MEDIA_S3_REGION: z.string().default("us-east-1"),
  MEDIA_MAX_BYTES: z.coerce.number().int().positive().default(26_214_400),
  MEDIA_PRESIGN_TTL_SECONDS: z.coerce.number().int().positive().default(180),
});

// ---------------------------------------------------------------------------
// Refinamentos
// ---------------------------------------------------------------------------

const envSchema = baseSchema.superRefine((val, ctx) => {
  // 1. JWT_PUBLIC_KEYS_JSON precisa ser JSON válido (objeto kid -> PEM).
  try {
    const parsed: unknown = JSON.parse(val.JWT_PUBLIC_KEYS_JSON);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      ctx.addIssue({
        code: "custom",
        path: ["JWT_PUBLIC_KEYS_JSON"],
        message: "JWT_PUBLIC_KEYS_JSON deve ser um objeto JSON { kid: pem }",
      });
    }
  } catch {
    ctx.addIssue({
      code: "custom",
      path: ["JWT_PUBLIC_KEYS_JSON"],
      message: "JWT_PUBLIC_KEYS_JSON precisa ser JSON válido",
    });
  }

  // 2. KMS_PROVIDER=local exige KMS_LOCAL_MASTER_KEY (base64 ≥ 32 bytes).
  if (val.KMS_PROVIDER === "local" && val.NODE_ENV !== "test") {
    if (!val.KMS_LOCAL_MASTER_KEY) {
      ctx.addIssue({
        code: "custom",
        path: ["KMS_LOCAL_MASTER_KEY"],
        message: "KMS_LOCAL_MASTER_KEY é obrigatório quando KMS_PROVIDER=local",
      });
    } else {
      try {
        const decoded = Buffer.from(val.KMS_LOCAL_MASTER_KEY, "base64");
        if (decoded.length < 32) {
          ctx.addIssue({
            code: "custom",
            path: ["KMS_LOCAL_MASTER_KEY"],
            message: "KMS_LOCAL_MASTER_KEY deve ser base64 de ≥ 32 bytes (256 bits)",
          });
        }
      } catch {
        ctx.addIssue({
          code: "custom",
          path: ["KMS_LOCAL_MASTER_KEY"],
          message: "KMS_LOCAL_MASTER_KEY precisa ser base64 válido",
        });
      }
    }
  }

  // 2b. KMS_PROVIDER=gcp exige KMS_KEY_ID = resource path do keyRing.
  if (val.KMS_PROVIDER === "gcp") {
    const keyRingPath = /^projects\/[^/]+\/locations\/[^/]+\/keyRings\/[^/]+$/;
    if (!keyRingPath.test(val.KMS_KEY_ID)) {
      ctx.addIssue({
        code: "custom",
        path: ["KMS_KEY_ID"],
        message:
          "KMS_KEY_ID deve ser o resource path do keyRing (projects/.../locations/.../keyRings/...) quando KMS_PROVIDER=gcp",
      });
    }
  }

  // 3. Em produção, restrições adicionais.
  if (val.NODE_ENV === "production") {
    if (val.KMS_PROVIDER === "local") {
      ctx.addIssue({
        code: "custom",
        path: ["KMS_PROVIDER"],
        message: "KMS_PROVIDER=local é proibido em produção (MA-008)",
      });
    }

    const requiredInProd: Array<keyof typeof val> = [
      "META_APP_ID",
      "META_APP_SECRET",
      "META_WEBHOOK_VERIFY_TOKEN",
      "META_WEBHOOK_APP_SECRET",
      "WEBHOOK_DELIVERY_SIGNING_SECRET",
      "MEDIA_S3_ENDPOINT",
      "MEDIA_S3_ACCESS_KEY",
      "MEDIA_S3_SECRET_KEY",
      "MEDIA_S3_BUCKET",
    ];
    for (const key of requiredInProd) {
      if (!val[key]) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: `${key} é obrigatório em produção`,
        });
      }
    }

    // MinIO/S3 endpoint deve usar TLS em produção.
    if (val.MEDIA_S3_ENDPOINT && !val.MEDIA_S3_ENDPOINT.startsWith("https://")) {
      ctx.addIssue({
        code: "custom",
        path: ["MEDIA_S3_ENDPOINT"],
        message: "MEDIA_S3_ENDPOINT deve usar https:// em produção (TLS)",
      });
    }

    if (!val.JWT_PUBLIC_KEYS_JSON || val.JWT_PUBLIC_KEYS_JSON === "{}") {
      ctx.addIssue({
        code: "custom",
        path: ["JWT_PUBLIC_KEYS_JSON"],
        message: "JWT_PUBLIC_KEYS_JSON precisa conter ao menos uma chave em produção",
      });
    }

    if (val.LOG_LEVEL === "debug" || val.LOG_LEVEL === "trace") {
      ctx.addIssue({
        code: "custom",
        path: ["LOG_LEVEL"],
        message: `LOG_LEVEL=${val.LOG_LEVEL} é proibido em produção (PII risk)`,
      });
    }
  }
});

// ---------------------------------------------------------------------------
// API pública
// ---------------------------------------------------------------------------

export type Env = z.infer<typeof envSchema>;

export class EnvValidationError extends Error {
  public readonly issues: Array<{ path: string; message: string }>;

  constructor(issues: Array<{ path: string; message: string }>) {
    const formatted = issues.map((i) => `  - ${i.path}: ${i.message}`).join("\n");
    super(`Configuração de ambiente inválida:\n${formatted}`);
    this.name = "EnvValidationError";
    this.issues = issues;
  }
}

/**
 * Valida e retorna a configuração. Não cacheia — útil em testes e quando
 * é preciso forçar re-leitura. Em runtime use `env()`.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({
      path: i.path.join(".") || "<root>",
      message: i.message,
    }));
    throw new EnvValidationError(issues);
  }
  return result.data;
}

let cached: Env | null = null;

/**
 * Singleton da configuração validada — leitura lazy + cache.
 * Falha fatal no primeiro acesso se o ambiente for inválido.
 */
export function env(): Env {
  if (cached === null) {
    cached = loadEnv();
  }
  return cached;
}

/**
 * Reseta o cache. Apenas para uso em testes.
 */
export function __resetEnvCacheForTests(): void {
  cached = null;
}
