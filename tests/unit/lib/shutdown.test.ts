import { afterEach, describe, expect, it, vi } from "vitest";

import { __resetShutdownStateForTests, registerShutdownHook, shutdown } from "@/lib/shutdown.js";

afterEach(() => {
  __resetShutdownStateForTests();
});

describe("shutdown", () => {
  it("executa hooks em ordem LIFO", async () => {
    const order: string[] = [];
    registerShutdownHook("first", () => {
      order.push("first");
    });
    registerShutdownHook("second", () => {
      order.push("second");
    });
    registerShutdownHook("third", () => {
      order.push("third");
    });

    await shutdown("test", { logger: () => {} });
    expect(order).toEqual(["third", "second", "first"]);
  });

  it("aguarda hooks assíncronos antes de prosseguir", async () => {
    const events: string[] = [];
    registerShutdownHook("a", async () => {
      await new Promise((r) => setTimeout(r, 20));
      events.push("a-done");
    });
    registerShutdownHook("b", async () => {
      await new Promise((r) => setTimeout(r, 5));
      events.push("b-done");
    });

    await shutdown("test", { logger: () => {} });
    // LIFO: b roda antes; cada um terminou antes do próximo começar.
    expect(events).toEqual(["b-done", "a-done"]);
  });

  it("hook que falha não impede execução dos seguintes", async () => {
    const ran: string[] = [];
    registerShutdownHook("ok-1", () => {
      ran.push("ok-1");
    });
    registerShutdownHook("explode", () => {
      throw new Error("boom");
    });
    registerShutdownHook("ok-2", () => {
      ran.push("ok-2");
    });

    const log: string[] = [];
    await shutdown("test", { logger: (m) => log.push(m) });
    // LIFO: ok-2 → explode → ok-1
    expect(ran).toEqual(["ok-2", "ok-1"]);
    expect(log.some((m) => m.includes("explode falhou"))).toBe(true);
  });

  it("hook que estoura timeout é registrado mas shutdown continua", async () => {
    const ran: string[] = [];
    registerShutdownHook("fast", () => {
      ran.push("fast");
    });
    registerShutdownHook("slow", async () => {
      await new Promise((r) => setTimeout(r, 200));
      ran.push("slow");
    });

    const log: string[] = [];
    await shutdown("test", { timeoutMs: 30, logger: (m) => log.push(m) });
    expect(ran).toContain("fast");
    expect(log.some((m) => m.includes("slow falhou") && m.includes("timeout"))).toBe(true);
  });

  it("é idempotente — segunda chamada é no-op", async () => {
    const fn = vi.fn();
    registerShutdownHook("h", fn);

    await shutdown("first", { logger: () => {} });
    await shutdown("second", { logger: () => {} });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
