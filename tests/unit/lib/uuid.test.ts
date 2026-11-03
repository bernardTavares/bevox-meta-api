import { describe, expect, it } from "vitest";

import { uuidv7, uuidv7Timestamp } from "@/lib/uuid.js";

describe("uuidv7", () => {
  it("retorna string no formato canônico de UUID (8-4-4-4-12 hex lowercase)", () => {
    const id = uuidv7();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("marca a versão como 7 (4 bits no nibble após o 3º grupo)", () => {
    const id = uuidv7();
    // dígito 14 (índice 14 com hifens, ou seja primeiro char do 3º grupo) é a versão.
    expect(id.charAt(14)).toBe("7");
  });

  it("respeita a variant RFC4122 (10xx — primeiro char do 4º grupo é 8/9/a/b)", () => {
    const id = uuidv7();
    expect(["8", "9", "a", "b"]).toContain(id.charAt(19));
  });

  it("é monotonicamente crescente quando gerado em rápida sucessão", () => {
    const ids = Array.from({ length: 100 }, () => uuidv7());
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });

  it("gera IDs únicos (1000 amostras)", () => {
    const set = new Set<string>();
    for (let i = 0; i < 1000; i++) set.add(uuidv7());
    expect(set.size).toBe(1000);
  });
});

describe("uuidv7Timestamp", () => {
  it("extrai timestamp aproximadamente igual a Date.now() no momento da geração", () => {
    const before = Date.now();
    const id = uuidv7();
    const after = Date.now();

    const ts = uuidv7Timestamp(id);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});
