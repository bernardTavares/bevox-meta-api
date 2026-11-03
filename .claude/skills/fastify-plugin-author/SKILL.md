---
name: fastify-plugin-author
description: |
  Criar novo plugin Fastify customizado em bevox-meta-api/src/plugins/ seguindo o
  padrao concreto dos plugins existentes (auth-jwt-consumer, idempotency, audit-log,
  rate-limit-buckets, auth-admin). Garante wrapping com fastify-plugin, naming
  consistente, escopo correto (encapsulate vs global), decorators tipados via
  declaracao de module augmentation, e teste unit espelhando o padrao em
  tests/unit/plugins/.
when_to_invoke: |
  - Humano pede "criar plugin Fastify" / "adicionar plugin customizado X"
  - Agent endpoint-implementer detecta que logica e transversal (cross-cutting) e
    deveria viver em plugin em vez de modulo
  - Refator que extrai middleware repetido para plugin
inputs:
  - Nome do plugin (kebab-case, ex.: `hmac-verify`, `meta-rate-budget`)
  - Proposito (1 frase)
  - Escopo: global (afeta todo request) ou opt-in via decorator (ex.: `app.requireHmac()`)
  - Hooks usados (onRequest, preHandler, preValidation, onSend, onResponse)
  - Decoradores que cria (em FastifyInstance, FastifyRequest, FastifyReply)
outputs:
  - Arquivo `src/plugins/<nome>.ts` com estrutura canonica
  - Arquivo `tests/unit/plugins/<nome>.test.ts` com cobertura minima
  - Atualizacao de bootstrap se plugin precisa ser registrado globalmente
references:
  - references/plugin-pattern.md
---

# Skill: fastify-plugin-author

## Quando usar

Use ESTA skill — em vez de criar plugin "ad-hoc" — quando:

- A logica e transversal a multiplos modulos (auth, idempotency, rate-limit,
  audit, request-context)
- Precisa decorar `FastifyInstance` / `FastifyRequest` / `FastifyReply`
- Precisa rodar antes/depois de toda rota (hook global) ou opt-in via preHandler
- Precisa de cache compartilhado entre rotas (Redis, in-memory)

**NAO** use para:
- Logica especifica de 1 modulo — vai em `src/modules/<X>/service.ts`
- Middleware de validacao de body — Zod ja resolve em `routes.ts`
- Decorator simples sem hook — pode ser helper em `src/lib/`

## Procedimento

### 1. Leitura preparatoria

- `bevox-meta-api/CLAUDE.md` §4 (lista de plugins), §5 (invariantes)
- Ler 2 plugins existentes mais similares ao que voce vai criar:
  - Hook global: `src/plugins/audit-log.ts`
  - Decorator opt-in com preHandler: `src/plugins/idempotency.ts`
  - Auth + cache Redis: `src/plugins/auth-jwt-consumer.ts`
  - Rate limit com buckets: `src/plugins/rate-limit-buckets.ts`
- Ler `tests/unit/plugins/idempotency.test.ts` para padrao de teste
- Ler `references/plugin-pattern.md` desta skill (template comentado)

### 2. Decisoes de design

Responder antes de escrever codigo:

| Pergunta | Opcoes |
|---|---|
| Escopo | Global (sempre roda) ou opt-in via decorator? |
| Hook(s) | `onRequest` (antes de tudo) / `preValidation` / `preHandler` (apos auth) / `onSend` (antes resposta sair) / `onResponse` (apos resposta) |
| Decorators | Quais campos novos em `FastifyRequest` / `FastifyInstance`? |
| Encapsulamento | `fp(plugin, { name, fastify: '5.x' })` (NAO encapsula — visivel ao parent) ou plugin nu (encapsula scope)? |
| Ordem | Depende de outro plugin rodar antes? (ex.: idempotency depende de auth) |
| Cache | Precisa Redis? Use `getRedis()` de `@/lib/redis.js` |
| Errors | Throw `errors.invalidInput(...)` / `errors.unauthenticated(...)` de `@/lib/errors.js` — nunca `new Error()` |

### 3. Estrutura canonica

Espelhar `references/plugin-pattern.md`. Pontos nao-negociaveis:

