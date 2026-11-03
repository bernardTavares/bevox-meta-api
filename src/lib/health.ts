/**
 * Health check helpers — usados por /healthz, /readyz e CLI ops.
 *
 * Convenção: cada checker retorna `{ ok, latencyMs, error? }` para que o
 * endpoint /readyz possa agregar e devolver detalhes sem expor stack traces.
 */

import { sql } from "drizzle-orm";

import { env } from "@/config/env.js";
import { getDb } from "@/db/client.js";
import { getKmsClient } from "@/integration/kms-client.js";
import { getRedis } from "@/lib/redis.js";

export interface HealthCheckResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

async function timed<T>(fn: () => Promise<T>): Promise<HealthCheckResult> {
  const start = Date.now();
  try {
    await fn();
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function checkPostgres(): Promise<HealthCheckResult> {
  return timed(async () => {
    await getDb().execute(sql`select 1`);
  });
}

export async function checkRedis(): Promise<HealthCheckResult> {
  return timed(async () => {
    const reply = await getRedis().ping();
    if (reply !== "PONG") {
      throw new Error(`PING retornou "${reply}", esperado "PONG"`);
    }
  });
}

/**
 * A19 fix (audit 2026-06-02, re-attack): `/readyz` deve cobrir KMS — sem
 * isso, todo o fluxo OAuth (cifra de token Meta) quebra mas readiness
 * reporta verde.
 *
 * Re-attack: a primeira passagem só chamava `getKmsClient()` (construtor
 * lazy do `KeyManagementServiceClient` GCP — não exercita auth nem
 * network), então readyz continuava verde com WIF quebrado. Agora
 * delegamos para `client.healthCheck()`, que:
 *
 *  - Provider `local`: força carregar a master key e validar comprimento.
 *  - Provider `gcp`: chama `getKeyRing` (metadata read-only, sem custo
 *    cripto/$$) sobre `KMS_KEY_ID`. Falha em token WIF expirado, SA sem
 *    permissão, DNS/network, keyRing inexistente, etc. — exatamente os
 *    sintomas que fariam OAuth quebrar em prod.
 *
 * Wrapping com timeout duro: se o GCP KMS RPC ficar pendurado (rede
 * particionada, control-plane stall), retornamos erro em vez de
 * bloquear o readiness probe indefinidamente.
 */
const KMS_HEALTH_TIMEOUT_MS = 3_000;

export async function checkKms(): Promise<HealthCheckResult> {
  return timed(async () => {
    const client = getKmsClient();
    if (!client) {
      throw new Error("KMS client construção retornou null");
    }
    await withTimeout(client.healthCheck(), KMS_HEALTH_TIMEOUT_MS, "KMS healthCheck");
    void env().KMS_PROVIDER;
  });
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timeout (${ms}ms)`));
    }, ms);
    // Permite que o processo termine mesmo se o probe não voltar.
    timer.unref?.();
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface ReadinessReport {
  ok: boolean;
  checks: {
    postgres: HealthCheckResult;
    redis: HealthCheckResult;
    kms: HealthCheckResult;
  };
}

export async function readiness(): Promise<ReadinessReport> {
  const [postgres, redis, kms] = await Promise.all([checkPostgres(), checkRedis(), checkKms()]);
  return {
    ok: postgres.ok && redis.ok && kms.ok,
    checks: { postgres, redis, kms },
  };
}
