/**
 * Fastify error handler global — converte qualquer Error em JSON canônico
 * conforme PRD §9.4.
 *
 * Mapeamentos:
 *   - AppError                  → usa code/httpStatus/details do próprio
 *   - ZodError                  → INVALID_INPUT com lista de issues
 *   - FST_ERR_VALIDATION        → INVALID_INPUT (Fastify schema validator)
 *   - FastifyError com statusCode 4xx → mantém código próximo do canônico
 *   - resto                     → INTERNAL (oculta stack para o cliente)
 */

import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";

import { type AppError, type ErrorCode, isAppError } from "@/lib/errors.js";
import { serializeErrorRedacted } from "@/lib/redact.js";

interface ErrorPayload {
  error: {
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
    request_id: string;
  };
}

function isZodError(err: unknown): err is ZodError {
  return err instanceof ZodError;
}

function isFastifyValidationError(err: unknown): err is FastifyError {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    typeof (err as { code: unknown }).code === "string" &&
    (err as { code: string }).code.startsWith("FST_ERR_VALIDATION")
  );
}

function fromZod(err: ZodError, requestId: string): { status: number; body: ErrorPayload } {
  return {
    status: 400,
    body: {
      error: {
        code: "INVALID_INPUT",
        message: "Request validation failed",
        details: {
          issues: err.issues.map((i) => ({
            path: i.path.join("."),
            message: i.message,
            code: i.code,
          })),
        },
        request_id: requestId,
      },
    },
  };
}

function fromAppError(err: AppError, requestId: string): { status: number; body: ErrorPayload } {
  return {
    status: err.httpStatus,
    body: {
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
        request_id: requestId,
      },
    },
  };
}

function fromUnknown(err: unknown, requestId: string): { status: number; body: ErrorPayload } {
  return {
    status: 500,
    body: {
      error: {
        code: "INTERNAL",
        message: "Internal server error",
        request_id: requestId,
      },
    },
  };
}

export async function errorHandler(
  err: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const requestId = request.id;

  let mapped: { status: number; body: ErrorPayload };
  if (isAppError(err)) {
    mapped = fromAppError(err, requestId);
  } else if (isZodError(err)) {
    mapped = fromZod(err, requestId);
  } else if (isFastifyValidationError(err)) {
    mapped = {
      status: 400,
      body: {
        error: {
          code: "INVALID_INPUT",
          message: err.message,
          details: err.validation ? { issues: err.validation } : undefined,
          request_id: requestId,
        },
      },
    };
  } else {
    mapped = fromUnknown(err, requestId);
  }

  // Log: 5xx ou forceLogError em nível error; 4xx em warn.
  // A2 fix (audit 2026-06-02): erro passado por `serializeErrorRedacted`
  // ANTES de chegar ao Pino — evita que tokens em `err.stack`/`err.message`
  // (shapes `eyJ…`/`EAA…`/Bearer) ou `AppError.details` sensíveis sejam
  // logados em claro. Sem isso, o `err` serializer default do Fastify
  // expõe o stack cru no log.
  const isError = mapped.status >= 500 || (isAppError(err) && err.forceLogError);
  const logFn = isError ? request.log.error.bind(request.log) : request.log.warn.bind(request.log);
  logFn(
    {
      err: serializeErrorRedacted(err),
      code: mapped.body.error.code,
      status: mapped.status,
    },
    `request failed: ${mapped.body.error.message}`,
  );

  await reply.status(mapped.status).send(mapped.body);
}
