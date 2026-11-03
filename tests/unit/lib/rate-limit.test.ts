import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Fake Redis com suporte a HMGET/HMSET/PEXPIRE/EVAL — só o necessário para
// rodar o Lua script do consumeToken. Implementamos o algoritmo em JS pra
// ficar fiel sem precisar de redis-mock.
// ---------------------------------------------------------------------------

const store = vi.hoisted(() => ({
  buckets: new Map<string, { tokens: number; ts: number; expiresAt: number }>(),
}));

function evalRateLimit(
  key: string,
  capacity: number,
  refillPerSec: number,
  nowMs: number,
  cost: number,
): [number, number, number] {
  const existing = store.buckets.get(key);
  let tokens: number;
  let lastTs: number;
  if (existing && existing.expiresAt > nowMs) {
    tokens = existing.tokens;
    lastTs = existing.ts;
  } else {
    tokens = capacity;
    lastTs = nowMs;
  }
  const elapsedSec = Math.max(0, (nowMs - lastTs) / 1000);
  tokens = Math.min(capacity, tokens + elapsedSec * refillPerSec);

  let allowed = 0;
  let retryMs = 0;
  if (tokens >= cost) {
    tokens -= cost;
    allowed = 1;
  } else {
    const needed = cost - tokens;
    retryMs = Math.ceil((needed / refillPerSec) * 1000);
  }

  const expireMs = Math.ceil((capacity / refillPerSec) * 1000) + 5000;
  store.buckets.set(key, {
    tokens,
    ts: nowMs,
    expiresAt: nowMs + expireMs,
  });

  return [allowed, tokens, retryMs];
}

vi.mock("@/lib/redis.js", () => {
  const fakeRedis = {
    eval: vi.fn(async (_script: string, _numKeys: number, ...args: string[]) => {
      const [key, capacityStr, refillStr, nowStr, costStr] = args;
      return evalRateLimit(
        key!,
        Number(capacityStr),
        Number(refillStr),
        Number(nowStr),
        Number(costStr),
      );
    }),
    ping: async () => "PONG",
    quit: async () => "OK",
  };
  return {
    getRedis: () => fakeRedis,
    closeRedis: async () => {
      // no-op
    },
    createBullMQConnection: () => fakeRedis,
  };
});

// Stub minimal de env (rate-limit usa via importação transitória).
vi.mock("@/config/env.js", () => ({
  env: () => ({
    NODE_ENV: "test",
    LOG_LEVEL: "fatal",
    OTEL_SERVICE_NAME: "bevox-meta-api",
  }),
  __resetEnvCacheForTests: () => {},
}));

const { consumeToken, DEFAULT_APP_LIMIT, appKey } = await import("@/lib/rate-limit.js");

beforeEach(() => {
  store.buckets.clear();
});
afterEach(() => {
  vi.clearAllMocks();
});

describe("consumeToken — capacity e refill", () => {
  it("primeira request → allowed, remaining = capacity - 1", async () => {
    const cfg = { capacity: 5, refillPerSecond: 1, scope: "test" };
    const r = await consumeToken("rl:test:1", cfg);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(4);
    expect(r.limit).toBe(5);
    expect(r.scope).toBe("test");
  });

  it("esgota o balde e bloqueia a próxima request", async () => {
    const cfg = { capacity: 3, refillPerSecond: 0.001, scope: "test" };
    for (let i = 0; i < 3; i++) {
      const r = await consumeToken("rl:test:2", cfg);
      expect(r.allowed).toBe(true);
    }
    const blocked = await consumeToken("rl:test:2", cfg);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfter).toBeGreaterThan(0);
  });

  it("após esperar o refill, request volta a passar", async () => {
    const cfg = { capacity: 1, refillPerSecond: 100, scope: "test" };
    const r1 = await consumeToken("rl:test:3", cfg);
    expect(r1.allowed).toBe(true);
    const r2 = await consumeToken("rl:test:3", cfg);
    expect(r2.allowed).toBe(false);
    await new Promise((res) => setTimeout(res, 30));
    const r3 = await consumeToken("rl:test:3", cfg);
    expect(r3.allowed).toBe(true);
  });

  it("buckets diferentes não interferem", async () => {
    const cfg = { capacity: 1, refillPerSecond: 0.01, scope: "test" };
    expect((await consumeToken("rl:test:A", cfg)).allowed).toBe(true);
    expect((await consumeToken("rl:test:B", cfg)).allowed).toBe(true);
    expect((await consumeToken("rl:test:A", cfg)).allowed).toBe(false);
    expect((await consumeToken("rl:test:B", cfg)).allowed).toBe(false);
  });
});

describe("config defaults + key helpers", () => {
  it("DEFAULT_APP_LIMIT = 1000 capacity, 1000/60 refill", () => {
    expect(DEFAULT_APP_LIMIT.capacity).toBe(1000);
    expect(DEFAULT_APP_LIMIT.refillPerSecond).toBeCloseTo(1000 / 60, 5);
  });

  it("appKey gera prefixo correto", () => {
    expect(appKey("abc")).toBe("rl:app:abc");
  });
});
