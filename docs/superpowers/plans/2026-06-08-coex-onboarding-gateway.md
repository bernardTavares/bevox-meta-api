# COEX (Coexistence) Onboarding — Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar suporte a onboarding por coexistência (COEX) ao gateway — um número que já roda no app WhatsApp Business passa a rodar TAMBÉM na Cloud API — de forma aditiva ao Embedded Signup (ES) já existente.

**Architecture:** COEX reusa todo o caminho do ES (`connect/init` → front roda `FB.login` → `connect/complete` faz code-exchange + discover + subscribe + persist). As diferenças COEX são: (1) `connect/init` expõe `meta_app_id` + `graph_version` para o front configurar o FB SDK; (2) `connect/complete` aceita `coexistence:true` + exige `phone_number_id`, confirma o número via `is_on_biz_app`/`platform_type` e dispara o sync obrigatório de 24h (`smb_app_data`); (3) o receiver de webhook classifica 3 campos COEX novos (`smb_message_echoes`, `smb_app_state_sync`, `history`) e desconecta a WABA em `account_update`/`PARTNER_REMOVED`. Subscription dos 3 campos é toggle no App Dashboard (pré-requisito humano, não código).

**Tech Stack:** Fastify 5, Zod 4, Drizzle ORM, undici (Meta Graph client), Pino 9, BullMQ 5, Vitest 4. Node 22+ obrigatório para rodar a suite.

**Contrato Meta (fonte canônica):** `<workspace>/bevox-direct/docs/superpowers/specs/2026-06-08-coex-meta-contract-verbatim-addendum.md` (shapes verbatim A–G). Onde diverge da paráfrase, o verbatim manda.

**3 decisões já confirmadas pelo humano (não reabrir):**
1. `phone_number_id` é obrigatório quando `coexistence:true` (400 se ausente).
2. Event types novos: `smb_message_echoes`→`whatsapp.message_echo`; `smb_app_state_sync`→`whatsapp.contact_synced`; `history`→`whatsapp.history_synced`; `account_update`/`PARTNER_REMOVED`→ reusa `waba.connection_changed` (reason vai no `data`).
3. Sync `smb_app_data` é disparado inline no `connect/complete`, **best-effort** (loga em falha, não invalida a conexão).

**Baseline:** a branch `feat/coex-onboarding` está verde (426 testes / 45 files) após mergear o fix de testes stale. Rodar a suite com Node 22 (`node --version` deve mostrar v22.x).

---

## File Structure

Arquivos de produção tocados:
- `src/modules/wabas/schemas.ts` — `InitOAuthResponse` (+`meta_app_id`,`graph_version`); `embeddedSignupCompleteBodySchema` (+`coexistence`).
- `src/modules/wabas/service.ts` — `initWabaOAuth` (retorna os 2 campos novos); `CompleteEmbeddedSignupInput` (+`coexistence`); `completeEmbeddedSignup` (branch COEX: exige phone, confirma, dispara sync).
- `src/modules/wabas/routes.ts` — passa `coexistence` ao service.
- `src/modules/wabas/repository.ts` — `disconnectWabaByMetaWabaId(metaWabaId)`.
- `src/integration/meta-client.ts` — interface `MetaOAuthClient` (+`getPhoneCoexInfo`,`triggerSmbAppDataSync`), tipos `PhoneCoexInfo`/`SmbAppDataSyncResult`, impl em `UndiciMetaOAuthClient`.
- `src/modules/inbound/service.ts` — `classifyEvent` (3 cases), `extractMetaEventId` (echoes), helper `isPartnerRemoved`, disconnect hook em `processSingle`.
- `docs/architecture/openapi.yaml` — init response, complete body, event_type enum, bump `1.0.0`→`1.1.0`.

Arquivos de teste tocados:
- `tests/unit/integration/meta-client.test.ts` — 2 describes novos.
- `tests/unit/modules/wabas/routes.test.ts` — 2 asserts no happy-path do init.
- `tests/unit/modules/wabas/complete.test.ts` — describe COEX.
- `tests/unit/modules/inbound/service.test.ts` — describes COEX + PARTNER_REMOVED.
- 9 literais `fakeMetaClient` (typecheck) — `+2` linhas cada (Task 2 lista os arquivos).

---

## Task 1: `connect/init` expõe `meta_app_id` + `graph_version`

O front (bevox-direct) precisa do Meta App ID + versão do Graph para rodar `FB.init`/`FB.login` (COEX e ES). O gateway é a SoT desses valores (vêm do env). Aditivo e opcional.

**Files:**
- Modify: `src/modules/wabas/schemas.ts:19-24`
- Modify: `src/modules/wabas/service.ts:65-70`
- Test: `tests/unit/modules/wabas/routes.test.ts:241-264`

- [ ] **Step 1: Atualizar o teste do happy-path do init (RED)**

Em `tests/unit/modules/wabas/routes.test.ts`, dentro do `it("retorna oauth_url + state e armazena state em Redis", ...)`, logo após a linha `expect(body.config_id).toBe("es-config-abc");` (linha 263), adicionar:

```ts
    expect(body.meta_app_id).toBe("1234567890");
    expect(body.graph_version).toBe("v21.0");
```

(O `REQUIRED_ENV` desse arquivo já tem `META_APP_ID: "1234567890"` e não seta `META_GRAPH_API_VERSION`, então o default `v21.0` do env aplica.)

