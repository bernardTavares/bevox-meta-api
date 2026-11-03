import type { FastifyInstance } from "fastify";

import { errors } from "@/lib/errors.js";

import {
  enqueueMessageBodySchema,
  jobIdParamSchema,
  messageIdParamSchema,
  sendMessageBodySchema,
  tenantHeaderSchema,
} from "./schemas.js";
import { enqueueMessage, getJobStatus, getMessage, sendMessage } from "./service.js";

export async function messagesRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/v1/messages",
    {
      preHandler: [
        app.requireAuth({ scopes: ["messages:write"] }),
        app.requireRateLimit(),
        app.requireIdempotency(),
      ],
    },
    async (req) => {
      const headers = tenantHeaderSchema.parse({
        "x-tenant-id": req.headers["x-tenant-id"],
      });
      const body = sendMessageBodySchema.parse(req.body);

      // idempotency-key foi validada pelo plugin; recuperamos para audit.
      const idemKey = req.headers["idempotency-key"];
      if (typeof idemKey !== "string") {
        // Defesa em profundidade — plugin já garante.
        throw errors.internal("idempotency-key missing after middleware");
      }

      return sendMessage({
        appId: req.auth!.appId,
        tenantId: headers["x-tenant-id"],
        idempotencyKey: idemKey,
        body,
      });
    },
  );

  // ----- POST /v1/messages/async -----
  app.post(
    "/v1/messages/async",
    {
      preHandler: [
        app.requireAuth({ scopes: ["messages:write"] }),
        app.requireRateLimit(),
        app.requireIdempotency(),
      ],
    },
    async (req, reply) => {
      const headers = tenantHeaderSchema.parse({
        "x-tenant-id": req.headers["x-tenant-id"],
      });
      const body = enqueueMessageBodySchema.parse(req.body);
      const idemKey = req.headers["idempotency-key"];
      if (typeof idemKey !== "string") {
        throw errors.internal("idempotency-key missing after middleware");
      }
      const result = await enqueueMessage({
        appId: req.auth!.appId,
        tenantId: headers["x-tenant-id"],
        idempotencyKey: idemKey,
        body,
      });
      return reply.status(202).send(result);
    },
  );

  // ----- GET /v1/jobs/:job_id -----
  app.get(
    "/v1/jobs/:job_id",
    {
      preHandler: [app.requireAuth({ scopes: ["messages:write"] }), app.requireRateLimit()],
    },
    async (req) => {
      const { job_id } = jobIdParamSchema.parse(req.params);
      return getJobStatus(req.auth!.appId, job_id);
    },
  );

  // ----- GET /v1/messages/:message_id -----
  // A11 (audit 2026-06-02): OpenAPI declara o endpoint; antes só existia
  // stub 501. Agora resolvido contra outbound_jobs (id == message_id) com
  // scoping por app_id no repository (defesa contra IDOR — outro app
  // recebe 404 igual a "não existe", indistinguível). O service mapeia o
  // status interno (`queued|sending|sent|failed|expired`) para o enum
  // público da spec MessageSendResult (`queued|sent|delivered|read|failed`).
  app.get(
    "/v1/messages/:message_id",
    {
      preHandler: [app.requireAuth({ scopes: ["messages:write"] }), app.requireRateLimit()],
    },
    async (req) => {
      const { message_id } = messageIdParamSchema.parse(req.params);
      return getMessage(req.auth!.appId, message_id);
    },
  );
}
