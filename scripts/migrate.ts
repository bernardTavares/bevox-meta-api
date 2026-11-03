/**
 * Runner de migrations Drizzle.
 *
 * Aplica todas as migrations pendentes em `db/migrations/` no banco apontado
 * por `DATABASE_URL`. Idempotente: re-execução não aplica de novo o que já
 * está em `__drizzle_migrations`.
 *
 * Uso:
 *   tsx scripts/migrate.ts up     # aplica pendentes (default)
 *   tsx scripts/migrate.ts down   # placeholder — drizzle-kit não suporta
 *                                   "down" automático; veja docs.
 *
 * Em prod: roda como Job k8s a partir do stage `migrator` do Dockerfile
 * (ver k8s/job-migrate.yaml). Em dev: invocado por `pnpm migrate:up`.
 */

import "dotenv/config";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

const MIGRATIONS_FOLDER = "./db/migrations";

async function main(): Promise<void> {
  const command = process.argv[2] ?? "up";

  if (command === "down") {
    console.error(
      "[migrate] drizzle-kit não suporta 'down' automático. Para reverter, " +
        "edite o SQL manualmente ou restaure do backup. Veja docs/runbooks/" +
        "disaster-recovery-runbook-v1.md.",
    );
    process.exit(1);
  }

  if (command !== "up") {
    console.error(`[migrate] comando inválido: '${command}'. Use 'up' ou 'down'.`);
    process.exit(1);
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("[migrate] DATABASE_URL não definida");
    process.exit(1);
  }

  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const db = drizzle(pool);

  const startedAt = Date.now();
  console.log(`[migrate] aplicando migrations de ${MIGRATIONS_FOLDER}...`);

  try {
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    console.log(`[migrate] OK (${Date.now() - startedAt}ms)`);
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error("[migrate] falha:", err instanceof Error ? err.message : err);
  process.exit(1);
});