- [ ] **Step 2: Rodar o teste e ver falhar**

Run: `npx vitest run tests/unit/modules/wabas/routes.test.ts -t "retorna oauth_url"`
Expected: FAIL — `body.meta_app_id` e `body.graph_version` são `undefined`.

- [ ] **Step 3: Adicionar os campos à interface `InitOAuthResponse`**

Em `src/modules/wabas/schemas.ts`, substituir o bloco da interface (linhas 19-24):

```ts
export interface InitOAuthResponse {
  oauth_url: string;
  state: string;
  expires_in_seconds: number;
  config_id?: string;
  /** Meta App ID (público) — front usa em FB.init({ appId }). */
  meta_app_id?: string;
  /** Versão do Graph API (ex.: "v21.0") — front usa em FB.init({ version }). */
  graph_version?: string;
}
```

- [ ] **Step 4: Popular os campos em `initWabaOAuth`**

Em `src/modules/wabas/service.ts`, substituir o `return` de `initWabaOAuth` (linhas 65-70):

```ts
  return {
    oauth_url: oauthUrl,
    state,
    expires_in_seconds: STATE_TTL_SECONDS,
    config_id: env().META_ES_CONFIG_ID,
    meta_app_id: env().META_APP_ID,
    graph_version: env().META_GRAPH_API_VERSION,
  };
```

- [ ] **Step 5: Rodar o teste e ver passar**

Run: `npx vitest run tests/unit/modules/wabas/routes.test.ts`
Expected: PASS (todos os testes do arquivo).

- [ ] **Step 6: Commit**

```bash
git add src/modules/wabas/schemas.ts src/modules/wabas/service.ts tests/unit/modules/wabas/routes.test.ts
git commit -m "feat(wabas): connect/init expõe meta_app_id + graph_version (COEX/ES front)"
```

---

## Task 2: Meta client — `getPhoneCoexInfo` + `triggerSmbAppDataSync`

Dois métodos novos no `MetaOAuthClient`: confirmar coexistência de um número e disparar o sync de 24h. Verbatim C (sync) e F (confirmação).

**Files:**
- Modify: `src/integration/meta-client.ts` (tipos ~75-123, interface ~125-186, impl em `UndiciMetaOAuthClient`)
- Modify (typecheck): 9 literais `fakeMetaClient` — lista no Step 5
- Test: `tests/unit/integration/meta-client.test.ts`

- [ ] **Step 1: Escrever os testes dos 2 métodos (RED)**

Em `tests/unit/integration/meta-client.test.ts`, adicionar ao final do arquivo (o mock de `undici` e `TOKEN` já existem no topo):

```ts
describe("UndiciMetaOAuthClient.getPhoneCoexInfo", () => {
  it("GET /{phone}?fields=is_on_biz_app,platform_type → mapeia flags COEX", async () => {
    const { getMetaOAuthClient } = await import("@/integration/meta-client.js");
    undiciState.request.mockResolvedValueOnce({
      statusCode: 200,
      body: { json: async () => ({ is_on_biz_app: true, platform_type: "CLOUD_API", id: "PHONE-1" }) },
    });
    const info = await getMetaOAuthClient().getPhoneCoexInfo("PHONE-1", TOKEN);
    expect(info).toEqual({ phone_number_id: "PHONE-1", is_on_biz_app: true, platform_type: "CLOUD_API" });
    const [url] = undiciState.request.mock.calls[0]! as [URL, unknown];
    expect(url.toString()).toContain("/PHONE-1");
    expect(url.searchParams.get("fields")).toBe("is_on_biz_app,platform_type");
    expect(url.searchParams.get("access_token")).toBe(TOKEN);
  });

  it("is_on_biz_app ausente → false; platform_type ausente → null", async () => {
    const { getMetaOAuthClient } = await import("@/integration/meta-client.js");
    undiciState.request.mockResolvedValueOnce({
      statusCode: 200,
      body: { json: async () => ({ id: "PHONE-2" }) },
    });
    const info = await getMetaOAuthClient().getPhoneCoexInfo("PHONE-2", TOKEN);
    expect(info).toEqual({ phone_number_id: "PHONE-2", is_on_biz_app: false, platform_type: null });
  });
});

describe("UndiciMetaOAuthClient.triggerSmbAppDataSync", () => {
  it("faz 2 POSTs (smb_app_state_sync + history) com Bearer e retorna request_ids", async () => {
    const { getMetaOAuthClient } = await import("@/integration/meta-client.js");
    undiciState.request
      .mockResolvedValueOnce({
        statusCode: 200,
        body: { json: async () => ({ messaging_product: "whatsapp", request_id: "req-state" }) },
      })
      .mockResolvedValueOnce({
        statusCode: 200,
        body: { json: async () => ({ messaging_product: "whatsapp", request_id: "req-hist" }) },
      });
    const r = await getMetaOAuthClient().triggerSmbAppDataSync("PHONE-1", TOKEN);
    expect(r).toEqual({ state_sync_request_id: "req-state", history_request_id: "req-hist" });
    expect(undiciState.request).toHaveBeenCalledTimes(2);

    const [url0, opts0] = undiciState.request.mock.calls[0]! as [
      URL,
      { method: string; body: string; headers: Record<string, string> },
    ];
    expect(url0.toString()).toContain("/PHONE-1/smb_app_data");
    expect(opts0.method).toBe("POST");
    expect(opts0.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(opts0.body)).toEqual({ messaging_product: "whatsapp", sync_type: "smb_app_state_sync" });

    const [, opts1] = undiciState.request.mock.calls[1]! as [URL, { body: string }];
    expect(JSON.parse(opts1.body)).toEqual({ messaging_product: "whatsapp", sync_type: "history" });
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run tests/unit/integration/meta-client.test.ts -t "getPhoneCoexInfo"`
Expected: FAIL — `getMetaOAuthClient().getPhoneCoexInfo is not a function`.

