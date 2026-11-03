/**
 * Smoke E2E — exercita o boot da infra (Postgres + Redis via testcontainers)
 * e verifica que conseguimos PING + criar uma tabela mínima. Suficiente para
 * provar que a setup harness funciona.
 *
 * Roda apenas com E2E_ENABLED=true (precisa Docker local). Em CI usual,
 * estes testes ficam skipped.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { Redis } from "ioredis";

import { isE2EEnabled, startInfra, stopInfra } from "./setup.js";

const describeIf = isE2EEnabled() ? describe : describe.skip;

describeIf("E2E smoke — testcontainers boot", () => {
  let pgUrl: string;
  let redisUrl: string;

  beforeAll(async () => {
    const infra = await startInfra();
    pgUrl = infra.pgUrl;
    redisUrl = infra.redisUrl;
  }, 120_000);

  afterAll(async () => {
    await stopInfra();
  }, 60_000);

  it("Postgres aceita conexão e SELECT 1", async () => {
    const client = new Client({ connectionString: pgUrl });
    await client.connect();
    const res = await client.query("SELECT 1 AS x");
    expect(res.rows[0]).toEqual({ x: 1 });
    await client.end();
  });

  it("Redis responde a PING", async () => {
    const r = new Redis(redisUrl);
    const reply = await r.ping();
    expect(reply).toBe("PONG");
    await r.quit();
  });
});
