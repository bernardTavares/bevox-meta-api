import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { createApp, deactivateApp, listApps, rotateKey } from "./service.js";

const UuidV7 = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

const createBodySchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
});

const appIdParamSchema = z.object({ id: UuidV7 });

const rotateBodySchema = z
  .object({
    grace_window_days: z.number().int().min(1).max(60).optional(),
  })
  .optional();

export async function adminAppsRoutes(app: FastifyInstance): Promise<void> {
  app.post("/admin/apps", { preHandler: [app.requireAdminAuth()] }, async (req, reply) => {
    const body = createBodySchema.parse(req.body);
    const out = await createApp(body);
    return reply.status(201).send(out);
  });

  app.get("/admin/apps", { preHandler: [app.requireAdminAuth()] }, async () => {
    const items = await listApps();
    return { data: items };
  });

  app.post("/admin/apps/:id/keys/rotate", { preHandler: [app.requireAdminAuth()] }, async (req) => {
    const { id } = appIdParamSchema.parse(req.params);
    const body = rotateBodySchema.parse(req.body ?? {}) ?? {};
    return rotateKey({
      appId: id,
      graceWindowDays: body.grace_window_days,
    });
  });

  app.post("/admin/apps/:id/deactivate", { preHandler: [app.requireAdminAuth()] }, async (req) => {
    const { id } = appIdParamSchema.parse(req.params);
    return deactivateApp(id);
  });
}
