import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["tests/unit/**/*.test.ts", "src/**/*.test.ts"],
    exclude: ["tests/integration/**", "tests/e2e/**", "node_modules/**", "dist/**"],
    reporters: ["default"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/index.ts"],
    },
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src/", import.meta.url)),
      "@db": fileURLToPath(new URL("./db/", import.meta.url)),
    },
  },
});
