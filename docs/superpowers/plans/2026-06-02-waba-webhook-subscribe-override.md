# WABA Webhook Subscribe (per-WABA override) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Quando o meta-api onboarda uma WABA via OAuth, registrá-la nos webhooks do Meta App com um **override de callback por-WABA** apontando para `/webhooks/meta`, fechando o gap que hoje deixa WABAs onboarded pelo meta-api sem entrega de inbound.

**Architecture:** Após `discoverWaba`, antes de cifrar/persistir o token, o callback chama `POST /{waba_id}/subscribed_apps` com `override_callback_uri = <base>/webhooks/meta` e `verify_token = META_WEBHOOK_VERIFY_TOKEN`. A inscrição é cirúrgica (só a WABA onboarded) — não toca o callback a nível de app (que pertence ao Bevox V1). O inbound (`GET/POST /webhooks/meta`) já valida verify_token e HMAC; nenhuma mudança lá. Falha no registro propaga erro e aborta antes de persistir, para não deixar conexão meia-onboarded.

**Tech Stack:** TypeScript 5 strict, Fastify 5, undici (Meta Graph client), Vitest 4, Zod 4. Sem dependências novas.

---

## Decisão / sign-off humano (Task 0 — bloqueante de merge)

Esta mudança altera **qual produto recebe webhooks** das WABAs onboarded pelo meta-api. É decisão estrutural (CLAUDE.md §8 → "Parar — propor ADR draft").

**Decisão a confirmar com humano antes de mergear:**
- **Opção A (este plano):** App Bevox **compartilhado** com o V1 + **override por-WABA** apontando WABAs novas pro meta-api. V1 intacto (override é per-WABA; só afeta a WABA registrada).
- **Opção B:** **Meta App separado** dedicado ao meta-api (sem override; callback a nível de app aponta direto pro meta-api). Mais isolado, mas exige novo app + nova business verification + novo Advanced Access.

**Pré-requisitos da Opção A (confirmar no App Dashboard / com user-token — fora deste plano):**
- App tipo **Business**, produto WhatsApp (✅ já confirmado: subscription `whatsapp_business_account` ativa).
- `config_id` de Facebook Login for Business (se o objetivo for o widget Embedded Signup real; o connect atual usa `/dialog/oauth`).
- Advanced Access em `whatsapp_business_management` / `whatsapp_business_messaging`.

- [ ] **Task 0:** Abrir ADR draft (`pnpm cli`/skill `propose-adr`) documentando a escolha A vs B. Status `Proposta`. Não mergear o código abaixo sem o ADR + sign-off humano.

---

## Contexto (o que já existe vs o que falta)

| Peça | Estado | Arquivo |
|---|---|---|
| OAuth init + callback (exchange + discover + persist) | ✅ existe | `src/modules/wabas/service.ts:90` |
| `metaPost(path, body, accessToken)` helper | ✅ existe | `src/integration/meta-client.ts:235` |
| Inbound `GET /webhooks/meta` (valida `hub.verify_token == META_WEBHOOK_VERIFY_TOKEN`) | ✅ existe | `src/modules/inbound/routes.ts:81` |
| Inbound `POST /webhooks/meta` (valida HMAC com `META_WEBHOOK_APP_SECRET`) | ✅ existe | `src/modules/inbound/routes.ts:101` |
| Roteamento inbound (resolve tenant via `meta_waba_id` → subscriptions → delivery) | ✅ existe (PRD §10.1) | `src/modules/inbound/service.ts` |
| **`POST /{waba_id}/subscribed_apps` (registro + override)** | ❌ **falta (este plano)** | — |

`subscribed_apps` tem **zero** ocorrências em `src/`. O comentário `meta-client.ts:304` ("task #15 irá refinar isso") é **drift**: a task #15 real é "Gestão de Phone Numbers" (done). Não há task dedicada.

---

## File Structure

