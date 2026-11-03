/**
 * bevox-meta-api admin CLI.
 *
 * Roda localmente (operador autenticado pelo box). Usa diretamente os
 * services + repository (sem HTTP). Auth implícita: presença na máquina
 * + acesso ao DATABASE_URL/REDIS_URL.
 *
 * Comandos:
 *   apps create --name <name> [--description <d>]
 *   apps list
 *   apps rotate-key --app-id <id> [--grace-days N]
 *   apps deactivate --app-id <id>
 *   dead-letter list --subscription-id <id>
 *   dead-letter replay --subscription-id <id> [--dry-run]
 *
 * Output: JSON por padrão; --table para tabela curta. Dry-run em ações
 * destrutivas (replay, deactivate) imprime o que faria sem mutar.
 *
 * Entrada via `pnpm cli <command...>`.
 */

import { Command } from "commander";

import { closeDb } from "@/db/client.js";
import { closeRedis } from "@/lib/redis.js";
import { createApp, deactivateApp, listApps, rotateKey } from "@/modules/apps/service.js";
import { listDeadLetterDeliveries } from "@/modules/webhooks/repository.js";
import { replayDeadLetters } from "@/modules/webhooks/service.js";

interface OutputOptions {
  format: "json" | "table";
}

function emit(value: unknown, opts: OutputOptions): void {
  if (opts.format === "json") {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  // table mínima
  if (Array.isArray(value)) {
    if (value.length === 0) {
      process.stdout.write("(vazio)\n");
      return;
    }
    const cols = Object.keys(value[0] as Record<string, unknown>);
    process.stdout.write(`${cols.join("\t")}\n`);
    for (const row of value) {
      const r = row as Record<string, unknown>;
      process.stdout.write(`${cols.map((c) => String(r[c] ?? "")).join("\t")}\n`);
    }
    return;
  }
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export function buildCli(): Command {
  const program = new Command();
  program
    .name("bevox-meta-api-cli")
    .description("CLI administrativo do bevox-meta-api")
    .option("--format <fmt>", "json | table", "json");

  // ----- apps -----
  const apps = program.command("apps");

  apps
    .command("create")
    .requiredOption("--name <name>", "nome do consumer app")
    .option("--description <desc>", "descrição")
    .action(async (opts) => {
      const out = await createApp({ name: opts.name, description: opts.description });
      emit(out, { format: program.opts().format });
    });

  apps.command("list").action(async () => {
    const items = await listApps();
    emit(items, { format: program.opts().format });
  });

  apps
    .command("rotate-key")
    .requiredOption("--app-id <id>", "consumer app id")
    .option("--grace-days <n>", "grace window em dias", "14")
    .action(async (opts) => {
      const out = await rotateKey({
        appId: opts.appId,
        graceWindowDays: Number.parseInt(opts.graceDays, 10),
      });
      emit(out, { format: program.opts().format });
    });

  apps
    .command("deactivate")
    .requiredOption("--app-id <id>", "consumer app id")
    .option("--dry-run", "imprime o que faria sem mutar", false)
    .action(async (opts) => {
      if (opts.dryRun) {
        emit(
          { dry_run: true, action: "deactivate", app_id: opts.appId },
          { format: program.opts().format },
        );
        return;
      }
      const out = await deactivateApp(opts.appId);
      emit(out, { format: program.opts().format });
    });

  // ----- dead-letter -----
  const dl = program.command("dead-letter");

  dl.command("list")
    .requiredOption("--subscription-id <id>", "webhook subscription id")
    .action(async (opts) => {
      const items = await listDeadLetterDeliveries(opts.subscriptionId);
      emit(items, { format: program.opts().format });
    });

  dl.command("replay")
    .requiredOption("--subscription-id <id>", "webhook subscription id")
    .option("--dry-run", "imprime quantos seriam re-enfileirados sem mutar", false)
    .action(async (opts) => {
      if (opts.dryRun) {
        const items = await listDeadLetterDeliveries(opts.subscriptionId);
        emit(
          { dry_run: true, would_replay: items.length, deliveries: items.length },
          { format: program.opts().format },
        );
        return;
      }
      const out = await replayDeadLetters(opts.subscriptionId);
      emit(out, { format: program.opts().format });
    });

  return program;
}

// Entry point quando executado como script.
const isMain =
  typeof process.argv[1] === "string" &&
  /admin-cli[\\/](index|main)\.(ts|js)$/.test(process.argv[1]);

if (isMain) {
  const program = buildCli();
  program
    .parseAsync(process.argv)
    .then(async () => {
      await closeDb();
      await closeRedis();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error(err instanceof Error ? err.message : String(err));
      try {
        await closeDb();
        await closeRedis();
      } catch {
        // ignore
      }
      process.exit(1);
    });
}