```typescript
import fp from "fastify-plugin";
import type { FastifyInstance, FastifyPluginAsync, preHandlerHookHandler } from "fastify";

// 1) Module augmentation tipada
declare module "fastify" {
  interface FastifyRequest {
    // novos campos request-scoped
  }
  interface FastifyInstance {
    // novos decorators (factory que retorna hook handler)
  }
}

// 2) Constantes no topo (TTLs, regex, sets de metodos)
const TTL_MS = 24 * 60 * 60 * 1000;
const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// 3) Helpers puros (testaveis isoladamente — exporte no fim do arquivo)
function helperPuro(input: unknown): string {
  // ...
}

// 4) Hook handler(s)
async function preHandler(req, reply) {
  // logica
}

// 5) Plugin async com decorate + addHook
const plugin: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.decorateRequest("novoField", undefined);
  app.decorate("requireAlgo", (): preHandlerHookHandler => preHandler);
  app.addHook("onSend", async (req, reply, payload) => { /* ... */ });
};

// 6) Export default via fastify-plugin (sem isso, decorators ficam encapsulados)
export default fp(plugin, {
  name: "<nome-kebab>",
  fastify: "5.x",
});

// 7) Re-export de helpers/constantes para testes unit
export { helperPuro, TTL_MS };
```

### 4. Teste unit obrigatorio

`tests/unit/plugins/<nome>.test.ts` cobre, no minimo:

- Path feliz: request valido passa, decorator funciona
- Path de erro: input invalido throws `AppError` com codigo correto
- Hook nao-aplicavel (ex.: GET em plugin que so age em mutacao) — no-op
- Replay/cache hit (se aplicavel)
- Defesa em profundidade (ex.: req.auth ausente quando deveria estar)

Use `buildApp()` de `tests/helpers/build-app.ts` (ver outros testes).

### 5. Registro no bootstrap

Se global, adicionar em `src/bootstrap/<stage>.ts` na ordem correta:

```typescript
import myPlugin from "@/plugins/<nome>.js";
await app.register(myPlugin);
```

Ordem canonica em V1: `request-context` -> `error-handler` -> `auth-jwt-consumer` /
`auth-admin` -> `rate-limit-buckets` -> `idempotency` -> `audit-log`. Inserir o
novo onde a dependencia exigir.

### 6. Verificacao final

```bash
pnpm typecheck
pnpm lint
pnpm test -- tests/unit/plugins/<nome>
pnpm test:integration  # se plugin afeta fluxo end-to-end
```

## Checklist antes de declarar pronto

- [ ] Wrapper `fp(plugin, { name, fastify: "5.x" })` no export default
- [ ] `name` em kebab-case bate com nome do arquivo
- [ ] Module augmentation em `declare module "fastify"`
- [ ] Decorators tipados (sem `any`)
- [ ] Helpers puros exportados para teste
- [ ] Errors via `errors.*` de `@/lib/errors.js`
- [ ] Pino via `req.log` (nunca `console.*`)
- [ ] Sem secret/token em log (revisar §5.4 e §7.4 do CLAUDE.md)
- [ ] Test unit em `tests/unit/plugins/<nome>.test.ts` passando
- [ ] Registro em bootstrap (se global)
- [ ] Documentado no JSDoc do topo do arquivo (qual ADR/PRD justifica)

## Naming

| Item | Convencao |
|---|---|
| Arquivo | `src/plugins/<nome-kebab>.ts` |
| Plugin `name` (fp options) | `<nome-kebab>` (mesmo do arquivo) |
| Decorator factory | `app.require<PascalCase>()` (ex.: `requireIdempotency`) |
| Request field | `req.<camelCase>` (ex.: `req.idempotencyState`) |
| Constante | `SCREAMING_SNAKE` |

## Idioma

JSDoc do topo do plugin + comentarios em **portugues**. Identificadores em ingles
camelCase/PascalCase (§7.2).

## Limites

- Nao trocar wrapper `fastify-plugin` por nada — encapsulamento errado quebra decorators.
- Nao registrar plugin diretamente em modulo — sempre em bootstrap.
- Nao adicionar dependencia externa sem listar alternativas (CLAUDE.md §13).
- Nao bypassar invariantes §5 (auth, idempotency, tenant-scope, audit, redact).
