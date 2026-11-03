import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Config dedicada de integração. Execução via `pnpm test:integration`.
 *
 * Esses testes:
 *   - Sobem containers reais via testcontainers (precisa Docker).
 *   - Exercitam IO real (ex.: MinIO/S3 para o media storage path), não mocks.
 *
 * Diferente de `tests/unit/**` (mocks) e de `tests/e2e/**` (stack HTTP
 * completa). Em CI, rodar atrás de runner com Docker disponível.
 */

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**"],
    testTimeout: 120_000,
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