- **Modify** `src/integration/meta-oauth.ts` — exportar constante `META_WEBHOOK_PATH = "/webhooks/meta"` (junto de `WABA_CALLBACK_PATH`).
- **Modify** `src/integration/meta-client.ts` — `subscribeWabaApp` na interface `MetaOAuthClient` + impl em `UndiciMetaOAuthClient` + helper `buildWebhookCallbackUri()`.
- **Modify** `src/modules/wabas/service.ts` — chamar `subscribeWabaApp` em `handleWabaCallback` após `discoverWaba`, antes de cifrar/persistir.
- **Modify** `tests/unit/modules/wabas/callback.test.ts` — env `META_WEBHOOK_VERIFY_TOKEN`, fake `subscribeWabaApp`, assertions + teste de falha.
- **Modify** outros fakes de `MetaOAuthClient` (object-literal não-cast) — adicionar `subscribeWabaApp: vi.fn()`.

---

## Task 1: Adicionar `subscribeWabaApp` ao client + helper (plumbing, mantém suíte verde)

**Files:**
- Modify: `src/integration/meta-oauth.ts`
- Modify: `src/integration/meta-client.ts`
- Modify: `tests/unit/modules/wabas/callback.test.ts:111-125` (adicionar método ao fake)

- [ ] **Step 1: Exportar a constante de path do webhook**

Em `src/integration/meta-oauth.ts`, junto das outras constantes de path (perto de `WABA_CALLBACK_PATH`):

```ts
export const META_WEBHOOK_PATH = "/webhooks/meta";
```

- [ ] **Step 2: Declarar `subscribeWabaApp` na interface `MetaOAuthClient`**

Em `src/integration/meta-client.ts`, dentro de `interface MetaOAuthClient` (após `discoverWaba`):

```ts
  /**
   * Registra o app nos webhooks da WABA com override de callback por-WABA,
   * para que os eventos desta WABA cheguem ao meta-api (/webhooks/meta) e não
   * ao callback a nível de app. Idempotente no lado Meta.
   * POST /{waba_id}/subscribed_apps
   */
  subscribeWabaApp(
    wabaId: string,
    accessToken: string,
    override: { callbackUri: string; verifyToken: string },
  ): Promise<void>;
```

- [ ] **Step 3: Implementar em `UndiciMetaOAuthClient`**

Em `src/integration/meta-client.ts`, dentro de `class UndiciMetaOAuthClient` (logo após `updatePhoneNumberProfile`, espelhando o padrão dele):

```ts
  async subscribeWabaApp(
    wabaId: string,
    accessToken: string,
    override: { callbackUri: string; verifyToken: string },
  ): Promise<void> {
    await metaPost(
      `/${wabaId}/subscribed_apps`,
      {
        override_callback_uri: override.callbackUri,
        verify_token: override.verifyToken,
      },
      accessToken,
    );
  }
```

- [ ] **Step 4: Adicionar helper `buildWebhookCallbackUri()`**

Em `src/integration/meta-client.ts`, junto de `buildWabaRedirectUri()` (perto da linha 592). Importar `META_WEBHOOK_PATH` no topo (o arquivo já importa de `./meta-oauth.js`):

```ts
import { IG_CALLBACK_PATH, META_WEBHOOK_PATH, WABA_CALLBACK_PATH } from "./meta-oauth.js";

// ...

export function buildWebhookCallbackUri(): string {
  const cfg = env();
  if (!cfg.OAUTH_CALLBACK_BASE_URL) {
    throw errors.internal("OAUTH_CALLBACK_BASE_URL not configured");
  }
  return `${cfg.OAUTH_CALLBACK_BASE_URL}${META_WEBHOOK_PATH}`;
}
```

> Decisão menor: reusa `OAUTH_CALLBACK_BASE_URL` (mesmo host `meta-api.example.com` do webhook). Se no futuro o webhook morar em host diferente, criar `WEBHOOK_PUBLIC_BASE_URL` dedicado.