- [ ] **Step 3: Adicionar os tipos públicos**

Em `src/integration/meta-client.ts`, logo após a interface `MetaPhoneNumber` (após a linha 115), adicionar:

```ts
export interface PhoneCoexInfo {
  /** A resposta da Meta usa a key `id` (não `phone_number_id`). */
  phone_number_id: string;
  is_on_biz_app: boolean;
  platform_type: string | null;
}

export interface SmbAppDataSyncResult {
  /** request_id do POST sync_type=smb_app_state_sync (contatos). */
  state_sync_request_id: string | null;
  /** request_id do POST sync_type=history (histórico de mensagens). */
  history_request_id: string | null;
}
```

- [ ] **Step 4: Declarar os métodos na interface + implementar no client real**

Em `src/integration/meta-client.ts`, na interface `MetaOAuthClient`, logo após `subscribeWabaApp(...)` (após a linha 141), adicionar:

```ts
  /**
   * Confirma se um phone_number está em modo coexistence (COEX): apto a usar
   * Cloud API E o app WhatsApp Business simultaneamente. Verbatim F1:
   * is_on_biz_app=true + platform_type=CLOUD_API.
   * GET /{phone_number_id}?fields=is_on_biz_app,platform_type
   */
  getPhoneCoexInfo(phoneNumberId: string, accessToken: string): Promise<PhoneCoexInfo>;
  /**
   * Dispara o sync obrigatório de 24h do COEX: contatos (smb_app_state_sync)
   * + histórico (history). 2 POSTs separados para /{phone}/smb_app_data.
   * Resultado real chega via webhooks smb_app_state_sync/history. Verbatim C.
   */
  triggerSmbAppDataSync(phoneNumberId: string, accessToken: string): Promise<SmbAppDataSyncResult>;
```

Em `UndiciMetaOAuthClient`, logo após o método `subscribeWabaApp` (após a linha 426), adicionar:

```ts
  async getPhoneCoexInfo(phoneNumberId: string, accessToken: string): Promise<PhoneCoexInfo> {
    const body = (await metaGet(`/${phoneNumberId}`, {
      access_token: accessToken,
      fields: "is_on_biz_app,platform_type",
    })) as { id?: string; is_on_biz_app?: boolean; platform_type?: string };
    return {
      phone_number_id: body.id ?? phoneNumberId,
      is_on_biz_app: body.is_on_biz_app === true,
      platform_type: typeof body.platform_type === "string" ? body.platform_type : null,
    };
  }

  async triggerSmbAppDataSync(
    phoneNumberId: string,
    accessToken: string,
  ): Promise<SmbAppDataSyncResult> {
    const stateResp = (await metaPost(
      `/${phoneNumberId}/smb_app_data`,
      { messaging_product: "whatsapp", sync_type: "smb_app_state_sync" },
      accessToken,
    )) as { request_id?: string };
    const histResp = (await metaPost(
      `/${phoneNumberId}/smb_app_data`,
      { messaging_product: "whatsapp", sync_type: "history" },
      accessToken,
    )) as { request_id?: string };
    return {
      state_sync_request_id: typeof stateResp.request_id === "string" ? stateResp.request_id : null,
      history_request_id: typeof histResp.request_id === "string" ? histResp.request_id : null,
    };
  }
```

- [ ] **Step 5: Rodar e ver passar**

Run: `npx vitest run tests/unit/integration/meta-client.test.ts`
Expected: PASS.

- [ ] **Step 6: Adicionar os 2 métodos aos 9 literais `fakeMetaClient` (typecheck)**

A interface cresceu com 2 métodos obrigatórios; cada literal de fake passado a `setMetaOAuthClientForTests` precisa tê-los, senão `tsc --noEmit` (que cobre `tests/**`) quebra. Em CADA arquivo abaixo, localizar o objeto fake (linha com `downloadMedia: vi.fn(),`) e adicionar logo após ela:

```ts
  getPhoneCoexInfo: vi.fn(),
  triggerSmbAppDataSync: vi.fn(),
```

Arquivos (9):
1. `tests/unit/modules/wabas/callback.test.ts`
2. `tests/unit/modules/wabas/complete.test.ts`
3. `tests/unit/modules/phone-numbers/routes.test.ts`
4. `tests/unit/modules/templates/routes.test.ts`
5. `tests/unit/modules/media/routes.test.ts`
6. `tests/unit/modules/messages/routes.test.ts`
7. `tests/unit/modules/ig/routes.test.ts`
8. `tests/unit/modules/messages/async.test.ts`
9. `tests/unit/workers/media-download.test.ts`

- [ ] **Step 7: Typecheck + suite afetada**

Run: `pnpm typecheck && npx vitest run tests/unit/integration/meta-client.test.ts tests/unit/modules/wabas tests/unit/modules/messages tests/unit/modules/templates tests/unit/modules/media tests/unit/modules/phone-numbers tests/unit/modules/ig tests/unit/workers/media-download.test.ts`
Expected: typecheck sem erros; todos os testes PASS.

