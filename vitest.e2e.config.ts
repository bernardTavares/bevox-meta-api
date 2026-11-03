import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Config dedicada de E2E. Execução opt-in via `pnpm test:e2e` ou
 * `E2E_ENABLED=true pnpm test:e2e`.
 *
 * Esses testes:
 *   - Sobem Postgres + Redis via testcontainers (precisa Docker).
 *   - Aplicam migrations do projeto.
 *   - Boot um Fastify server real ou cliente HTTP contra ele.
 *   - Mockeam Meta API (ou usam sandbox credenciado quando E2E_META=true).
 *
 * Em CI, rodar atrás de feature flag para evitar custo em PR comum.
 */

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["tests/e2e/**/*.e2e.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    pool: "forks",
    reporters: ["default"],
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src/", import.meta.url)),
      "@db": fileURLToPath(new URL("./db/", import.meta.url)),
    },
  },
});
