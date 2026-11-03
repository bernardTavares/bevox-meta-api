/**
 * Helpers de redaction canônicos — re-exports + scrub de string/stack.
 *
 * Motivação (achado A2 da auditoria interna 2026-06-02): a regra
 * `.claude/rules/secrets-never-log.md` referencia `serializeErrorRedacted`
 * (e um módulo canônico `src/lib/redact.ts`) que nunca foram implementados.
 * Sem isso, stacks de erro logados pelo Fastify/Pino podem conter tokens
 * Meta em claro (shapes `eyJ…` JWT ou `EAA…` long-lived) ou OAuth `code`
 * caso uma rota concatene o token à mensagem do `Error`.
 *
 * Este módulo expõe:
 *   - `redactStringSecrets(s)` — scrub de string usando regex de shape de
 *     token (JWT, Meta access token, OAuth code da Meta).
 *   - `serializeErrorRedacted(err)` — serializer Pino compatível, equivalente
 *     ao `pino.stdSerializers.err` PORÉM passando `message`, `stack` e
 *     `details` por `redactStringSecrets` + `redactSecrets` antes de devolver.
 *   - `redact` / `redactSecrets` reexportados de `@/lib/logger.js` para
 *     consumidores que prefiram `import {…} from "@/lib/redact"`.
 *
 * Padrões detectados em stack/string:
 *   - JWT-shape: `eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{6,}(\.[A-Za-z0-9_-]+)?`
 *     (header.body[.signature]) — cobre JWT consumer/admin emitidos pela API.
 *   - Meta long-lived access token: `EAA[A-Za-z0-9_-]{20,}` (system-user e
 *     page tokens da Cloud API começam com `EAA`).
 *   - Authorization Bearer inline: `Bearer\s+[A-Za-z0-9._\-+/=]{20,}`.
 *
 * NÃO substitui o `redact` paths do Pino — é uma camada extra para o caso
 * em que o token foi concatenado a uma string (mensagem de erro, stack
 * trace de lib que faz string interpolation, etc.).
 */

import { redact, redactSecrets } from "@/lib/logger.js";

export { redact, redactSecrets };

/**
 * Padrões de token reconhecidos por shape. ORDEM IMPORTA — patterns mais
 * específicos primeiro para evitar match parcial:
 *   1. `Bearer <token>` (carrega prefixo Authorization)
 *   2. JWT 3-segmentos (Bevox consumer/admin/meta JWT)
 *   3. JWT 2-segmentos (variantes sem signature explicit)
 *   4. Meta long-lived (`EAA…`)
 */
const TOKEN_PATTERNS: RegExp[] = [
  // Authorization Bearer <token> — captura o prefixo inteiro para
  // identificação clara no log.
  /Bearer\s+[A-Za-z0-9._\-+/=]{20,}/gi,
  // JWT shape (3 segmentos com signature). Header começa com `eyJ`
  // (base64url de `{"`). Mínimos: 12 chars no header, 6 no body.
  /eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]+/g,
  // JWT shape (2 segmentos, sem signature explícita — tokens HS variants).
  /eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{6,}/g,
  // Meta long-lived token (system-user / page access token).
  /EAA[A-Za-z0-9_-]{20,}/g,
];

const TOKEN_CENSOR = "[REDACTED_TOKEN]";

/**
 * Substitui tokens reconhecidos por shape em uma string arbitrária.
 *
 * Não-string entra e sai inalterado (conveniência para callers que
 * iteram structuredClone genérico).
 */
export function redactStringSecrets(value: unknown): unknown {
  if (typeof value !== "string") return value;
  let out = value;
  for (const re of TOKEN_PATTERNS) {
    out = out.replace(re, TOKEN_CENSOR);
  }
  return out;
}

/**
 * Shape do erro serializado para Pino. Compatível com `pino.stdSerializers.err`
 * — extender campos opcionais (`code`, `details`) preserva comportamento do
 * logger Fastify.
 */
export interface SerializedError {
  type: string;
  message: string;
  stack?: string;
  code?: string;
  details?: unknown;
  cause?: SerializedError | string;
  [key: string]: unknown;
}

interface ErrorLike {
  name?: string;
  message?: string;
  stack?: string;
  code?: unknown;
  details?: unknown;
  cause?: unknown;
}

function isErrorLike(v: unknown): v is ErrorLike {
  return typeof v === "object" && v !== null;
}

/**
 * Serializer canônico de `Error` para Pino — REDACTA stack/message contra
 * tokens em claro e passa `details` por `redactSecrets` (scrub de chaves
 * sensíveis preservando conteúdo de mensagem).
 *
 * Drop-in para `serializers: { err: serializeErrorRedacted }` em config Pino.
 *
 * Comportamento:
 *   - `message`/`stack`: `redactStringSecrets` aplicado.
 *   - `details` (campo extra do `AppError`): passa por `redactSecrets`.
 *   - `cause`: recursivo se for `Error`; string redacted se for string;
 *     caso contrário ignora.
 *   - Erros sem stack (string thrown) caem em `{ type: "NonError", message }`.
 */
export function serializeErrorRedacted(err: unknown): SerializedError {
  if (!isErrorLike(err)) {
    return {
      type: "NonError",
      message: typeof err === "string" ? (redactStringSecrets(err) as string) : String(err),
    };
  }

  const serialized: SerializedError = {
    type: err.name ?? "Error",
    message:
      typeof err.message === "string"
        ? (redactStringSecrets(err.message) as string)
        : String(err.message ?? ""),
  };

  if (typeof err.stack === "string") {
    serialized.stack = redactStringSecrets(err.stack) as string;
  }

  if (typeof err.code === "string" || typeof err.code === "number") {
    serialized.code = String(err.code);
  }

  if (err.details !== undefined) {
    // details pode conter tokens em chaves sensíveis (access_token, secret,
    // password, code, state, ...). `redactSecrets` cobre o caso; também
    // passamos as strings folha por `redactStringSecrets` para o caso de
    // detail ser uma string com token concatenado.
    serialized.details = redactDeep(err.details);
  }

  if (err.cause !== undefined) {
    if (isErrorLike(err.cause)) {
      serialized.cause = serializeErrorRedacted(err.cause);
    } else if (typeof err.cause === "string") {
      serialized.cause = redactStringSecrets(err.cause) as string;
    }
  }

  return serialized;
}

/**
 * Redaction profunda: aplica `redactSecrets` (chaves sensíveis) + scrub de
 * shapes de token em string folha. Combinação correta para `details` /
 * objetos arbitrários logados como parte do erro.
 */
function redactDeep(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth-limit]";
  if (typeof value === "string") return redactStringSecrets(value);
  if (value === null || typeof value !== "object") return value;
  // Primeiro scrub de chaves (preserva content/text/body — esses não devem
  // estar em err.details em primeiro lugar). Depois recursão para limpar
  // strings folha que sobrevivam.
  const keyScrubbed = redactSecrets(value);
  if (Array.isArray(keyScrubbed)) {
    return keyScrubbed.map((v) => redactDeep(v, depth + 1));
  }
  if (keyScrubbed === null || typeof keyScrubbed !== "object") return keyScrubbed;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(keyScrubbed)) {
    out[k] = redactDeep(v, depth + 1);
  }
  return out;
}
