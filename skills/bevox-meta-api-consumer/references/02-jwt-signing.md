# 02 — Assinando JWT RS256

Fonte canônica: ADR MA-002.

## Header

```json
{
  "alg": "RS256",
  "kid": "<key_id recebido no provision>",
  "typ": "JWT"
}
```

`kid` vai no **protected header**, não no payload. Idiomático.

## Payload (claims obrigatórios)

```json
{
  "iss": "<app_id (UUID)>",
  "iat": 1714003200,
  "exp": 1714003500,
  "aud": "bevox-meta-api",
  "scope": "tenants:write wabas:write webhooks:write events:read"
}
```

| Claim | Regra |
|---|---|
| `iss` | UUID do `app_id` (o `iss` é o emissor: você). |
| `aud` | Sempre `"bevox-meta-api"`. Outros valores = 401. |
| `iat` | `now()` em segundos epoch. |
| `exp` | `iat + N`, onde `N ≤ 300`. Maior = `INVALID_INPUT`. |
| `scope` | Lista space-separated. Validada por endpoint na meta-api. |

## Scopes disponíveis

- `tenants:read` / `tenants:write`
- `wabas:read` / `wabas:write`
- `ig:read` / `ig:write`
- `phone-numbers:read` / `phone-numbers:write`
- `templates:read` / `templates:write`
- `messages:write`
- `webhooks:read` / `webhooks:write`
- `events:read`
- `media:read`
- `audit:read`

Princípio: **scope mínimo por chamada**. Se está só enviando mensagem, peça `messages:write`. Não inclua tudo.

## Algoritmo

**Apenas RS256.** A meta-api rejeita `HS256`, `none`, `ES256`, etc. (proteção contra `alg:none` confusion).

## Vida útil

- Vida ≤ 300s (5 min).
- Recomendado: gerar JWT por **request** (caching opcional dentro de uma request HTTP que faz várias chamadas, mas não cache cross-request por mais de uns segundos).
- Não armazenar JWT em disco / cookie / cache long-lived.

## Rotação de chave

- Você pode ter até 3 chaves ativas simultaneamente.
- Quando admin executa `pnpm cli apps rotate-key --app-id <id>`, recebe novo par.
- Janela de grace de 14 dias: meta-api aceita JWTs assinados com a chave antiga até `valid_until`.
- Estratégia recomendada: deploy nova chave, troca env var, deploy novo, descarta chave antiga após confirmação.

## Implementação Node + jose

Veja `snippets/jwt-signer.ts`. Exemplo mínimo:

```ts
import { SignJWT, importPKCS8 } from "jose";

const key = await importPKCS8(process.env.META_API_PRIVATE_KEY!, "RS256");

const jwt = await new SignJWT({ scope: "messages:write" })
  .setProtectedHeader({ alg: "RS256", kid: process.env.META_API_KEY_ID!, typ: "JWT" })
  .setIssuer(process.env.META_API_APP_ID!)
  .setAudience("bevox-meta-api")
  .setIssuedAt()
  .setExpirationTime("5m")
  .sign(key);
```

## Implementação Python + PyJWT

```python
import jwt, time

token = jwt.encode(
    {
        "iss": APP_ID,
        "aud": "bevox-meta-api",
        "iat": int(time.time()),
        "exp": int(time.time()) + 300,
        "scope": "messages:write",
    },
    PRIVATE_KEY_PEM,
    algorithm="RS256",
    headers={"kid": KEY_ID, "typ": "JWT"},
)
```

## Implementação Go + golang-jwt/jwt v5

```go
import (
    "crypto/rsa"
    "time"
    "github.com/golang-jwt/jwt/v5"
)

token := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{
    "iss":   appID,
    "aud":   "bevox-meta-api",
    "iat":   time.Now().Unix(),
    "exp":   time.Now().Add(5 * time.Minute).Unix(),
    "scope": "messages:write",
})
token.Header["kid"] = keyID
signed, _ := token.SignedString(privateKey)
```

## Erros comuns

| Sintoma | Causa provável |
|---|---|
| 401 "invalid token" | `aud` errado, `exp` no passado, ou `kid` desconhecido (chave foi revogada / rotacionada). |
| 401 "kid not found" | Variável de ambiente `META_API_KEY_ID` está com valor antigo após rotação. |
| 401 "invalid signature" | Chave privada e pública não casam — provavelmente private key vazou em log e foi rotacionada. |
| 400 "exp too far in future" | Você setou `exp` > 300s. Diminua a vida útil. |
| 403 "insufficient scope" | Falta `scope` correto no payload. |

## Onde guardar a chave privada

- **Nunca** no repositório.
- **Nunca** em variável de ambiente plain em produção (use secret manager: AWS Secrets Manager, GCP Secret Manager, Vault, k8s Secret com mount como volume).
- Em dev, `.env` local + `.env` no `.gitignore`.

## CLI de troubleshooting

A meta-api tem CLI que assina JWT a partir de uma chave de admin:

```bash
pnpm cli sign-jwt --app=<app_id> --scope="tenants:read"
```

Útil para debugar com `curl` quando você acha que o problema está no seu cliente.
