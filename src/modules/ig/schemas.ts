import { z } from "zod";

const UuidV7 = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

export const tenantIdParamSchema = z.object({ tenant_id: UuidV7 });

export const igIdParamSchema = z.object({
  tenant_id: UuidV7,
  ig_id: UuidV7,
});

export const initOAuthBodySchema = z.object({
  redirect_url: z.url().max(2048),
});
export type InitOAuthBody = z.infer<typeof initOAuthBodySchema>;

export const oauthCallbackQuerySchema = z.object({
  code: z.string().min(1).max(2048).optional(),
  state: z.string().min(1).max(200),
  error: z.string().optional(),
  error_description: z.string().optional(),
  error_reason: z.string().optional(),
});

export const listIgsQuerySchema = z.object({
  include_disconnected: z
    .union([z.boolean(), z.enum(["true", "false"])])
    .transform((v) => v === true || v === "true")
    .default(false),
});

export interface InitOAuthResponse {
  oauth_url: string;
  state: string;
  expires_in_seconds: number;
}

export interface IgConnectionResponse {
  id: string;
  tenant_id: string;
  meta_ig_id: string;
  username: string;
  account_type: string | null;
  created_at: string;
  updated_at: string;
  disconnected_at: string | null;
}
