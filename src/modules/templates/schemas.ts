import { z } from "zod";

const UuidV7 = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

// V1: nome WhatsApp templates segue convenção snake_case_letters_digits, ≤ 512.
const TemplateName = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[a-z0-9_]+$/, "name must be lowercase alphanumeric with underscores");

const Language = z.string().min(2).max(20);

export const TemplateCategorySchema = z.enum(["UTILITY", "MARKETING", "AUTHENTICATION"]);
export const TemplateStatusSchema = z.enum([
  "PENDING",
  "APPROVED",
  "REJECTED",
  "PAUSED",
  "DISABLED",
]);

export const wabaParamsSchema = z.object({
  tenant_id: UuidV7,
  waba_id: UuidV7,
});

export const templateParamsSchema = wabaParamsSchema.extend({
  name: TemplateName,
  language: Language,
});

// V1: validação básica de components — Meta valida o conteúdo detalhado.
// Aceita array de objetos com `type` em {HEADER, BODY, FOOTER, BUTTONS}.
const componentSchema = z
  .object({
    type: z.enum(["HEADER", "BODY", "FOOTER", "BUTTONS"]),
  })
  .passthrough();

export const createTemplateBodySchema = z.object({
  name: TemplateName,
  language: Language,
  category: TemplateCategorySchema,
  components: z.array(componentSchema).min(1).max(10),
});

export type CreateTemplateBody = z.infer<typeof createTemplateBodySchema>;

export const listTemplatesQuerySchema = z.object({
  status: TemplateStatusSchema.optional(),
  language: Language.optional(),
});

export interface TemplateResponse {
  id: string;
  waba_connection_id: string;
  name: string;
  language: string;
  category: z.infer<typeof TemplateCategorySchema>;
  status: z.infer<typeof TemplateStatusSchema>;
  quality_score: number | null;
  components: unknown[];
  created_at: string;
  updated_at: string;
  last_synced_at: string;
}