- [ ] **Step 8: Commit**

```bash
git add src/integration/meta-client.ts tests/unit/integration/meta-client.test.ts tests/unit/modules tests/unit/workers/media-download.test.ts
git commit -m "feat(meta-client): getPhoneCoexInfo + triggerSmbAppDataSync (COEX)"
```

---

## Task 3: `connect/complete` COEX-aware

Aceitar `coexistence:true`, exigir `phone_number_id`, confirmar o número via `getPhoneCoexInfo` (hard fail se não-COEX) e disparar `triggerSmbAppDataSync` best-effort.

**Files:**
- Modify: `src/modules/wabas/schemas.ts:38-44`
- Modify: `src/modules/wabas/routes.ts:52-62`
- Modify: `src/modules/wabas/service.ts` (`CompleteEmbeddedSignupInput` ~215-221; `completeEmbeddedSignup` ~223-252; imports)
- Test: `tests/unit/modules/wabas/complete.test.ts`

- [ ] **Step 1: Escrever os testes COEX (RED)**

Em `tests/unit/modules/wabas/complete.test.ts`, adicionar este describe ao final (o fake `fakeMeta` já ganhou `getPhoneCoexInfo`/`triggerSmbAppDataSync` na Task 2; `URL_BASE` e `token()` já existem):

```ts
describe("POST .../wabas/connect/complete — coexistence (COEX)", () => {
  it("coexistence sem phone_number_id → 400 e não troca code", async () => {
    const t = await token("wabas:write");
    const res = await app.inject({
      method: "POST", url: URL_BASE,
      headers: { authorization: `Bearer ${t}`, "idempotency-key": "coex-1" },
      payload: { code: "es-code", coexistence: true },
    });
    expect(res.statusCode).toBe(400);
    expect(fakeMeta.exchangeCode).not.toHaveBeenCalled();
  });

  it("happy COEX: confirma is_on_biz_app, persiste e dispara smb_app_data sync", async () => {
    fakeMeta.getPhoneCoexInfo.mockResolvedValueOnce({
      phone_number_id: "phone-1", is_on_biz_app: true, platform_type: "CLOUD_API",
    });
    fakeMeta.triggerSmbAppDataSync.mockResolvedValueOnce({
      state_sync_request_id: "req-s", history_request_id: "req-h",
    });
    const t = await token("wabas:write");
    const res = await app.inject({
      method: "POST", url: URL_BASE,
      headers: { authorization: `Bearer ${t}`, "idempotency-key": "coex-2" },
      payload: { code: "es-code", waba_id: "waba-1", phone_number_id: "phone-1", coexistence: true },
    });
    expect(res.statusCode).toBe(200);
    expect(fakeMeta.getPhoneCoexInfo).toHaveBeenCalledWith("phone-1", "EAA-es");
    expect(fakeMeta.triggerSmbAppDataSync).toHaveBeenCalledWith("phone-1", "EAA-es");
    expect(wabaRepo.createWabaConnectionWithToken).toHaveBeenCalledTimes(1);
  });

  it("número não-COEX (is_on_biz_app=false) → 409 e NÃO persiste/dispara sync", async () => {
    fakeMeta.getPhoneCoexInfo.mockResolvedValueOnce({
      phone_number_id: "phone-1", is_on_biz_app: false, platform_type: "CLOUD_API",
    });
    const t = await token("wabas:write");
    const res = await app.inject({
      method: "POST", url: URL_BASE,
      headers: { authorization: `Bearer ${t}`, "idempotency-key": "coex-3" },
      payload: { code: "es-code", phone_number_id: "phone-1", coexistence: true },
    });
    expect(res.statusCode).toBe(409);
    expect(wabaRepo.createWabaConnectionWithToken).not.toHaveBeenCalled();
    expect(fakeMeta.triggerSmbAppDataSync).not.toHaveBeenCalled();
  });

  it("sync best-effort: triggerSmbAppDataSync falha → ainda 200 (conexão persistida)", async () => {
    fakeMeta.getPhoneCoexInfo.mockResolvedValueOnce({
      phone_number_id: "phone-1", is_on_biz_app: true, platform_type: "CLOUD_API",
    });
    fakeMeta.triggerSmbAppDataSync.mockRejectedValueOnce(new Error("meta down"));
    const t = await token("wabas:write");
    const res = await app.inject({
      method: "POST", url: URL_BASE,
      headers: { authorization: `Bearer ${t}`, "idempotency-key": "coex-4" },
      payload: { code: "es-code", phone_number_id: "phone-1", coexistence: true },
    });
    expect(res.statusCode).toBe(200);
    expect(wabaRepo.createWabaConnectionWithToken).toHaveBeenCalledTimes(1);
  });

  it("não-COEX (coexistence ausente): não chama getPhoneCoexInfo nem sync", async () => {
    const t = await token("wabas:write");
    const res = await app.inject({
      method: "POST", url: URL_BASE,
      headers: { authorization: `Bearer ${t}`, "idempotency-key": "coex-5" },
      payload: { code: "es-code", waba_id: "waba-1", phone_number_id: "phone-1" },
    });
    expect(res.statusCode).toBe(200);
    expect(fakeMeta.getPhoneCoexInfo).not.toHaveBeenCalled();
    expect(fakeMeta.triggerSmbAppDataSync).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run tests/unit/modules/wabas/complete.test.ts -t "coexistence"`
