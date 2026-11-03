/**
 * Graceful shutdown — drain de conexões em SIGTERM/SIGINT.
 *
 * Ordem de shutdown:
 *   1. Para de aceitar novos requests (Fastify .close())
 *   2. Aguarda jobs in-flight (BullMQ workers)
 *   3. Fecha pool Postgres (drena queries em andamento)
 *   4. Fecha conexões Redis
 *   5. Exit
 *
 * Cada componente registra seu hook via `registerShutdownHook()`. Hooks
 * executam na ordem inversa de registro (LIFO) — quem subiu por último
 * desce primeiro.
 */

type ShutdownHook = () => Promise<void> | void;

interface RegisteredHook {
  name: string;
  hook: ShutdownHook;
}

const hooks: RegisteredHook[] = [];
let installed = false;
let shuttingDown = false;

/**
 * Registra um hook de shutdown. Hooks rodam em ordem LIFO.
 */
export function registerShutdownHook(name: string, hook: ShutdownHook): void {
  hooks.push({ name, hook });
}

/**
 * Executa shutdown sequencial. Cada hook tem `timeoutMs` para terminar;
 * se estourar, registra o erro e segue (não trava o processo).
 */
export async function shutdown(
  reason: string,
  options: { timeoutMs?: number; logger?: (msg: string) => void } = {},
): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  const { timeoutMs = 10_000, logger = (m) => console.warn(m) } = options;

  logger(`[shutdown] iniciando (${reason}) — ${hooks.length} hooks`);

  // LIFO
  for (let i = hooks.length - 1; i >= 0; i--) {
    const { name, hook } = hooks[i]!;
    const start = Date.now();
    try {
      await Promise.race([
        Promise.resolve(hook()),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`shutdown hook "${name}" timeout ${timeoutMs}ms`)),
            timeoutMs,
          ),
        ),
      ]);
      logger(`[shutdown] ${name} ok (${Date.now() - start}ms)`);
    } catch (err) {
      logger(`[shutdown] ${name} falhou: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  logger("[shutdown] concluído");
}

/**
 * Instala handlers SIGTERM/SIGINT no processo. Idempotente.
 *
 * Em ambiente containerizado (Docker, k8s), SIGTERM é o sinal padrão
 * para terminar; o processo tem `terminationGracePeriodSeconds` (default
 * 30s no k8s) para sair, depois recebe SIGKILL.
 */
export function installShutdownHandlers(
  options: { exitTimeoutMs?: number; logger?: (msg: string) => void } = {},
): void {
  if (installed) return;
  installed = true;

  const { exitTimeoutMs = 25_000, logger } = options;

  const handler = (signal: NodeJS.Signals) => {
    void (async () => {
      await shutdown(`signal=${signal}`, { logger });
      process.exit(0);
    })();

    // Garantia de exit: se algum hook travar, força saída.
    setTimeout(() => {
      (logger ?? console.warn)("[shutdown] timeout global — forçando exit(1)");
      process.exit(1);
    }, exitTimeoutMs).unref();
  };

  process.on("SIGTERM", handler);
  process.on("SIGINT", handler);
}

/**
 * Para uso EXCLUSIVO em testes.
 */
export function __resetShutdownStateForTests(): void {
  hooks.length = 0;
  installed = false;
  shuttingDown = false;
}
