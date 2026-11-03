/**
 * Seed para desenvolvimento.
 *
 * Cria um ConsumerApp "dev-app" se nenhum existir. Imprime o `private_key_pem`
 * gerado — usar APENAS em dev (a chave privada é descartável).
 *
 * Em produção: este script recusa rodar. Provisionamento real é via CLI:
 *   pnpm cli apps create --name "<consumer>"
 * (a CLI guarda a private key num arquivo + log seguro, e o operador entrega
 * ao consumer pelo canal definido).
 *
 * Uso:
 *   tsx scripts/seed.ts
 *
 * Idempotente: re-execução não cria app duplicado.
 */

import "dotenv/config";

import { closeDb } from "@/db/client.js";
import { closeRedis } from "@/lib/redis.js";
import { createApp, listApps } from "@/modules/apps/service.js";

const DEV_APP_NAME = "dev-app";

async function main(): Promise<void> {
  const nodeEnv = process.env.NODE_ENV ?? "development";

  if (nodeEnv === "production") {
    console.error(
      "[seed] recusado em production. Use a CLI: pnpm cli apps create --name <consumer>",
    );
    process.exit(1);
  }

  console.log(`[seed] NODE_ENV=${nodeEnv} — verificando ConsumerApps existentes...`);

  const existing = await listApps();
  const alreadyHasDev = existing.find((a) => a.name === DEV_APP_NAME);

  if (alreadyHasDev) {
    console.log(`[seed] '${DEV_APP_NAME}' já existe (id=${alreadyHasDev.id}). Nada a fazer.`);
    return;
  }

  console.log(`[seed] criando ConsumerApp '${DEV_APP_NAME}'...`);
  const created = await createApp({
    name: DEV_APP_NAME,
    description: "Consumer app de desenvolvimento (gerado por scripts/seed.ts).",
  });

  console.log(
    `[seed] OK. app_id=${created.id} key_id=${created.key_id}\n` +
      `[seed] private_key_pem (NÃO commitar, NÃO usar em prod):\n${created.private_key_pem}`,
  );
}

main()
  .then(async () => {
    await closeDb();
    await closeRedis();
    process.exit(0);
  })
  .catch(async (err: unknown) => {
    console.error("[seed] falha:", err instanceof Error ? err.message : err);
    try {
      await closeDb();
      await closeRedis();
    } catch {
      // ignore
    }
    process.exit(1);
  });
