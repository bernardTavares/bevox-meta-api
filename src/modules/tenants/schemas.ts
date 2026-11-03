/**
 * Schemas Zod para o módulo Tenants — input e output.
 *
 * Estes são a fonte canônica do contrato HTTP do recurso. OpenAPI será
 * gerado a partir deles (task de OpenAPI separada).
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Tipos compartilhados
// ---------------------------------------------------------------------------

const UuidV7 = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, {
    message: "Must be a UUIDv7",
  });

export const TenantStatusSchema = z.enum(["active", "disabled", "deleted"]);

// ---------------------------------------------------------------------------
// Body schemas
// ---------------------------------------------------------------------------

export const createTenantBodySchema = z.object({
  external_id: z.string().min(1).max(200).optional(),
  display_name: z.string().min(1).max(200),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type CreateTenantBody = z.infer<typeof createTenantBodySchema>;

export const updateTenantBodySchema = z
  .object({
    display_name: z.string().min(1).max(200).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    status: z.enum(["active", "disabled"]).optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: "At least one field must be provided",
  });

export type UpdateTenantBody = z.infer<typeof updateTenantBodySchema>;

// ---------------------------------------------------------------------------
// Query schemas
// ---------------------------------------------------------------------------

export const listTenantsQuerySchema = z.object({
  external_id: z.string().min(1).max(200).optional(),
  cursor: UuidV7.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  include_deleted: z
    .union([z.boolean(), z.enum(["true", "false"])])
    .transform((v) => v === true || v === "true")
    .default(false),
});

export type ListTenantsQuery = z.infer<typeof listTenantsQuerySchema>;

// ---------------------------------------------------------------------------
// Param schema
// ---------------------------------------------------------------------------

export const tenantIdParamSchema = z.object({
  tenant_id: UuidV7,
});

// ---------------------------------------------------------------------------
// Response shape (não validado em runtime, mas tipado)
// ---------------------------------------------------------------------------

export interface TenantResponse {
  id: string;
  external_id: string | null;
  display_name: string;
  status: z.infer<typeof TenantStatusSchema>;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface ListTenantsResponse {
  items: TenantResponse[];
  next_cursor: string | null;
}
