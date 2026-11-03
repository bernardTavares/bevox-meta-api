import "dotenv/config";
import { defineConfig } from "drizzle-kit";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL não definida. Defina no .env (ver .env.example) antes de rodar drizzle-kit.",
  );
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./db/schema/*.ts",
  out: "./db/migrations",
  dbCredentials: {
    url: databaseUrl,
  },
  strict: true,
  verbose: true,
  casing: "snake_case",
});
