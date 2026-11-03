import { z } from "zod";

const UuidV7 = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

export const tenantIdParamSchema = z.object({
  tenant_id: UuidV7,
});

export const initOAuthBodySchema = z.object({
  // URL para onde o consumer app quer mandar o usuário final após o
  // callback Meta + nosso processamento.
  redirect_url: z.url().max(2048),
});

export type InitOAuthBody = z.infer<typeof initOAuthBodySchema>;

export interface InitOAuthResponse {
  oauth_url: string;
  state: string;
  expires_in_seconds: number;
  config_id?: string;
  /** Meta App ID (público) — front usa em FB.init({ appId }). */
  meta_app_id?: string;
  /** Versão do Graph API (ex.: "v21.0") — front usa em FB.init({ version }). */
  graph_version?: string;
}

// Callback (Meta nos chama via redirect)
export const oauthCallbackQuerySchema = z.object({
  code: z.string().min(1).max(2048).optional(),
  state: z.string().min(1).max(200),
  // Meta pode retornar erro user-cancel
  error: z.string().optional(),
  error_description: z.string().optional(),
  error_reason: z.string().optional(),
});

export type OAuthCallbackQuery = z.infer<typeof oauthCallbackQuerySchema>;

export const embeddedSignupCompleteBodySchema = z.object({
  code: z.string().min(1).max(2048),
  waba_id: z.string().min(1).max(64).optional(),
  phone_number_id: z.string().min(1).max(64).optional(),
  /** business_id do session info do widget — fallback para o owner da WABA. */
  business_id: z.string().min(1).max(64).optional(),
  /** COEX: número já roda no app WhatsApp Business e passa a rodar na Cloud API. */
  coexistence: z.boolean().optional().default(false),
});

export type EmbeddedSignupCompleteBody = z.infer<typeof embeddedSignupCompleteBodySchema>;

// ----- List + Disconnect -----

export const listWabasQuerySchema = z.object({
  include_disconnected: z
    .union([z.boolean(), z.enum(["true", "false"])])
    .transform((v) => v === true || v === "true")
    .default(false),
});

export const wabaIdParamSchema = z.object({
  tenant_id: UuidV7,
  waba_id: UuidV7,
});

export interface WabaConnectionResponse {
  id: string;
  tenant_id: string;
  meta_business_id: string;
  meta_waba_id: string;
  display_name: string | null;
  verified_status: string | null;
  created_at: string;
  updated_at: string;
  disconnected_at: string | null;
}
