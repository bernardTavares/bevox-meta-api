/**
 * Bootstrap de E2E — sobe Postgres + Redis via testcontainers, aplica
 * migrations e expõe URLs para os testes.
 *
 * Uso:
 *   ```ts
 *   import { startInfra, stopInfra } from "./setup.js";
 *   beforeAll(async () => { await startInfra(); });
 *   afterAll(async () => { await stopInfra(); });
 *   ```
 *
 * Requisitos:
 *   - Docker rodando localmente.
 *   - E2E_ENABLED=true no env (caso contrário os tests usam `it.skip`).
 */

import { GenericContainer, type StartedTestContainer } from "testcontainers";

interface Infra {
  pgUrl: string;
  redisUrl: string;
  pgContainer: StartedTestContainer;
  redisContainer: StartedTestContainer;
}

let cached: Infra | null = null;

export async function startInfra(): Promise<Infra> {
  if (cached) return cached;

  const pg = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({
      POSTGRES_DB: "bevox_meta_api_test",
      POSTGRES_USER: "bevox",
      POSTGRES_PASSWORD: "bevox_test_password",
    })
    .withExposedPorts(5432)
    .start();

  const redis = await new GenericContainer("redis:7-alpine").withExposedPorts(6379).start();

  const pgUrl = `postgresql://bevox:bevox_test_password@${pg.getHost()}:${pg.getMappedPort(5432)}/bevox_meta_api_test`;
  const redisUrl = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;

  cached = { pgContainer: pg, redisContainer: redis, pgUrl, redisUrl };
  return cached;
}

export async function stopInfra(): Promise<void> {
  if (!cached) return;
  await cached.pgContainer.stop();
  await cached.redisContainer.stop();
  cached = null;
}

export function isE2EEnabled(): boolean {
  return process.env.E2E_ENABLED === "true";
}
