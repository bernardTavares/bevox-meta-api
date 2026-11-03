import { z } from "zod";

const UuidV7 = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

export const createSubscriptionBodySchema = z.object({
  // V1 implementa apenas push. SSE/polling não criam subscription rows
  // (consumers ligam direto nos endpoints /v1/events/stream e /v1/events).
  delivery_mode: z.literal("push"),
  url: z.url().max(2048).startsWith("https://", "URL must use https://"),
  tenant_id: UuidV7.optional(),
  event_types_filter: z.array(z.string().min(1).max(64)).max(50).optional(),
});

export type CreateSubscriptionBody = z.infer<typeof createSubscriptionBodySchema>;

export const subscriptionIdParamSchema = z.object({
  id: UuidV7,
});

export interface SubscriptionResponse {
  id: string;
  app_id: string;
  tenant_id: string | null;
  delivery_mode: "push";
  url: string;
  event_types_filter: string[];
  status: "active" | "paused" | "disabled";
  created_at: string;
}

export interface CreateSubscriptionResponse extends SubscriptionResponse {
  /** Retornado APENAS na criação. Nunca exposto novamente. */
  signing_secret: string;
}
