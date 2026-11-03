/**
 * Drizzle schema barrel — entrypoint para drizzle-kit.
 *
 * Re-exporta todas as tabelas, enums e tipos das 15 entidades do PRD §8.
 * RateLimitBucket vive em Redis (não tem schema PG).
 */

export * from "./_shared.js";
export * from "./identity.js";
export * from "./tenancy.js";
export * from "./bindings.js";
export * from "./templates.js";
export * from "./operations.js";
export * from "./idempotency.js";
export * from "./audit.js";