Expected: FAIL — sem o branch COEX, `coex-1` não dá 400 (default `coexistence` ainda não existe), `getPhoneCoexInfo` não é chamado, etc.

- [ ] **Step 3: Adicionar `coexistence` ao schema do body**

Em `src/modules/wabas/schemas.ts`, substituir o `embeddedSignupCompleteBodySchema` (linhas 38-42):

```ts
export const embeddedSignupCompleteBodySchema = z.object({
  code: z.string().min(1).max(2048),
  waba_id: z.string().min(1).max(64).optional(),
  phone_number_id: z.string().min(1).max(64).optional(),
  /** COEX: número já roda no app WhatsApp Business e passa a rodar na Cloud API. */
  coexistence: z.boolean().optional().default(false),
});
```

- [ ] **Step 4: Passar `coexistence` ao service na rota**

Em `src/modules/wabas/routes.ts`, no handler de `connect/complete` (linhas 55-61), adicionar a propriedade `coexistence`:

```ts
      return completeEmbeddedSignup({
        appId: req.auth!.appId,
        tenantId: tenant_id,
        code: body.code,
        wabaIdHint: body.waba_id,
        phoneNumberIdHint: body.phone_number_id,
        coexistence: body.coexistence,
      });
```

- [ ] **Step 5: Implementar o branch COEX no service**

Em `src/modules/wabas/service.ts`:

(a) Adicionar o import do logger no topo (junto aos outros imports `@/lib/...`, ex. após a linha do `errors`):

```ts
import { logger } from "@/lib/logger.js";
```

(b) Adicionar `coexistence` à interface de input (linhas 215-221):

```ts
export interface CompleteEmbeddedSignupInput {
  appId: string;
  tenantId: string;
  code: string;
  wabaIdHint?: string;
  phoneNumberIdHint?: string;
  coexistence: boolean;
}
```

(c) Substituir o corpo de `completeEmbeddedSignup` (linhas 223-252) por:

```ts
export async function completeEmbeddedSignup(
  input: CompleteEmbeddedSignupInput,
): Promise<WabaConnectionResponse> {
  await validateActiveTenant(input.appId, input.tenantId);

  // COEX exige phone_number_id (vem do front via session logging) para
  // confirmar coexistence + disparar o sync de 24h. Verbatim C/F. Falha cedo,
  // antes de qualquer chamada Meta.
  if (input.coexistence && !input.phoneNumberIdHint) {
    throw errors.invalidInput("phone_number_id is required for coexistence onboarding", {
      coexistence: true,
    });
  }

  const meta = getMetaOAuthClient();
  // ES/COEX: code vem do widget → exchange SEM redirect_uri (ver spec §4).
  const exchanged = await meta.exchangeCode(input.code);
  // SEMPRE descobrir: discoverWaba é o único que traz business_id/display_name/
  // verified_status (obrigatórios no persist + AAD). O hint é só cross-check.
  const discovery = await meta.discoverWaba(exchanged.access_token);
  if (input.wabaIdHint && input.wabaIdHint !== discovery.meta_waba_id) {
    throw errors.invalidInput("waba_id hint does not match discovered WABA", {
      hint: input.wabaIdHint,
      discovered: discovery.meta_waba_id,
    });
  }

  // COEX: confirma que o número está em coexistence ANTES de persistir.
  // Verbatim F1: is_on_biz_app=true E platform_type=CLOUD_API.
  if (input.coexistence) {
    const phoneInfo = await meta.getPhoneCoexInfo(input.phoneNumberIdHint!, exchanged.access_token);
    if (!phoneInfo.is_on_biz_app || phoneInfo.platform_type !== "CLOUD_API") {
      throw errors.conflict("phone number is not in coexistence mode", {
        phone_number_id: input.phoneNumberIdHint,
        is_on_biz_app: phoneInfo.is_on_biz_app,
        platform_type: phoneInfo.platform_type,
      });
    }
  }

  const { connectionId } = await subscribeEncryptPersistWaba({
    appId: input.appId,
    tenantId: input.tenantId,
    accessToken: exchanged.access_token,
    expiresIn: exchanged.expires_in,
    discovery,
  });

  // COEX: dispara o sync obrigatório de 24h (contatos + histórico). Best-effort:
  // resultado real chega via webhooks; falha aqui não invalida a conexão (o
  // consumer pode re-disparar). NUNCA logar token — só request_ids/ids.
  if (input.coexistence) {
    try {
      const sync = await meta.triggerSmbAppDataSync(
        input.phoneNumberIdHint!,
        exchanged.access_token,
      );
      logger().info(
        {
          waba_connection_id: connectionId,
          meta_waba_id: discovery.meta_waba_id,
          state_sync_request_id: sync.state_sync_request_id,
          history_request_id: sync.history_request_id,
        },
        "coex smb_app_data sync triggered",
      );
    } catch (err) {
      logger().warn(
        { err, waba_connection_id: connectionId, meta_waba_id: discovery.meta_waba_id },
        "coex smb_app_data sync failed (non-blocking; consumer may retry)",
      );
    }
  }

  const conn = await findWabaConnectionById(input.appId, input.tenantId, connectionId);
  if (!conn) throw errors.internal("waba connection not found after persist");
  return toResponse(conn);
}
```

