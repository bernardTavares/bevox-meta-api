/**
 * Repository de OutboundJob — persiste cada envio (sent ou failed).
 * Plaintext do payload NÃO entra aqui — só metadados redacted.
 */

import { and, eq, sql } from "drizzle-orm";

import { outboundJobs, type OutboundJob } from "@db/schema/index.js";

import { getDb } from "@/db/client.js";

export interface CreateOutboundJobInput {
  tenantId: string;
  appId: string;
  idempotencyKey: string;
  channel: "whatsapp" | "instagram";
  payloadJson: Record<string, unknown>;
  status: "sent" | "failed";
  attempts: number;
  providerMessageId: string | null;
  lastError: string | null;
  completedAt: Date;
}

export async function insertQueuedJob(input: {
  tenantId: string;
  appId: string;
  idempotencyKey: string;
  channel: "whatsapp" | "instagram";
  payloadJson: Record<string, unknown>;
}): Promise<OutboundJob> {
  const [row] = await getDb()
    .insert(outboundJobs)
    .values({
      tenantId: input.tenantId,
      appId: input.appId,
      idempotencyKey: input.idempotencyKey,
      channel: input.channel,
      payloadJson: input.payloadJson,
      status: "queued",
      attempts: 0,
    })
    .returning();
  if (!row) throw new Error("outbound_job insert returned no row");
  return row;
}

export async function findOutboundJob(appId: string, jobId: string): Promise<OutboundJob | null> {
  const rows = await getDb()
    .select()
    .from(outboundJobs)
    .where(and(eq(outboundJobs.appId, appId), eq(outboundJobs.id, jobId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function updateJobStatus(
  jobId: string,
  patch: {
    status: "queued" | "sending" | "sent" | "failed" | "expired";
    attempts?: number;
    providerMessageId?: string | null;
    lastError?: string | null;
    completedAt?: Date | null;
  },
): Promise<OutboundJob | null> {
  const setObj: Record<string, unknown> = { status: patch.status };
  if (patch.attempts !== undefined) setObj.attempts = patch.attempts;
  if (patch.providerMessageId !== undefined) setObj.providerMessageId = patch.providerMessageId;
  if (patch.lastError !== undefined) setObj.lastError = patch.lastError;
  if (patch.completedAt !== undefined) setObj.completedAt = patch.completedAt;
  const [row] = await getDb()
    .update(outboundJobs)
    .set(setObj)
    .where(eq(outboundJobs.id, jobId))
    .returning();
  return row ?? null;
}

export async function incrementAttempts(jobId: string): Promise<void> {
  await getDb()
    .update(outboundJobs)
    .set({ attempts: sql`${outboundJobs.attempts} + 1` })
    .where(eq(outboundJobs.id, jobId));
}

export async function insertOutboundJob(input: CreateOutboundJobInput): Promise<OutboundJob> {
  const [row] = await getDb()
    .insert(outboundJobs)
    .values({
      tenantId: input.tenantId,
      appId: input.appId,
      idempotencyKey: input.idempotencyKey,
      channel: input.channel,
      payloadJson: input.payloadJson,
      status: input.status,
      attempts: input.attempts,
      providerMessageId: input.providerMessageId,
      lastError: input.lastError,
      completedAt: input.completedAt,
    })
    .returning();
  if (!row) throw new Error("outbound_job insert returned no row");
  return row;
}