- [ ] **Step 5: Adicionar o método aos fakes de `MetaOAuthClient` (senão typecheck quebra)**

Encontre todos os fakes object-literal passados a `setMetaOAuthClientForTests`:

```bash
grep -rn "discoverWaba: vi.fn\|setMetaOAuthClientForTests(" tests
```

Em `tests/unit/modules/wabas/callback.test.ts`, no objeto `fakeMetaClient` (linha ~111-125), adicione:

```ts
  subscribeWabaApp: vi.fn(),
```

Para fakes construídos com `as MetaOAuthClient` (cast — ex.: `tests/integration/media-flow.test.ts`), nenhuma mudança é necessária (o cast tolera método ausente).

- [ ] **Step 6: Verificar verde (typecheck + suíte)**

Run: `pnpm typecheck && pnpm test`
Expected: PASS (sem mudança de comportamento ainda — método existe mas não é chamado).

- [ ] **Step 7: Commit**

```bash
git add src/integration/meta-oauth.ts src/integration/meta-client.ts tests/unit/modules/wabas/callback.test.ts
git commit -m "feat(wabas): adiciona subscribeWabaApp ao meta-client (registro de webhook por-WABA)"
```

---

## Task 2: Ligar `subscribeWabaApp` no `handleWabaCallback` (TDD)

**Files:**
- Test: `tests/unit/modules/wabas/callback.test.ts`
- Modify: `src/modules/wabas/service.ts:90-185`

- [ ] **Step 1: Escrever as assertions que falham**

Em `tests/unit/modules/wabas/callback.test.ts`:

(a) adicione a env em `REQUIRED_ENV` (após `OAUTH_CALLBACK_BASE_URL`):

```ts
  META_WEBHOOK_VERIFY_TOKEN: "verify-tok-123",
```

(b) em `beforeEach`, faça o fake resolver:

```ts
  fakeMetaClient.subscribeWabaApp.mockResolvedValue(undefined);
```

(c) no teste happy-path ("troca code, cifra, persiste, redireciona"), adicione antes do fim:

```ts
    expect(fakeMetaClient.subscribeWabaApp).toHaveBeenCalledWith(
      "waba-1",
      "EAA-meta-fake",
      { callbackUri: "https://meta-api.bevox.test/webhooks/meta", verifyToken: "verify-tok-123" },
    );
```

(d) adicione um teste novo no fim do `describe`:

```ts
  it("registro de webhook (subscribed_apps) falha → propaga e NÃO persiste", async () => {
    const state = uuidv7();
    await seedState(state);
    fakeMetaClient.subscribeWabaApp.mockRejectedValueOnce(new Error("meta down"));

    const res = await app.inject({
      method: "GET",
      url: `/v1/oauth/waba/callback?code=c&state=${state}`,
    });

    expect(res.statusCode).toBeGreaterThanOrEqual(500);
    // Subscribe acontece ANTES de persistir → nenhuma conexão meia-onboarded.
    expect(wabaRepo.createWabaConnectionWithToken).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm test -- callback`
Expected: FAIL — `subscribeWabaApp` não foi chamado (e o teste novo falha porque hoje persiste mesmo sem subscribe).

- [ ] **Step 3: Implementar a ligação no service**

Em `src/modules/wabas/service.ts`, atualizar o import do meta-client:

```ts
import { buildWabaRedirectUri, buildWebhookCallbackUri, getMetaOAuthClient } from "@/integration/meta-client.js";
```

E em `handleWabaCallback`, **logo após** `const discovery = await meta.discoverWaba(...)` e **antes** do bloco de `encryptToken`/persistência:

