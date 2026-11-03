/**
 * Worker cron — refresh de tokens Meta (PRD §5.12, ADR MA-008 §rotação).
 *
 * Loop: a cada 6h busca WabaToken não-superseded com expires_at < now+7d.
 * Para cada um:
 *   1. Decifra plaintext via envelope.
 *   2. Chama Meta /oauth/access_token grant_type=fb_exchange_token.
 *   3. Cifra novo token + replaceWabaToken (txn supersede + insert).
 *   4. Em falha: retry até 3x. Se esgotar, markWabaDisconnected + publish
 *      evento `waba.connection_changed` para SSE/webhooks consumers.
 *
 * V1: apenas WABA. IG quando o resolver IG ficar pronto.
 */

import { publishEvent } from "@/lib/event-bus.js";
import { encryptToken } from "@/lib/crypto-envelope.js";
import { errors, isAppError } from "@/lib/errors.js";
import { logger } from "@/lib/logger.js";
import { workerJobsTotal } from "@/lib/metrics.js";
import { closeRedis } from "@/lib/redis.js";
import { installShutdownHandlers, registerShutdownHook } from "@/lib/shutdown.js";
import { startWorkerMetricsServer } from "@/lib/worker-metrics-server.js";
import { getMetaOAuthClient } from "@/integration/meta-client.js";

const WORKER_NAME = "token-refresh";
import {
  listExpiringWabaTokens,
  markWabaDisconnected,
  replaceWabaToken,
} from "@/modules/wabas/repository.js";
import { resolveActiveWabaToken } from "@/modules/wabas/token-resolver.js";

const WABA_KEK_ID = "bevox-meta-api/waba-tokens/v1";
const REFRESH_WINDOW_DAYS = 7;
const TOKEN_DEFAULT_TTL_SEC = 60 * 24 * 3600; // 60 dias
const REFRESH_GRACE_BEFORE_SEC = 7 * 24 * 3600;
const POLL_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h
const MAX_ATTEMPTS = 3;

export interface RefreshOutcome {
  tokenId: string;
  wabaConnectionId: string;
  status: "refreshed" | "failed" | "disconnected";
  error?: string;
}

export async function refreshOneToken(
  token: {
    id: string;
    wabaConnectionId: string;
    encryptionContext: Record<string, string>;
  },
  opts: { backoffBaseMs?: number; maxAttempts?: number } = {},
): Promise<RefreshOutcome> {
  const backoffBase = opts.backoffBaseMs ?? 1000;
  const maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS;
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const current = await resolveActiveWabaToken(token.wabaConnectionId);
      const meta = getMetaOAuthClient();
      const exchanged = await meta.exchangeLongLivedToken(current.accessToken);

      const ttlSec = exchanged.expires_in ?? TOKEN_DEFAULT_TTL_SEC;
      const expiresAt = new Date(Date.now() + ttlSec * 1000);
      const refreshAt = new Date(
        Date.now() + Math.max(60, ttlSec - REFRESH_GRACE_BEFORE_SEC) * 1000,
      );

      const buf = Buffer.from(exchanged.access_token, "utf8");
      let envelope;
      try {
        envelope = await encryptToken(buf, WABA_KEK_ID, token.encryptionContext);
      } finally {
        buf.fill(0);
      }
      await replaceWabaToken({
        oldTokenId: token.id,
        wabaConnectionId: token.wabaConnectionId,
        envelope,
        expiresAt,
        refreshAt,
      });
      return {
        tokenId: token.id,
        wabaConnectionId: token.wabaConnectionId,
        status: "refreshed",
      };
    } catch (err) {
      lastError = err;
      // Retryable apenas se META_UNAVAILABLE; META_REJECTED é terminal.
      const retryable =
        isAppError(err) && (err.code === "META_UNAVAILABLE" || err.code === "RATE_LIMITED");
      if (!retryable) break;
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, backoffBase * 2 ** attempt));
      }
    }
  }

  // Esgotou — disconnect + publish evento.
  await markWabaDisconnected(token.wabaConnectionId);

  const ctx = token.encryptionContext;
  try {
    await publishEvent({
      event_id: `${token.id}:refresh-failed`,
      event_type: "waba.connection_changed",
      app_id: ctx.app_id ?? "unknown",
      tenant_id: ctx.tenant_id ?? null,
      occurred_at: new Date().toISOString(),
      data: {
        waba_connection_id: token.wabaConnectionId,
        status: "disconnected",
        reason: "token_refresh_exhausted",
      },
    });
  } catch (err) {
    logger().warn(
      { err, waba_connection_id: token.wabaConnectionId },
      "publishEvent for refresh failure failed (non-blocking)",
    );
  }

  return {
    tokenId: token.id,
    wabaConnectionId: token.wabaConnectionId,
    status: "disconnected",
    error: lastError instanceof Error ? lastError.message : String(lastError),
  };
}

export async function refreshDueTokens(now: Date = new Date()): Promise<RefreshOutcome[]> {
  const before = new Date(now.getTime() + REFRESH_WINDOW_DAYS * 24 * 3600 * 1000);
  const tokens = await listExpiringWabaTokens(before);
  const results: RefreshOutcome[] = [];
  for (const t of tokens) {
    try {
      const outcome = await refreshOneToken({
        id: t.id,
        wabaConnectionId: t.wabaConnectionId,
        encryptionContext: t.encryptionContext as Record<string, string>,
      });
      results.push(outcome);
    } catch (err) {
      logger().error({ err, token_id: t.id }, "refresh worker: unexpected exception");
      results.push({
        tokenId: t.id,
        wabaConnectionId: t.wabaConnectionId,
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}

let intervalHandle: NodeJS.Timeout | null = null;

export function startTokenRefreshWorker(): void {
  const tick = async () => {
    try {
      const results = await refreshDueTokens();
      workerJobsTotal.inc({ worker: WORKER_NAME, outcome: "ok" });
      logger().info({ refreshed: results.length }, "token refresh tick complete");
    } catch (err) {
      workerJobsTotal.inc({ worker: WORKER_NAME, outcome: "failed" });
      logger().error({ err }, "token refresh tick failed");
    }
  };
  // Roda já no boot e depois a cada POLL_INTERVAL_MS.
  void tick();
  intervalHandle = setInterval(() => void tick(), POLL_INTERVAL_MS);
  registerShutdownHook("token-refresh-worker", () => {
    if (intervalHandle) {
      clearInterval(intervalHandle);
      intervalHandle = null;
    }
  });
}

const isMain =
  typeof process.argv[1] === "string" && /token-refresh\.(ts|js)$/.test(process.argv[1]);

if (isMain) {
  installShutdownHandlers();
  registerShutdownHook("redis", () => closeRedis());
  void startWorkerMetricsServer({ workerName: WORKER_NAME }).catch((err) => {
    logger().error({ err }, "failed to start worker metrics server");
  });
  startTokenRefreshWorker();
  logger().info("token-refresh worker started");
}

void errors;
