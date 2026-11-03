/**
 * Cliente Redis (ioredis) com inicialização lazy + factory para BullMQ.
 *
 * BullMQ exige opções específicas (`maxRetriesPerRequest: null`,
 * `enableReadyCheck: false`) e conexões dedicadas para Worker e
 * QueueScheduler. Centralizamos a configuração aqui para evitar drift.
 */

import { Redis, type RedisOptions } from "ioredis";

import { env } from "@/config/env.js";

let primary: Redis | null = null;

function baseOptions(): RedisOptions {
  return {
    // Reconnect com backoff exponencial até 30s.
    retryStrategy: (times) => Math.min(1000 * 2 ** Math.min(times, 5), 30_000),
    // Pequeno timeout de conexão pra falhar rápido em readiness probe.
    connectTimeout: 10_000,
    // Em SIGTERM o shutdown handler chama .quit() — não precisamos timeout interno.
    enableOfflineQueue: true,
    lazyConnect: false,
  };
}

/**
 * Cliente Redis primário (general-purpose). Usado por idempotency,
 * rate limiting, cache de tokens decifrados em memória curta, etc.
 *
 * NÃO compartilhar este cliente com BullMQ Worker — BullMQ precisa de
 * conexão dedicada com `maxRetriesPerRequest: null`.
 */
export function getRedis(): Redis {
  if (primary === null) {
    primary = new Redis(env().REDIS_URL, baseOptions());
  }
  return primary;
}

/**
 * Cria conexão DEDICADA para BullMQ Queue/Worker/QueueEvents.
 *
 * Cada Worker e QueueScheduler precisa da própria conexão (BullMQ usa
 * `BLPOP` que monopoliza a conexão). NÃO reutilizar entre componentes.
 */
export function createBullMQConnection(): Redis {
  return new Redis(env().REDIS_URL, {
    ...baseOptions(),
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
}

/**
 * Fecha o cliente primário. Idempotente. Chamado pelo shutdown handler.
 */
export async function closeRedis(): Promise<void> {
  if (primary === null) return;
  const conn = primary;
  primary = null;
  await conn.quit();
}

/**
 * Para uso EXCLUSIVO em testes.
 */
export function __resetRedisStateForTests(): void {
  primary = null;
}
