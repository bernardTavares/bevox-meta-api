/**
 * Scopes do bevox-meta-api — referenciados por JWTs de consumer apps.
 *
 * Cada endpoint anota o scope mínimo exigido. O plugin `auth-jwt-consumer`
 * preenche `request.auth.scopes` a partir do claim `scope` do JWT e
 * `requireAuth({ scopes })` valida no preHandler.
 */

export const SCOPES = [
  // Tenants
  "tenants:read",
  "tenants:write",
  // Bindings Meta
  "wabas:read",
  "wabas:write",
  "ig:read",
  "ig:write",
  "phone-numbers:read",
  "phone-numbers:write",
  // Templates
  "templates:read",
  "templates:write",
  // Mensagens
  "messages:write",
  // Webhooks
  "webhooks:read",
  "webhooks:write",
  // Realtime events
  "events:read",
  // Mídia inbound (fetch de objetos baixados)
  "media:read",
  // Audit (consultivo)
  "audit:read",
] as const;

export type Scope = (typeof SCOPES)[number];

const SCOPE_SET = new Set<string>(SCOPES);

export function isValidScope(s: string): s is Scope {
  return SCOPE_SET.has(s);
}

/**
 * Parseia claim `scope` (string space-separated, OAuth 2.0 idiom).
 * Tokens desconhecidos são silenciosamente descartados — não falha auth.
 */
export function parseScopes(claim: unknown): Scope[] {
  if (typeof claim !== "string" || claim.length === 0) return [];
  return claim
    .split(/\s+/)
    .filter((s) => s.length > 0)
    .filter(isValidScope);
}

/**
 * Verifica se o set de scopes do token cobre o conjunto exigido.
 */
export function hasAllScopes(have: readonly Scope[], required: readonly Scope[]): boolean {
  if (required.length === 0) return true;
  const set = new Set(have);
  return required.every((s) => set.has(s));
}
