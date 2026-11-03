/**
 * JWT signer para autenticação contra bevox-meta-api.
 *
 * Uso:
 *   const signer = createJwtSigner({
 *     appId: process.env.META_API_APP_ID!,
 *     keyId: process.env.META_API_KEY_ID!,
 *     privateKeyPem: process.env.META_API_PRIVATE_KEY!,
 *   });
 *   const jwt = await signer(["messages:write"]);
 *
 * Dependência: pnpm add jose
 *
 * Referências:
 *   - skill: references/02-jwt-signing.md
 *   - ADR MA-002 (auth model)
 */
import { SignJWT, importPKCS8, type KeyLike } from "jose";

export interface JwtSignerConfig {
  /** UUIDv7 do app consumidor (`iss`). */
  appId: string;
  /** UUIDv7 da chave (vai no header `kid`). */
  keyId: string;
  /** Chave privada em formato PKCS8 PEM. */
  privateKeyPem: string;
  /** Vida do token em segundos (≤ 300). Default 240s (4min) para folga vs limite de 5min. */
  ttlSeconds?: number;
}

export type JwtSigner = (scopes: string[]) => Promise<string>;

export function createJwtSigner(config: JwtSignerConfig): JwtSigner {
  const ttl = config.ttlSeconds ?? 240;
  if (ttl > 300) {
    throw new Error("JWT TTL > 300s será rejeitado pela meta-api");
  }

  // Cache do KeyLike importado — importPKCS8 é caro.
  let keyPromise: Promise<KeyLike> | null = null;
  const getKey = () => {
    if (!keyPromise) {
      keyPromise = importPKCS8(config.privateKeyPem, "RS256");
    }
    return keyPromise;
  };

  return async (scopes: string[]): Promise<string> => {
    if (scopes.length === 0) {
      throw new Error("Pelo menos 1 scope obrigatório");
    }
    const key = await getKey();
    return new SignJWT({ scope: scopes.join(" ") })
      .setProtectedHeader({ alg: "RS256", kid: config.keyId, typ: "JWT" })
      .setIssuer(config.appId)
      .setAudience("bevox-meta-api")
      .setIssuedAt()
      .setExpirationTime(`${ttl}s`)
      .sign(key);
  };
}
