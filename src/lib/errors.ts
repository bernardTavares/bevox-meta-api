/**
 * AppError + códigos canônicos — PRD §9.4 + CLAUDE.md §7.3.
 *
 * Toda falha intencional do servidor lança `AppError`. O error handler
 * (src/bootstrap/error-handler.ts) converte para o JSON padronizado:
 *
 *   { "error": { "code", "message", "details?", "request_id" } }
 *
 * Nada de `throw new Error("string")` — sem `code`, fica "INTERNAL".
 */

export const ERROR_CODES = [
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "INVALID_INPUT",
  "NOT_FOUND",
  "CONFLICT",
  "IDEMPOTENCY_CONFLICT",
  "RATE_LIMITED",
  "META_UNAVAILABLE",
  "META_REJECTED",
  "INTERNAL",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const HTTP_STATUS_BY_CODE: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  INVALID_INPUT: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  // A12 fix (audit 2026-06-02): IDEMPOTENCY_CONFLICT alinhado ao OpenAPI
  // (docs/architecture/openapi.yaml: '422': IdempotencyConflict, idempotency-key
  // header parameter description). Clientes da spec recebem 422 nas
  // colisões de chave+body diferentes; antes recebiam 409 e quebravam o
  // contrato.
  IDEMPOTENCY_CONFLICT: 422,
  RATE_LIMITED: 429,
  META_UNAVAILABLE: 502,
  META_REJECTED: 422,
  INTERNAL: 500,
};

export interface AppErrorOptions {
  code: ErrorCode;
  message: string;
  httpStatus?: number;
  details?: Record<string, unknown>;
  cause?: unknown;
  /**
   * Se `true`, error handler logará em nível `error` mesmo para 4xx.
   * Padrão: 5xx → error, 4xx → warn.
   */
  forceLogError?: boolean;
}

export class AppError extends Error {
  public readonly code: ErrorCode;
  public readonly httpStatus: number;
  public readonly details?: Record<string, unknown>;
  public readonly forceLogError: boolean;

  constructor(opts: AppErrorOptions) {
    super(opts.message, { cause: opts.cause });
    this.name = "AppError";
    this.code = opts.code;
    this.httpStatus = opts.httpStatus ?? HTTP_STATUS_BY_CODE[opts.code];
    this.details = opts.details;
    this.forceLogError = opts.forceLogError ?? false;
  }
}

// ---------------------------------------------------------------------------
// Atalhos de uso comum
// ---------------------------------------------------------------------------

export const errors = {
  unauthenticated: (message = "Authentication required", details?: Record<string, unknown>) =>
    new AppError({ code: "UNAUTHENTICATED", message, details }),

  forbidden: (message = "Permission denied", details?: Record<string, unknown>) =>
    new AppError({ code: "FORBIDDEN", message, details }),

  invalidInput: (message: string, details?: Record<string, unknown>) =>
    new AppError({ code: "INVALID_INPUT", message, details }),

  notFound: (resource: string, id?: string) =>
    new AppError({
      code: "NOT_FOUND",
      message: `${resource}${id ? ` "${id}"` : ""} not found`,
      details: id ? { resource, id } : { resource },
    }),

  conflict: (message: string, details?: Record<string, unknown>) =>
    new AppError({ code: "CONFLICT", message, details }),

  idempotencyConflict: (key: string, details?: Record<string, unknown>) =>
    new AppError({
      code: "IDEMPOTENCY_CONFLICT",
      message: `Idempotency key "${key}" reused with different payload`,
      details: { key, ...details },
    }),

  rateLimited: (retryAfterSec: number, scope: string) =>
    new AppError({
      code: "RATE_LIMITED",
      message: `Rate limit exceeded for ${scope}`,
      details: { retry_after_seconds: retryAfterSec, scope },
    }),

  metaUnavailable: (cause?: unknown, details?: Record<string, unknown>) =>
    new AppError({
      code: "META_UNAVAILABLE",
      message: "Upstream Meta API unavailable",
      details,
      cause,
    }),

  metaRejected: (message: string, details?: Record<string, unknown>) =>
    new AppError({ code: "META_REJECTED", message, details }),

  internal: (message: string, cause?: unknown) =>
    new AppError({ code: "INTERNAL", message, cause, forceLogError: true }),
};

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}
