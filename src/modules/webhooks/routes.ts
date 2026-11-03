import type { FastifyInstance } from "fastify";

import { createSubscriptionBodySchema, subscriptionIdParamSchema } from "./schemas.js";
import {
  createSubscription,
  disableSubscription,
  listSubscriptions,
  replayDeadLetters,
} from "./service.js";

export async function webhooksRoutes(app: FastifyInstance): Promise<void> {
  // ----- POST /v1/webhooks/subscriptions -----
  app.post(
    "/v1/webhooks/subscriptions",
    {
      preHandler: [
        app.requireAuth({ scopes: ["webhooks:write"] }),
        app.requireRateLimit(),
        app.requireIdempotency(),
      ],
    },
    async (req, reply) => {
      const body = createSubscriptionBodySchema.parse(req.body);
      const out = await createSubscription({ appId: req.auth!.appId, body });
      return reply.status(201).send(out);
    },
  );

  // ----- GET /v1/webhooks/subscriptions -----
  app.get(
    "/v1/webhooks/subscriptions",
    {
      preHandler: [app.requireAuth({ scopes: ["webhooks:read"] }), app.requireRateLimit()],
    },
    async (req) => {
      const items = await listSubscriptions(req.auth!.appId);
      return { data: items };
    },
  );

  // ----- DELETE /v1/webhooks/subscriptions/:id -----
  app.delete(
    "/v1/webhooks/subscriptions/:id",
    {
      preHandler: [
        app.requireAuth({ scopes: ["webhooks:write"] }),
        app.requireRateLimit(),
        app.requireIdempotency(),
      ],
    },
    async (req) => {
      const { id } = subscriptionIdParamSchema.parse(req.params);
      return disableSubscription(req.auth!.appId, id);
    },
  );

  // ----- POST /admin/subscriptions/:id/replay -----
  app.post(
    "/admin/subscriptions/:id/replay",
    {
      preHandler: [app.requireAdminAuth()],
    },
    async (req) => {
      const { id } = subscriptionIdParamSchema.parse(req.params);
      return replayDeadLetters(id);
    },
  );
}
