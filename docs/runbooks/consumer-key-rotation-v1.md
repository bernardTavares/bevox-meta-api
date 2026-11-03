# Runbook — Rotação de chave de consumer-app (RS256)

Rotaciona a chave de assinatura de JWT de um consumer-app no gateway: registra um
**novo keypair** (gateway gera) + **novo `key_id`** (kid) e expira a chave anterior
após uma janela de graça. Usado quando a private key do consumer **vazou** ou em
rotação periódica.

## Quando

- Private key RS256 de um consumer comprometida/vazada (ex.: bevox-direct, app_id
  `<CONSUMER_APP_ID>`, key_id `<CONSUMER_KEY_ID>`).
- Rotação preventiva.

## Como funciona (código)

- Rota: `POST /admin/apps/{app_id}/keys/rotate` — `src/modules/apps/routes.ts:35`
  (`app.requireAdminAuth()`). Body: `{ "grace_window_days"?: number }` (int, **min 1, max 60**;
  default no service). `src/modules/apps/service.ts:92` → `repository.rotateAppKey`
  (`repository.ts:75`).
- Efeito (txn): **insere** uma nova `app_key` (gateway gera o keypair RS256) e marca as
  keys anteriores com `valid_until = now + grace`. JWTs do consumer trazem o `kid` no
  header protegido; o `auth-jwt-consumer` resolve a key por (`iss`=app_id, `kid`) e rejeita
  kids expirados.
- Resposta: `{ key_id, private_key_pem, grace_window_days, ... }`. **`private_key_pem` sai
  UMA ÚNICA VEZ** — não é recuperável depois. Nunca logar/colar em chat.
- Auth admin: JWT **HS256** assinado com `ADMIN_API_KEY` (no Secret de prod), `aud =
  bevox-meta-api-admin`, `role: "admin"`, `sub`, `iat`, `exp` ≤ 3600s. Plugin
  `src/plugins/auth-admin.ts`.

> ⚠️ **Vazamento:** `grace_window_days` mínimo é **1** → a chave vazada continua válida por
> ~1 dia (kid antigo aceito até `valid_until`). Não há hard-revoke imediato hoje. Para um
> vazamento, rotacione com `grace_window_days: 1` e trate 1 dia de sobreposição como risco
> residual aceito (ou monitore uso do kid antigo). Hard-revoke imediato = gap a endereçar.

## Procedimento (prod — infra)

Tudo in-pod (o `ADMIN_API_KEY` vive no Secret; o JWT admin nunca sai do pod; a rota admin
só responde in-cluster). Node 22 do runtime tem `fetch` nativo + `jose` nas deps.

1. Acesso ao prod:
   ```bash
   ssh -i ~/.ssh/meta-api-prod_ed25519 root@<PROD_HOST_IP>
   export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
   ```

2. Mintar o admin JWT **e** chamar o rotate num só script in-pod (substitua `APP_ID`):
   ```bash
   kubectl -n bevox-meta-api exec deploy/bevox-meta-api -- node --input-type=module -e '
   import { SignJWT } from "jose";
   const APP_ID = "<CONSUMER_APP_ID>";
   const key = new TextEncoder().encode(process.env.ADMIN_API_KEY);
   const now = Math.floor(Date.now()/1000);
   const jwt = await new SignJWT({ role: "admin" })
     .setProtectedHeader({ alg: "HS256" })
     .setSubject("ops-key-rotation").setAudience("bevox-meta-api-admin")
     .setIssuedAt(now).setExpirationTime(now + 300).sign(key);
   const res = await fetch(`http://127.0.0.1:3000/admin/apps/${APP_ID}/keys/rotate`, {
     method: "POST",
     headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" },
     body: JSON.stringify({ grace_window_days: 1 }),
   });
   console.log("HTTP", res.status);
   console.log(await res.text());
   '
   ```
   A saída contém `key_id` (novo kid) + `private_key_pem` (uma vez).

3. **Capturar com segurança** o `key_id` + `private_key_pem` da saída do passo 2 — terminal
   do operador apenas. NÃO colar em chat/ticket/log. Entregar ao bevox-direct **out-of-band**
   (cofre/secret manager).

4. No bevox-direct: atualizar o signer de JWT consumer com o **novo `key_id` (kid)** + a
   **nova private key**. A partir daí todo JWT usa o kid novo.

5. Esperar a janela de graça (1 dia) — a key antiga expira sozinha (`valid_until`). Confirmar
   que o consumer continua autenticando (com a key nova) durante e após a janela.

## Verificação

- Consumer autentica com a key nova: um request real (`GET /v1/tenants` etc.) → 200.
- Após a graça, um JWT assinado com a **chave antiga** (kid antigo) → 401 (`UNAUTHENTICATED`).

## Referências

- `src/modules/apps/{routes,service,repository}.ts` (rotate)
- `src/plugins/auth-admin.ts` (admin HS256), `src/plugins/auth-jwt-consumer.ts` (kid/validade)
- `docs/architecture/openapi.yaml` → `/admin/apps/{app_id}/keys/rotate`
- CLAUDE.md §11 (mintar JWT admin in-pod), [[prod-deploy-procedure]] (acesso prod)
