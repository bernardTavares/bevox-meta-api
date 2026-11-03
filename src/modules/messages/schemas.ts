import { z } from "zod";

const UuidV7 = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

const ChannelSchema = z.enum(["whatsapp", "instagram"]);

// Conteúdo do tipo `text`.
const TextContent = z.object({
  body: z.string().min(1).max(4096),
});

// Conteúdo do tipo `template` (WhatsApp). `components` segue formato Meta.
const TemplateContent = z.object({
  name: z.string().min(1).max(512),
  language: z.string().min(2).max(20),
  components: z.array(z.record(z.string(), z.unknown())).max(20).optional(),
});

// Conteúdo do tipo `image`.
const ImageContent = z.object({
  link: z.url().max(2048),
  caption: z.string().max(1024).optional(),
});

// Discriminated union por `type`.
export const sendMessageBodySchema = z
  .object({
    channel: ChannelSchema,
    to: z.string().min(1).max(64),
    /** Identificador do canal de origem. WhatsApp: meta_phone_id; Instagram: meta_ig_id (opcional, default = primeiro ativo do tenant). */
    from: z.string().min(1).max(64).optional(),
  })
  .and(
    z.discriminatedUnion("type", [
      z.object({ type: z.literal("text"), content: TextContent }),
      z.object({ type: z.literal("template"), content: TemplateContent }),
      z.object({ type: z.literal("image"), content: ImageContent }),
    ]),
  );

export type SendMessageBody = z.infer<typeof sendMessageBodySchema>;

export const tenantHeaderSchema = z.object({
  "x-tenant-id": UuidV7,
});

// Async: same body + callback fields.
export const enqueueMessageBodySchema = z
  .object({
    channel: ChannelSchema,
    to: z.string().min(1).max(64),
    from: z.string().min(1).max(64).optional(),
    callback_url: z.url().max(2048).optional(),
    callback_secret: z.string().min(8).max(256).optional(),
  })
  .and(
    z.discriminatedUnion("type", [
      z.object({ type: z.literal("text"), content: TextContent }),
      z.object({ type: z.literal("template"), content: TemplateContent }),
      z.object({ type: z.literal("image"), content: ImageContent }),
    ]),
  );

export type EnqueueMessageBody = z.infer<typeof enqueueMessageBodySchema>;

export const jobIdParamSchema = z.object({
  job_id: UuidV7,
});

export const messageIdParamSchema = z.object({
  message_id: UuidV7,
});

export interface MessageDetailResponse {
  message_id: string;
  provider_message_id: string | null;
  /**
   * Subset do enum OpenAPI `MessageSendResult.status`
   * (`queued | sent | delivered | read | failed`). Hoje persistimos só os
   * estados gerados pelo dispatcher (`queued | sent | failed`); `delivered`
   * e `read` virão quando reconciliarmos status updates do webhook na
   * tabela. Estados internos `sending | expired` são mapeados para
   * `queued | failed` respectivamente para manter o contrato.
   */
  status: "queued" | "sent" | "delivered" | "read" | "failed";
  error: { code: string; message: string } | null;
  sent_at: string | null;
}

export interface JobStatusResponse {
  job_id: string;
  status: "queued" | "sending" | "sent" | "failed" | "expired";
  channel: "whatsapp" | "instagram";
  attempts: number;
  provider_message_id: string | null;
  error: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface SendMessageResponse {
  message_id: string;
  provider_message_id: string;
  channel: "whatsapp" | "instagram";
  status: "sent" | "failed";
  error?: { code: string; message: string };
}
