import { z } from "zod";

const UuidV7 = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

/** Header X-Tenant-Id — tenant-scoped, igual aos demais endpoints de consumer. */
export const tenantHeaderSchema = z.object({
  "x-tenant-id": UuidV7,
});

/**
 * `media_key` = media_id da Meta. Caracteres seguros (validação adicional de
 * path-traversal acontece em `mediaObjectKey`). Limite generoso de tamanho.
 */
export const mediaParamSchema = z.object({
  media_key: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[A-Za-z0-9._:-]+$/, "invalid media_key"),
});

export type MediaParam = z.infer<typeof mediaParamSchema>;
