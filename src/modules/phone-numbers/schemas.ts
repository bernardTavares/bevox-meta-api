import { z } from "zod";

const UuidV7 = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

export const phoneListParamSchema = z.object({
  tenant_id: UuidV7,
  waba_id: UuidV7,
});

export const phoneProfileParamSchema = z.object({
  tenant_id: UuidV7,
  waba_id: UuidV7,
  phone_id: z.string().min(1).max(64),
});

export const updateProfileBodySchema = z
  .object({
    about: z.string().max(139).optional(),
    description: z.string().max(512).optional(),
    email: z.email().max(128).optional(),
    websites: z.array(z.url().max(256)).max(2).optional(),
    profile_picture_url: z.url().max(2048).optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: "At least one field must be provided",
  });

export type UpdateProfileBody = z.infer<typeof updateProfileBodySchema>;

export interface PhoneNumberResponse {
  id: string;
  meta_phone_id: string;
  display_phone_number: string;
  verified_name: string | null;
  quality_rating: string | null;
  messaging_limit_tier: string | null;
}