```ts
  // Registra a WABA nos webhooks do app com override por-WABA, para que os
  // eventos cheguem ao meta-api (/webhooks/meta) e não ao callback a nível de
  // app (que pode pertencer a outro produto Bevox). Idempotente — seguro em
  // reconexão. Falha aqui aborta antes de persistir (consumer re-tenta limpo).
  const cfg = env();
  if (!cfg.META_WEBHOOK_VERIFY_TOKEN) {
    throw errors.internal("META_WEBHOOK_VERIFY_TOKEN not configured");
  }
  await meta.subscribeWabaApp(discovery.meta_waba_id, exchanged.access_token, {
    callbackUri: buildWebhookCallbackUri(),
    verifyToken: cfg.META_WEBHOOK_VERIFY_TOKEN,
  });
```

> `env` e `errors` já estão importados no arquivo. Remover o `void env();` redundante da linha ~171 é opcional (o `cfg = env()` acima já força a asserção lazy).

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm test -- callback`
Expected: PASS (happy-path chama subscribe; teste de falha aborta antes de persistir).

- [ ] **Step 5: Suíte completa + typecheck**

Run: `pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/modules/wabas/service.ts tests/unit/modules/wabas/callback.test.ts
git commit -m "feat(wabas): registra webhook por-WABA (override) no callback OAuth"
```

---

## Task 3: Corrigir o drift de documentação

**Files:**
- Modify: `src/integration/meta-client.ts:302-304` (comentário "task #15")

- [ ] **Step 1: Corrigir o comentário stale**

Em `src/integration/meta-client.ts`, trocar a referência errada "task #15 irá refinar isso" por algo preciso:

```ts
    // V1 simplificação: usa /debug_token para descobrir businesses, depois
    // /<business_id>/owned_whatsapp_business_accounts. O registro de webhook
    // por-WABA (subscribed_apps + override) é feito no handleWabaCallback —
    // ver docs/superpowers/plans/2026-06-02-waba-webhook-subscribe-override.md.
```

- [ ] **Step 2: Verificar verde e commitar**

Run: `pnpm typecheck`
Expected: PASS.

```bash
git add src/integration/meta-client.ts
git commit -m "docs(wabas): corrige referencia stale de task no discoverWaba"
```

---

## Itens explicitamente fora de escopo (YAGNI / tasks futuras)

- **Reconcile/retry** de subscriptions órfãs (se Meta cair no meio): worker dedicado — task futura.
- **De-subscribe no disconnect** (`disconnectWaba` chamar `DELETE /{waba_id}/subscribed_apps`): plano separado.
- **Migrar V1** para meta-api / unificar `META_WEBHOOK_PATH` no inbound (hoje literal em `inbound/routes.ts`): refactor opcional.
- **Métrica** de registro de webhook: o handler de callback hoje não loga; manter o estilo. Adicionar contador é refinamento.
- Confirmação dos gates de Dashboard (Business type, `config_id`, Advanced Access): fora de código.

---

## Self-Review

**Spec coverage (PRD §10 + gap identificado):**
- §10.1 "resolve tenant via meta_waba_id → subscriptions → delivery" → já existe; este plano só garante que o webhook **chega** ao `/webhooks/meta` (override). ✅ Task 2.
- Gap "subscribed_apps ausente" → ✅ Task 1 (client) + Task 2 (wiring).
- §10.5 segurança (verify_token + HMAC): override usa `META_WEBHOOK_VERIFY_TOKEN`; HMAC inbound usa `META_WEBHOOK_APP_SECRET` (mesmo app). ✅ sem mudança.
- Decisão estrutural (shared app vs separado) → ✅ Task 0 (ADR gate).

**Placeholder scan:** nenhum TBD/"handle errors"; todo código mostrado.

**Type consistency:** `subscribeWabaApp(wabaId, accessToken, { callbackUri, verifyToken })` é idêntico na interface (Task 1 Step 2), impl (Step 3), fake (Step 5), assertion (Task 2 Step 1c) e chamada no service (Task 2 Step 3). `buildWebhookCallbackUri()` definido em Task 1 Step 4, usado em Task 2 Step 3. `META_WEBHOOK_PATH` definido em Task 1 Step 1, usado em Step 4.
