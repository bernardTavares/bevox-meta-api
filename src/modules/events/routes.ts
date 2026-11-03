/**
 * GET /v1/events/stream — SSE realtime para consumer apps.
 *
 *   - Auth: JWT consumer com scope events:read.
 *   - Filtro: opcional por X-Tenant-Id (limita ao tenant; senão recebe
 *     eventos do app inteiro).
 *   - Cursor: ?cursor=<event_id> faz replay desde aquele id antes de
 *     começar o stream realtime.
 *   - Heartbeat: comentário SSE `: ping` a cada 30s.
 *   - Backpressure: se o cliente fica lento, encerra para não acumular.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { createEventSubscriber, type EventBusMessage } from "@/lib/event-bus.js";
import { logger } from "@/lib/logger.js";

import { ackEvents, listEventsForPolling, listEventsForReplay } from "./repository.js";

const UuidV7 = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

const querySchema = z.object({
  cursor: UuidV7.optional(),
});

const headerSchema = z.object({
  "x-tenant-id": UuidV7.optional(),
});

const HEARTBEAT_MS = 30_000;
const REPLAY_LIMIT = 500;

function formatSse(event: { id: string; type: string; data: unknown }): string {
  const payload = JSON.stringify(event.data);
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${payload}\n\n`;
}

export async function eventsRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/v1/events/stream",
    {
      preHandler: [app.requireAuth({ scopes: ["events:read"] }), app.requireRateLimit()],
    },
    async (req, reply) => {
      const query = querySchema.parse(req.query);
      const headers = headerSchema.parse({
        "x-tenant-id": req.headers["x-tenant-id"],
      });
      const tenantFilter = headers["x-tenant-id"];
      const appId = req.auth!.appId;

      // Headers SSE.
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      reply.raw.write(`retry: 5000\n\n`);

      const writeEvent = (id: string, type: string, data: unknown): boolean => {
        if (reply.raw.writableEnded) return false;
        return reply.raw.write(formatSse({ id, type, data }));
      };

      // 1. Replay (se cursor fornecido).
      if (query.cursor) {
        const rows = await listEventsForReplay({
          appId,
          tenantId: tenantFilter,
          cursor: query.cursor,
          limit: REPLAY_LIMIT,
        });
        for (const row of rows) {
          writeEvent(row.id, row.eventType, {
            event_id: row.id,
            event_type: row.eventType,
            tenant_id: row.tenantId,
            occurred_at: row.receivedAt.toISOString(),
            data: row.payloadJson,
          });
        }
      }

      // 2. Subscribe pub/sub.
      const { subscriber, channel } = createEventSubscriber(appId);
      await subscriber.subscribe(channel);

      const onMessage = (_ch: string, msg: string) => {
        try {
          const evt = JSON.parse(msg) as EventBusMessage;
          if (tenantFilter && evt.tenant_id !== tenantFilter) return;
          writeEvent(evt.event_id, evt.event_type, evt);
        } catch (err) {
          logger().warn({ err, request_id: req.id }, "SSE: malformed event-bus message");
        }
      };
      subscriber.on("message", onMessage);

      // 3. Heartbeat.
      const heartbeat = setInterval(() => {
        if (reply.raw.writableEnded) return;
        reply.raw.write(`: ping ${Date.now()}\n\n`);
      }, HEARTBEAT_MS);

      // 4. Cleanup ao fechar.
      const cleanup = async () => {
        clearInterval(heartbeat);
        try {
          await subscriber.unsubscribe(channel);
        } catch {
          // ignore
        }
        try {
          await subscriber.quit();
        } catch {
          // ignore
        }
      };

      req.raw.on("close", () => {
        void cleanup();
      });
      reply.raw.on("close", () => {
        void cleanup();
      });

      // Não retornar nada — Fastify entende como hijack quando usamos reply.raw.
      return reply;
    },
  );

  // ----- GET /v1/events — polling (fallback para consumers sem SSE/webhook)
  const pollQuerySchema = z.object({
    since: UuidV7.optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
    include_acked: z
      .union([z.boolean(), z.enum(["true", "false"])])
      .transform((v) => v === true || v === "true")
      .default(false),
  });

  app.get(
    "/v1/events",
    {
      preHandler: [app.requireAuth({ scopes: ["events:read"] }), app.requireRateLimit()],
    },
    async (req) => {
      const query = pollQuerySchema.parse(req.query);
      const headers = headerSchema.parse({
        "x-tenant-id": req.headers["x-tenant-id"],
      });

      const rows = await listEventsForPolling({
        appId: req.auth!.appId,
        tenantId: headers["x-tenant-id"],
        since: query.since,
        limit: query.limit,
        undispatchedOnly: !query.include_acked,
      });

      const data = rows.map((r) => ({
        event_id: r.id,
        event_type: r.eventType,
        tenant_id: r.tenantId,
        occurred_at: r.receivedAt.toISOString(),
        dispatched_at: r.dispatchedAt?.toISOString() ?? null,
        data: r.payloadJson,
      }));

      const nextCursor = rows.length === query.limit ? (rows[rows.length - 1]!.id ?? null) : null;
      return { data, next_cursor: nextCursor };
    },
  );

  // ----- POST /v1/events/ack — marca eventos como acknowledged
  const ackBodySchema = z.object({
    event_ids: z.array(UuidV7).min(1).max(500),
  });

  app.post(
    "/v1/events/ack",
    {
      preHandler: [
        app.requireAuth({ scopes: ["events:read"] }),
        app.requireRateLimit(),
        app.requireIdempotency(),
      ],
    },
    async (req) => {
      const body = ackBodySchema.parse(req.body);
      const acked = await ackEvents(req.auth!.appId, body.event_ids);
      return { acked, requested: body.event_ids.length };
    },
  );
}
