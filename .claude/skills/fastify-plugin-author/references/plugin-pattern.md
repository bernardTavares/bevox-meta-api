# Plugin Pattern — template comentado

Baseado em `src/plugins/idempotency.ts` (ADR MA-006) — exemplo canonico de plugin
com decorator opt-in via `app.requireXxx()`, hook `onSend` global no-op-quando-sem-state,
module augmentation tipada e helpers puros exportados para teste.

## Template anotado

```typescript
/**
 * Plugin Fastify — <descricao curta + referencia ADR/PRD>.
 *
 * Para <metodos> em rotas que opt-in via `app.requireXxx()`:
 *   1. <passo 1>
 *   2. <passo 2>
 *
 * Pre-requisito: <quais plugins precisam rodar antes>.
 * Registro em rota:
 *   { preHandler: [app.requireAuth({...}), app.requireXxx()] }
 */

import { createHash } from "node:crypto";

import fp from "fastify-plugin";
import type {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
  preHandlerHookHandler,
} from "fastify";

import { errors } from "@/lib/errors.js";
// import de repositorio/servico/lib interno conforme necessidade

// ---------- 1) Tipos request-scoped ----------
interface XxxState {
  campo1: string;
  campo2: string;
}

// ---------- 2) Module augmentation ----------
declare module "fastify" {
  interface FastifyRequest {
    xxxState?: XxxState;
  }
  interface FastifyInstance {
    requireXxx: () => preHandlerHookHandler;
  }
}

// ---------- 3) Constantes ----------
const TTL_MS = 24 * 60 * 60 * 1000;
const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const KEY_PATTERN = /^[A-Za-z0-9._\-:/=+]{1,128}$/;

// ---------- 4) Helpers puros (exportados pra teste) ----------
function hashBody(body: unknown): string {
  const serialized = body === undefined || body === null ? "" : JSON.stringify(body);
  return createHash("sha256").update(serialized).digest("hex");
}

// ---------- 5) Hook handler ----------
async function preHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  // 5.1) Guarda: aplica so onde faz sentido
  if (!MUTATION_METHODS.has(req.method)) return;

  // 5.2) Defesa em profundidade: depende de auth ter rodado antes
  if (!req.auth) {
    throw errors.internal("requireXxx requires requireAuth registered before it");
  }
  const appId = req.auth.appId;

  // 5.3) Extrair + validar input do header/body
  const headerVal = req.headers["x-xxx-key"];
  const key = Array.isArray(headerVal) ? headerVal[0] : headerVal;
  if (typeof key !== "string" || !KEY_PATTERN.test(key)) {
    throw errors.invalidInput("X-Xxx-Key header is required (...)", { header: "X-Xxx-Key" });
  }

  // 5.4) Logica core (consulta cache, DB, etc.)
  // ...

  // 5.5) Decorar request com state pro hook onSend
  req.xxxState = { campo1: key, campo2: hashBody(req.body) };
}

// ---------- 6) Plugin async ----------
const plugin: FastifyPluginAsync = async (app: FastifyInstance) => {
  // 6.1) Inicializar campo decorado (evita warning de Fastify 5)
  app.decorateRequest("xxxState", undefined);

  // 6.2) Decorator factory — retorna hook handler. Rota faz opt-in com app.requireXxx()
  app.decorate("requireXxx", (): preHandlerHookHandler => preHandler);

  // 6.3) Hook global no-op quando nao ha state — salva resultado apos resposta
  app.addHook("onSend", async (req, reply, payload) => {
    const state = req.xxxState;
    if (!state) return payload; // rota nao opt-in
    if (reply.statusCode < 200 || reply.statusCode >= 300) return payload;

    try {
      // persistir / cachear resultado
    } catch (err) {
      // falha em side-effect NAO derruba response — log warn
      req.log.warn({ err }, "failed to persist xxx state");
    }
    return payload;
  });
};

// ---------- 7) Export ----------
export default fp(plugin, {
  name: "xxx",
  fastify: "5.x",
});

// 7.1) Re-exportar helpers/constantes pra teste unit
export { hashBody, KEY_PATTERN, TTL_MS };
```