- [ ] **Step 6: Rodar e ver passar**

Run: `npx vitest run tests/unit/modules/wabas/complete.test.ts`
Expected: PASS (happy ES anterior + 5 testes COEX novos).

- [ ] **Step 7: Typecheck**

Run: `pnpm typecheck`
Expected: sem erros (`coexistence` agora é obrigatório em `CompleteEmbeddedSignupInput`; a rota e os testes passam o campo).

- [ ] **Step 8: Commit**

```bash
git add src/modules/wabas/schemas.ts src/modules/wabas/routes.ts src/modules/wabas/service.ts tests/unit/modules/wabas/complete.test.ts
git commit -m "feat(wabas): connect/complete COEX-aware (confirma is_on_biz_app + dispara smb_app_data sync)"
```

---

## Task 4: Inbound — event types COEX + disconnect em PARTNER_REMOVED

Classificar `smb_message_echoes`/`smb_app_state_sync`/`history`, dedup de echoes pelo wamid, e soft-disconnect da WABA em `account_update`/`PARTNER_REMOVED`. Verbatim D/E.

**Files:**
- Modify: `src/modules/wabas/repository.ts` (nova função, após `disconnectWaba` ~177)
- Modify: `src/modules/inbound/service.ts` (import; `classifyEvent` 116-126; `extractMetaEventId` ~144-146; helper + hook em `processSingle`)
- Test: `tests/unit/modules/inbound/service.test.ts`

- [ ] **Step 1: Escrever testes (RED) — adicionar o handle do mock + describes**

Em `tests/unit/modules/inbound/service.test.ts`:

(a) Adicionar um handle hoisted para o disconnect, logo após o bloco `inboundRepo` (após a linha 96):

```ts
const wabaExtra = vi.hoisted(() => ({ disconnectWabaByMetaWabaId: vi.fn() }));
```

(b) Substituir o mock de `@/modules/wabas/repository.js` (linhas 69-86) para incluir o disconnect:

```ts
vi.mock("@/modules/wabas/repository.js", () => ({
  findWabaByMetaWabaId: vi.fn(async (metaWabaId: string) =>
    metaWabaId === "WABA-1"
      ? {
          id: "00000000-0000-7000-8000-00000000000a",
          tenantId: TENANT_ID,
          appId: APP_ID,
          metaBusinessId: "biz",
          metaWabaId,
          displayName: "X",
          verifiedStatus: "VERIFIED",
          createdAt: new Date(),
          updatedAt: new Date(),
          disconnectedAt: null,
        }
      : null,
  ),
  disconnectWabaByMetaWabaId: wabaExtra.disconnectWabaByMetaWabaId,
}));
```

(c) No `beforeEach` (após a linha 135, dentro do bloco), setar o retorno default do disconnect:

```ts
  wabaExtra.disconnectWabaByMetaWabaId.mockResolvedValue({
    id: "00000000-0000-7000-8000-00000000000a",
    metaWabaId: "WABA-1",
    disconnectedAt: new Date(),
  });
```

(d) Adicionar os describes ao final do arquivo:

```ts
describe("processMetaWebhook — COEX event types", () => {
  it("smb_message_echoes → whatsapp.message_echo + dedup pelo id do echo", async () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WABA-1",
          changes: [
            {
              field: "smb_message_echoes",
              value: { message_echoes: [{ id: "wamid.echo.1", from: "1555", to: "1650", type: "text" }] },
            },
          ],
        },
      ],
    };
    await processMetaWebhook(payload as never);
    const insert = inboundRepo.insertInboundEvent.mock.calls[0]![0];
    expect(insert.eventType).toBe("whatsapp.message_echo");
    expect(insert.metaEventId).toBe("wamid.echo.1");
  });

  it("smb_app_state_sync → whatsapp.contact_synced", async () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WABA-1",
          changes: [{ field: "smb_app_state_sync", value: { state_sync: [{ type: "contact", action: "add" }] } }],
        },
      ],
    };
    await processMetaWebhook(payload as never);
    expect(inboundRepo.insertInboundEvent.mock.calls[0]![0].eventType).toBe("whatsapp.contact_synced");
  });

  it("history → whatsapp.history_synced", async () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WABA-1",
          changes: [{ field: "history", value: { history: [{ metadata: { phase: 0, progress: 55 }, threads: [] }] } }],
        },
      ],
    };
    await processMetaWebhook(payload as never);
    expect(inboundRepo.insertInboundEvent.mock.calls[0]![0].eventType).toBe("whatsapp.history_synced");
  });
});

describe("processMetaWebhook — PARTNER_REMOVED disconnect", () => {
  it("account_update/PARTNER_REMOVED → desconecta a WABA e entrega waba.connection_changed", async () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WABA-1",
          changes: [
            {
              field: "account_update",
              value: {
                event: "PARTNER_REMOVED",
                waba_info: { waba_id: "WABA-1" },
                disconnection_info: { reason: "PRIMARY_INACTIVITY" },
              },
            },
          ],
        },
      ],
    };
    await processMetaWebhook(payload as never);
    expect(wabaExtra.disconnectWabaByMetaWabaId).toHaveBeenCalledWith("WABA-1");
    expect(inboundRepo.insertInboundEvent.mock.calls[0]![0].eventType).toBe("waba.connection_changed");
  });

  it("account_update SEM PARTNER_REMOVED → não desconecta", async () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [{ id: "WABA-1", changes: [{ field: "account_update", value: { event: "PHONE_NUMBER_ADDED" } }] }],
    };
    await processMetaWebhook(payload as never);
    expect(wabaExtra.disconnectWabaByMetaWabaId).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run tests/unit/modules/inbound/service.test.ts -t "COEX event types"`
