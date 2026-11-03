/**
 * Cliente Drizzle + pool pg do bevox-meta-api.
 *
 * Inicialização lazy: o pool só é criado no primeiro `getDb()`. Permite
 * importar o módulo em testes sem efeitos colaterais.
 *
 * Acesso ao banco: SEMPRE via `getDb()` ou injeção em service. NÃO criar
 * pools paralelos. Workers e API compartilham a mesma instância.
 */

import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";

import * as schema from "@db/schema/index.js";

import { env } from "@/config/env.js";

export type Database = NodePgDatabase<typeof schema>;
export type { schema };

interface DbState {
  pool: Pool;
  db: Database;
}

let state: DbState | null = null;

function buildPoolConfig(): PoolConfig {
  const cfg = env();
  return {
    connectionString: cfg.DATABASE_URL,
    max: 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // statement_timeout em ms — proteção contra queries lentas em prod.
    statement_timeout: 30_000,
    application_name: cfg.OTEL_SERVICE_NAME,
  };
}

/**
 * Inicializa pool + Drizzle. Idempotente.
 */
export function initDb(): Database {
  if (state !== null) return state.db;

  const pool = new Pool(buildPoolConfig());

  // Erros do pool são fatais para a saúde do processo — propagar para
  // shutdown handler decidir o que fazer.
  pool.on("error", (err) => {
    process.emit("uncaughtException", err);
  });

  const db = drizzle(pool, { schema, casing: "snake_case" });
  state = { pool, db };
  return db;
}

/**
 * Retorna a instância Drizzle. Inicializa lazy se necessário.
 */
export function getDb(): Database {
  return state?.db ?? initDb();
}

/**
 * Expõe o pool para health checks e shutdown. Não usar para queries —
 * use `getDb()`.
 */
export function getPool(): Pool {
  if (state === null) initDb();
  return state!.pool;
}

/**
 * Fecha o pool. Idempotente. Chamado pelo shutdown handler.
 */
export async function closeDb(): Promise<void> {
  if (state === null) return;
  const { pool } = state;
  state = null;
  await pool.end();
}

/**
 * Para uso EXCLUSIVO em testes — reseta estado interno sem fechar pool.
 * Em testes integrados, prefira `closeDb()`.
 */
export function __resetDbStateForTests(): void {
  state = null;
}
