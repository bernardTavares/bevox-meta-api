/**
 * Token bucket rate limiter atômico no Redis (PRD §5.11).
 *
 * Algoritmo: cada bucket guarda `{ tokens, last_refill_ms }`. Em cada
 * request:
 *   1. Calcula tokens repostos = (now - last_refill_ms) / 1000 * refill_per_sec
 *   2. tokens = min(capacity, tokens + reposto)
 *   3. se tokens >= 1: tokens -= 1, allow=true
 *      senão: allow=false, retry_after = ceil((1 - tokens) / refill_per_sec)
 *   4. PEXPIRE no key para garbage collection
 *
 * Tudo isso roda em um único Lua script — atômico, uma round-trip.
 */

import type { Redis } from "ioredis";

import { getRedis } from "./redis.js";

export interface RateLimitConfig {
  /** Capacity do balde — burst máximo permitido. */
  capacity: number;
  /** Tokens repostos por segundo. */
  refillPerSecond: number;
  /** Identificador do scope para headers + métricas. */
  scope: string;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Unix epoch (segundos) em que o balde estará cheio novamente. */
  resetAt: number;
  /** Segundos até a próxima requisição passar (apenas se `allowed=false`). */
  retryAfter: number;
  scope: string;
  limit: number;
}

const LUA_SCRIPT = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_per_sec = tonumber(ARGV[2])
local now_ms = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])

local data = redis.call("HMGET", key, "tokens", "ts")
local tokens = tonumber(data[1])
local last_ts = tonumber(data[2])

if tokens == nil then
  tokens = capacity
  last_ts = now_ms
end

local elapsed_sec = (now_ms - last_ts) / 1000
if elapsed_sec < 0 then elapsed_sec = 0 end
tokens = math.min(capacity, tokens + elapsed_sec * refill_per_sec)

local allowed = 0
local retry_ms = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  local needed = cost - tokens
  retry_ms = math.ceil((needed / refill_per_sec) * 1000)
end

redis.call("HMSET", key, "tokens", tokens, "ts", now_ms)
-- Expira o balde quando estaria cheio (capacity / refill_per_sec) + folga.
local expire_ms = math.ceil((capacity / refill_per_sec) * 1000) + 5000
redis.call("PEXPIRE", key, expire_ms)

return { allowed, tokens, retry_ms }
`;

interface RawResult {
  allowed: number;
  tokens: number;
  retryMs: number;
}

async function evalScript(
  redis: Redis,
  key: string,
  cfg: RateLimitConfig,
  cost: number,
): Promise<RawResult> {
  const now = Date.now();
  const result = (await redis.eval(
    LUA_SCRIPT,
    1,
    key,
    String(cfg.capacity),
    String(cfg.refillPerSecond),
    String(now),
    String(cost),
  )) as [number, number | string, number | string];

  return {
    allowed: result[0],
    tokens: typeof result[1] === "string" ? Number.parseFloat(result[1]) : result[1],
    retryMs: typeof result[2] === "string" ? Number.parseFloat(result[2]) : result[2],
  };
}

/**
 * Tenta consumir `cost` tokens (default 1) do bucket identificado por `key`.
 * Retorna decisão + metadados para headers HTTP.
 */
export async function consumeToken(
  key: string,
  cfg: RateLimitConfig,
  cost = 1,
): Promise<RateLimitResult> {
  const raw = await evalScript(getRedis(), key, cfg, cost);
  const remaining = Math.max(0, Math.floor(raw.tokens));
  const tokensMissing = Math.max(0, cfg.capacity - raw.tokens);
  const refillMs = Math.ceil((tokensMissing / cfg.refillPerSecond) * 1000);

  return {
    allowed: raw.allowed === 1,
    remaining,
    limit: cfg.capacity,
    scope: cfg.scope,
    resetAt: Math.ceil((Date.now() + refillMs) / 1000),
    retryAfter: Math.max(0, Math.ceil(raw.retryMs / 1000)),
  };
}

// ---------------------------------------------------------------------------
// Configurações default (PRD §5.11 + spec da task #9).
// Permitem override por app/tenant em config futura (admin endpoint).
// ---------------------------------------------------------------------------

export const DEFAULT_APP_LIMIT: RateLimitConfig = {
  capacity: 1000,
  refillPerSecond: 1000 / 60, // 1000/min
  scope: "app",
};

export const DEFAULT_TENANT_LIMIT: RateLimitConfig = {
  capacity: 100,
  refillPerSecond: 100 / 60, // 100/min
  scope: "tenant",
};

export const DEFAULT_WABA_LIMIT: RateLimitConfig = {
  // Tier 1K conversations/24h da Meta — bem mais permissivo no minute window
  // mas com burst limitado.
  capacity: 80,
  refillPerSecond: 1000 / (24 * 3600),
  scope: "waba",
};

export function appKey(appId: string): string {
  return `rl:app:${appId}`;
}
export function tenantKey(tenantId: string): string {
  return `rl:tenant:${tenantId}`;
}
export function wabaKey(wabaId: string): string {
  return `rl:waba:${wabaId}`;
}