Expected: FAIL — eventType cai em `raw.whatsapp_business_account.smb_message_echoes` etc.; e o teste de PARTNER_REMOVED falha porque o import `disconnectWabaByMetaWabaId` ainda não existe no módulo de produção.

- [ ] **Step 3: Adicionar `disconnectWabaByMetaWabaId` no repository**

Em `src/modules/wabas/repository.ts`, logo após a função `disconnectWaba` (após a linha 177), adicionar:

```ts
/**
 * Soft-disconnect por meta_waba_id, sem scope de consumer-JWT. Usado pelo
 * receiver de webhook em account_update/PARTNER_REMOVED — não há contexto de
 * consumer, então app_id/tenant_id vêm da própria conexão (mesmo padrão de
 * `findWabaByMetaWabaId`, que o receiver já usa para resolver tenant). Set
 * disconnected_at + supersede tokens em txn. Retorna a conexão desconectada
 * ou null se não havia conexão ativa com esse meta_waba_id.
 */
export async function disconnectWabaByMetaWabaId(
  metaWabaId: string,
): Promise<WabaConnection | null> {
  return getDb().transaction(async (tx) => {
    const [row] = await tx
      .update(wabaConnections)
      .set({ disconnectedAt: sql`now()`, updatedAt: sql`now()` })
      .where(and(eq(wabaConnections.metaWabaId, metaWabaId), isNull(wabaConnections.disconnectedAt)))
      .returning();
    if (!row) return null;
    await tx
      .update(wabaTokens)
      .set({ supersededAt: sql`now()` })
      .where(and(eq(wabaTokens.wabaConnectionId, row.id), isNull(wabaTokens.supersededAt)));
    return row;
  });
}
```

(`and`, `eq`, `isNull`, `sql`, `wabaConnections`, `wabaTokens`, `WabaConnection`, `getDb` já estão importados no arquivo.)

- [ ] **Step 4: Atualizar `classifyEvent` (3 cases COEX)**

Em `src/modules/inbound/service.ts`, dentro do bloco `if (object === "whatsapp_business_account")` de `classifyEvent`, logo após `if (field === "account_update") return "waba.connection_changed";` (linha 125), adicionar:

```ts
    // COEX (coexistence): 3 campos app-level adicionais (verbatim D).
    if (field === "smb_message_echoes") return "whatsapp.message_echo";
    if (field === "smb_app_state_sync") return "whatsapp.contact_synced";
    if (field === "history") return "whatsapp.history_synced";
```

- [ ] **Step 5: Dedup de echoes em `extractMetaEventId`**

Em `src/modules/inbound/service.ts`, em `extractMetaEventId`, logo após o bloco `statuses` (após a linha 146 `if (statuses && statuses[0]?.id) return statuses[0].id;`), adicionar:

```ts
  // COEX smb_message_echoes — cada echo carrega um wamid em `id`.
  const echoes = value.message_echoes as Array<{ id?: string }> | undefined;
  if (echoes && echoes[0]?.id) return echoes[0].id;
  // smb_app_state_sync/history não têm id top-level estável → dedup desligado
  // para eles (retorna null abaixo); risco de replay é baixo nesses syncs.
```

- [ ] **Step 6: Adicionar o helper `isPartnerRemoved` + import + hook em `processSingle`**

(a) Atualizar o import do repository wabas (linha 24) para incluir o disconnect:

```ts
import { disconnectWabaByMetaWabaId, findWabaByMetaWabaId } from "@/modules/wabas/repository.js";
```

(b) Adicionar o helper puro logo acima de `processSingle` (antes da linha 268):

```ts
/** account_update com PARTNER_REMOVED → a WABA foi removida no lado Meta. */
function isPartnerRemoved(
  object: string,
  field: string | undefined,
  value: Record<string, unknown> | undefined,
): boolean {
  return (
    object === "whatsapp_business_account" &&
    field === "account_update" &&
    (value?.event as string | undefined) === "PARTNER_REMOVED"
  );
}
```

(c) Em `processSingle`, no caminho-feliz (tenant resolvido), logo após `metaWebhookProcessedTotal.inc({ outcome: "persisted" });` (linha 319) e ANTES do bloco de media download, adicionar:

```ts
  // COEX/ES: PARTNER_REMOVED → a WABA saiu no lado Meta. Soft-disconnect local
  // (disconnected_at + supersede tokens) para parar refresh/uso do token. O
  // evento waba.connection_changed segue para o consumer no fluxo abaixo.
  if (isPartnerRemoved(object, field, value)) {
    try {
      const disconnected = await disconnectWabaByMetaWabaId(entryId);
      if (disconnected) {
        logger().info(
          { meta_waba_id: entryId, waba_connection_id: disconnected.id },
          "waba disconnected via PARTNER_REMOVED webhook",
        );
      }
    } catch (err) {
      logger().warn({ err, meta_waba_id: entryId }, "PARTNER_REMOVED disconnect failed (non-blocking)");
    }
  }
```

(`logger` já é importado no arquivo — linha 15.)

- [ ] **Step 7: Rodar e ver passar**

