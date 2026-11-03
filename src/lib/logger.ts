/**
 * Logger Pino centralizado — CLAUDE.md §7.4.
 *
 * Regras (não-negociáveis):
 *  - PII redaction obrigatória (`redact()`).
 *  - Nunca logar: access_token, private_key_pem, messages.content,
 *    idempotency body, webhook payload de mensagens recebidas.
 *  - Sempre logar: request_id, app_id, tenant_id quando disponíveis.
 *
 * Em runtime via Fastify, prefira `req.log.info(...)` — o request logger
 * já vem com bindings do request_id. Use este logger raiz apenas em
 * bootstrap, workers e CLI.
 */

import { pino, type Logger as PinoLogger, type LoggerOptions } from "pino";

import { env } from "@/config/env.js";

import { getContext } from "./request-context.js";

/**
 * Caminhos absolutos no log que devem ser redacted (substituídos por
 * "[REDACTED]"). Lista é conservadora — adicione novos quando notar.
 */
const REDACT_PATHS = [
  // Tokens / secrets
  "access_token",
  "*.access_token",
  "*.*.access_token",
  "access_token_encrypted",
  "*.access_token_encrypted",
  "private_key_pem",
  "*.private_key_pem",
  "secret",
  "*.secret",
  "password",
  "*.password",
  "password_hash",
  "*.password_hash",
  "Authorization",
  'req.headers["authorization"]',
  'req.headers["x-app-key"]',
  'req.headers["cookie"]',
  // OAuth — achado C1 (auditoria interna). `code` é o authorization code
  // da Meta; `state` é o token anti-CSRF que correlaciona ao tenant/app.
  // `error_description` pode conter mensagens da Meta com PII contextual.
  // Esses paths cobrem o caso fallback (objetos arbitrários logados pela
  // app); o vazamento principal em `req.url` é redijido pelo serializer
  // customizado em `src/bootstrap/logger.ts`.
  "code",
  "*.code",
  "state",
  "*.state",
  "error_description",
  "*.error_description",
  // Conteúdo de mensagens (CLAUDE.md §5.6)
  "messages.content",
  "*.messages.content",
  "payload.text",
  "payload.message",
  "payloadJson.text",
];

function buildLoggerOptions(): LoggerOptions {
  const cfg = env();
  return {
    level: cfg.LOG_LEVEL,
    redact: {
      paths: REDACT_PATHS,
      censor: "[REDACTED]",
    },
    base: {
      service: cfg.OTEL_SERVICE_NAME,
      env: cfg.NODE_ENV,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
    // Em dev: pretty-print. Em outros ambientes: JSON estruturado.
    ...(cfg.NODE_ENV === "development"
      ? {
          transport: {
            target: "pino-pretty",
            options: {
              colorize: true,
              translateTime: "HH:MM:ss.l",
              ignore: "pid,hostname",
            },
          },
        }
      : {}),
  };
}

let rootLogger: PinoLogger | null = null;

/**
 * Logger raiz do processo. Cacheado e lazy — só lê env na primeira chamada.
 */
export function logger(): PinoLogger {
  if (rootLogger === null) rootLogger = pino(buildLoggerOptions());
  return rootLogger;
}

/**
 * Logger com bindings do RequestContext atual (request_id, app_id, tenant_id).
 * Usar em código fora do path Fastify (workers, helpers chamados de queue).
 */
export function contextLogger(): PinoLogger {
  const ctx = getContext();
  if (!ctx) return logger();
  return logger().child({
    request_id: ctx.requestId,
    app_id: ctx.appId,
    tenant_id: ctx.tenantId,
  });
}

/**
 * Helper de redação para objetos arbitrários. Use antes de logar payloads
 * que possam carregar PII (CLAUDE.md §7.4).
 *
 * Aplica regras simples: chaves em REDACT_KEY_NAMES viram "[REDACTED]";
 * recursão limitada por profundidade para não estourar stack.
 */
const REDACT_KEY_NAMES = new Set([
  "access_token",
  "access_token_encrypted",
  "private_key_pem",
  "password",
  "password_hash",
  "secret",
  "authorization",
  "cookie",
  "content",
  "text",
  "body",
  // OAuth — achado C1. Ver REDACT_PATHS para racional.
  "code",
  "state",
  "error_description",
]);

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth-limit]";
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = REDACT_KEY_NAMES.has(k.toLowerCase()) ? "[REDACTED]" : redact(v, depth + 1);
  }
  return out;
}

/**
 * Subconjunto de `REDACT_KEY_NAMES` contendo APENAS secrets — sem conteúdo de
 * mensagem (content/text/body). Usado por `redactSecrets()`.
 */
const SECRET_KEY_NAMES = new Set([
  "access_token",
  "access_token_encrypted",
  "private_key_pem",
  "password",
  "password_hash",
  "secret",
  "authorization",
  "cookie",
  // OAuth — achado C1. `code` é authorization code, `state` é token
  // anti-CSRF, `error_description` pode conter PII contextual da Meta.
  "code",
  "state",
  "error_description",
]);

/**
 * Como `redact()`, mas scrub APENAS secrets (NÃO conteúdo de mensagem). Para o
 * `payloadJson` PERSISTIDO/encaminhado a consumidores (que precisam do conteúdo
 * da mensagem). `redact()` — set completo, incl. content/text/body — continua
 * sendo o helper correto para LOGS/AUDIT.
 */
export function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth-limit]";
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_KEY_NAMES.has(k.toLowerCase()) ? "[REDACTED]" : redactSecrets(v, depth + 1);
  }
  return out;
}

export function __resetLoggerForTests(): void {
  rootLogger = null;
}