## Decisoes de design — anotacoes do exemplo real (idempotency)

| Decisao | Por que |
|---|---|
| `fp(...)` wrapper | Sem ele, decorators ficam encapsulados no plugin scope e somem para o resto do app. Sempre necessario para plugins que decoram `FastifyInstance`/`FastifyRequest`. |
| `name: "idempotency"` | Permite `fastify-plugin` detectar duplo-registro e dar erro claro. |
| `fastify: "5.x"` | Trava versao major — protege contra upgrade silencioso quebrando hooks. |
| `decorateRequest("...", undefined)` | Fastify 5 exige inicializacao explicita para campos request-scoped. |
| `decorate("requireXxx", () => handler)` | Factory pattern: rota chama `app.requireXxx()` e recebe handler pronto. Permite parametrizar (ex.: `requireAuth({ scopes })`). |
| `addHook("onSend", ...)` em vez de pre-resposta inline | onSend roda apos toda rota — captura cache mesmo se rota nao soube do plugin. State em `req.xxxState` diferencia opt-in. |
| Helpers exportados (`hashBody`, `KEY_PATTERN`) | Testaveis isoladamente sem montar Fastify inteiro. |
| `errors.invalidInput(...)` de `@/lib/errors.js` | AppError canonico — plugin de error-handler converte pra JSON com `request_id`. |
| `req.log.warn(...)` em falha de side-effect | Resposta ja foi enviada ao cliente; nao adianta throw. Log warn permite investigar sem 5xx. |

## Padrao de teste unit

`tests/unit/plugins/<nome>.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from "vitest";
import { hashBody, KEY_PATTERN } from "@/plugins/xxx.js";
import { buildApp } from "../../helpers/build-app.js"; // helper local do repo

describe("plugin xxx", () => {
  describe("helpers puros", () => {
    it("hashBody produz hash deterministico", () => {
      expect(hashBody({ a: 1 })).toBe(hashBody({ a: 1 }));
    });
    it("KEY_PATTERN aceita formato esperado", () => {
      expect(KEY_PATTERN.test("abc-123_xyz")).toBe(true);
      expect(KEY_PATTERN.test("contem espaco")).toBe(false);
    });
  });

  describe("preHandler", () => {
    let app: Awaited<ReturnType<typeof buildApp>>;
    beforeEach(async () => { app = await buildApp(); });

    it("no-op em GET", async () => {
      const res = await app.inject({ method: "GET", url: "/v1/probe-route" });
      expect(res.statusCode).toBe(200);
    });

    it("400 em POST sem X-Xxx-Key", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/probe-mutation",
        headers: { authorization: "Bearer <jwt valido mock>" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("INVALID_INPUT");
    });

    it("happy path persiste e devolve 201", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/probe-mutation",
        headers: {
          authorization: "Bearer <jwt valido mock>",
          "x-xxx-key": "test-key-001",
        },
        payload: { name: "ok" },
      });
      expect(res.statusCode).toBe(201);
    });
  });
});
```

## Pegadinhas conhecidas

- **Esquecer `fp()`** — sintoma: `app.requireXxx is not a function` em outra rota.
- **Hook `onRequest` em vez de `preHandler`** — `req.body` ainda nao parseado.
- **`req.auth` ausente** — significa que auth nao rodou antes; ajustar ordem no bootstrap.
- **Persistir em `onSend` mas ja ter feito `reply.send()` no handler** — payload chega como string; usar `serializePayloadForStore()` ou similar.
- **Log com `req.body` cru em plugin auditoria** — vaza secret se rota recebe credencial; redact antes (vide `@/lib/redact.ts`).
- **`fastify: "5.x"`** travado — se upgrade pra Fastify 6, atualizar todos plugins de uma vez.