Run: `npx vitest run tests/unit/modules/inbound/service.test.ts`
Expected: PASS (C3 anteriores + COEX + PARTNER_REMOVED).

- [ ] **Step 8: Typecheck**

Run: `pnpm typecheck`
Expected: sem erros.

- [ ] **Step 9: Commit**

```bash
git add src/modules/wabas/repository.ts src/modules/inbound/service.ts tests/unit/modules/inbound/service.test.ts
git commit -m "feat(inbound): event types COEX (echo/contact/history) + disconnect em PARTNER_REMOVED"
```

---

## Task 5: OpenAPI — contrato COEX + bump de versão

Documentar os campos novos e os 3 event types. Aditivo → non-breaking → bump **minor** `1.0.0`→`1.1.0` (regra `meta-api-contracts.md`).

**Files:**
- Modify: `docs/architecture/openapi.yaml` (`info.version` linha 4; init resp 184-191; complete body 207-212; event_type enum 1288-1296)

- [ ] **Step 1: Bump de versão**

Em `docs/architecture/openapi.yaml`, linha 4, trocar `version: 1.0.0` por:

```yaml
  version: 1.1.0
```

- [ ] **Step 2: Init response — adicionar `meta_app_id` + `graph_version`**

Substituir o bloco de `properties` da resposta 200 do `connect/init` (linhas 185-191):

```yaml
                properties:
                  oauth_url: { type: string, format: uri }
                  state: { type: string }
                  config_id:
                    type: string
                    description: Embedded Signup config_id (presente se META_ES_CONFIG_ID setado). Front roda FB.login com ele.
                  meta_app_id:
                    type: string
                    description: Meta App ID publico. Front usa em FB.init com appId.
                  graph_version:
                    type: string
                    description: Versao do Graph API, por exemplo v21.0. Front usa em FB.init com version.
                required: [oauth_url, state]
```

- [ ] **Step 3: Complete body — adicionar `coexistence`**

Substituir o bloco `properties` do requestBody de `connect/complete` (linhas 209-212):

```yaml
              properties:
                code: { type: string }
                waba_id: { type: string }
                phone_number_id: { type: string }
                coexistence:
                  type: boolean
                  default: false
                  description: COEX. Quando true, phone_number_id é obrigatório; o número é confirmado (is_on_biz_app/platform_type) e o sync de 24h (smb_app_data) é disparado.
```

- [ ] **Step 4: Event type enum — adicionar os 3 tipos COEX**

No schema `InboundEvent`, substituir o `enum` de `event_type` (linhas 1288-1296):

```yaml
          enum:
            - message.received
            - message.status_updated
            - template.status_updated
            - waba.connection_changed
            - phone_number.quality_changed
            - whatsapp.message_echo
            - whatsapp.contact_synced
            - whatsapp.history_synced
            - system.degraded
            - system.recovered
            - webhook.dead_letter
```

- [ ] **Step 5: Validar o YAML**

Run: `pnpm openapi:check`
Expected: YAML válido, sem erros de schema.

- [ ] **Step 6: Commit**

```bash
git add docs/architecture/openapi.yaml
git commit -m "feat(api): contrato COEX (init meta_app_id/graph_version, complete coexistence, event types) + bump 1.1.0"
```

---

## Verificação final (após todas as tasks)

- [ ] **Suite completa verde**

Run: `npx vitest run`
Expected: todos os testes PASS (baseline 426 + novos COEX).

- [ ] **Typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: sem erros.

- [ ] **Auditores de invariantes (subagents)**

Rodar `secrets-redaction-auditor` (token COEX decifrado só em memória, nada logado além de request_ids/ids) e `contract-guardian` (bump minor presente para a mudança em `openapi.yaml`). Endereçar achados antes do PR.

---

## Pré-requisitos humanos (fora do código — NÃO bloqueiam o merge, bloqueiam o go-live COEX)

- App Dashboard → WhatsApp → Configuration: assinar os 3 campos `history`, `smb_app_state_sync`, `smb_message_echoes` (toggle a nível de app). Verbatim D2.
- Confirmar `META_ES_CONFIG_ID` no Meta App (Facebook Login for Business) e Advanced Access.
- Itens 🔴 da lista verbatim a fechar com a Meta antes do go-live: v4 `extras`; `phone_number_id` sempre presente no FINISH?; `subscribed_apps` por-WABA necessário p/ COEX?; instante exato da janela 24h; envelope CANCEL/ERROR; valores de `action` além de add/remove.

## Notas de design (decisões tomadas neste plano)

- **`meta_app_id` em vez de `app_id`** no init: evita colisão semântica com o `app_id` do consumer (que já tem outro significado no gateway). É o Meta App ID (público), seguro de expor.
- **Confirmação de COEX é hard-fail (409)**, mas o **sync é best-effort** (decisão #3): confirmar antes de persistir evita conexão inconsistente; o sync é assíncrono no lado Meta e re-disparável.
- **`disconnectWabaByMetaWabaId` é unscoped por design**: o webhook não tem contexto de consumer-JWT; o scope vem da própria conexão (mesmo padrão de `findWabaByMetaWabaId`, que o receiver já usa). Documentado no código para o invariants-auditor.
- **Dedup só de echoes**: `smb_app_state_sync`/`history` não têm id top-level estável no contrato verbatim; dedup desligado para eles (risco de replay baixo). Item 🔴 #6 da lista verbatim.
