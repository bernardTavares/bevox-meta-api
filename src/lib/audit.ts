/**
 * Audit log API — wrapper sobre o repository.
 *
 * Service layer chama `logAudit({...})` para registrar mutações. PII é
 * removida via `redact()`. NUNCA loga mensagem cru, secret, password,
 * access_token (lista em logger.ts).
 *
 * Falhas em audit log NÃO derrubam a request — log warn + segue. A regra é:
 * "audit é best-effort em runtime; integridade total só com transação";
 * para operações críticas (admin) chamar dentro da mesma txn no futuro.
 */

import { insertAuditLog } from "@/modules/audit/repository.js";

import { logger, redact } from "./logger.js";

export interface LogAuditInput {
  actorType: "consumer_app" | "admin" | "system";
  actorId?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  tenantId?: string | null;
  appId?: string | null;
  metadata?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
}

export async function logAudit(input: LogAuditInput): Promise<void> {
  try {
    const redacted = (redact(input.metadata ?? {}) as Record<string, unknown>) ?? {};
    await insertAuditLog({
      actorType: input.actorType,
      actorId: input.actorId ?? null,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId ?? null,
      tenantId: input.tenantId ?? null,
      appId: input.appId ?? null,
      payloadRedacted: redacted,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
    });
  } catch (err) {
    logger().warn(
      { err, action: input.action, resource_type: input.resourceType },
      "audit log insert failed (non-blocking)",
    );
  }
}
