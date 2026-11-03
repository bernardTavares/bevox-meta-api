/**
 * Envelope encryption — MA-008.
 *
 * Cifra plaintext arbitrário usando DEK efêmera (AES-256-GCM) e cifra a DEK
 * com KEK do KMS. AAD = encryption_context para amarrar o ciphertext ao
 * tenant/scope.
 *
 * Fluxo encryptToken:
 *   1. KMS.generateDataKey(keyId, ctx) → { dek, dek_ciphertext }
 *   2. nonce = randomBytes(12)
 *   3. AES-256-GCM.encrypt(dek, plaintext, aad=ctx) → { ct, auth_tag }
 *   4. zera DEK plaintext em memória
 *   5. retorna EnvelopeOutput
 *
 * Fluxo decryptToken:
 *   1. KMS.decryptDataKey(dek_ciphertext, dek_key_id, ctx) → dek
 *   2. AES-256-GCM.decrypt(dek, ct, nonce, auth_tag, aad=ctx) → plaintext
 *   3. zera DEK e plaintext após uso (caller deve zerar plaintext)
 *
 * NUNCA logar plaintext, DEK, nem ciphertext (PII risk).
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { getKmsClient, type EncryptionContext, type KmsClient } from "@/integration/kms-client.js";
import { errors } from "@/lib/errors.js";

export const ALGO_VERSION = "AES-256-GCM-v1";

export interface EnvelopeOutput {
  ciphertext: Buffer;
  dekCiphertext: Buffer;
  dekKeyId: string;
  encryptionContext: EncryptionContext;
  algo: string;
  nonce: Buffer;
  authTag: Buffer;
}

export interface EnvelopeInput {
  ciphertext: Buffer;
  dekCiphertext: Buffer;
  dekKeyId: string;
  encryptionContext: EncryptionContext;
  algo: string;
  nonce: Buffer;
  authTag: Buffer;
}

function aadBytes(context: EncryptionContext): Buffer {
  const sorted = Object.keys(context).sort();
  const canonical: Record<string, string> = {};
  for (const k of sorted) canonical[k] = context[k]!;
  return Buffer.from(JSON.stringify(canonical), "utf8");
}

function zeroize(buf: Buffer): void {
  buf.fill(0);
}

/**
 * Cifra `plaintext` (Buffer) sob a KEK identificada por `kekKeyId` com AAD
 * derivada de `context`. Retorna estrutura para persistência direta nas
 * tabelas waba_tokens / ig_tokens / webhook_subscriptions.
 */
export async function encryptToken(
  plaintext: Buffer,
  kekKeyId: string,
  context: EncryptionContext,
  kms: KmsClient = getKmsClient(),
): Promise<EnvelopeOutput> {
  if (plaintext.length === 0) {
    throw errors.internal("encryptToken: plaintext is empty");
  }

  const dataKey = await kms.generateDataKey(kekKeyId, context);
  const nonce = randomBytes(12);
  try {
    const cipher = createCipheriv("aes-256-gcm", dataKey.plaintext, nonce);
    cipher.setAAD(aadBytes(context));
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();

    return {
      ciphertext: ct,
      dekCiphertext: dataKey.ciphertext,
      dekKeyId: dataKey.keyId,
      encryptionContext: context,
      algo: ALGO_VERSION,
      nonce,
      authTag: tag,
    };
  } finally {
    zeroize(dataKey.plaintext);
  }
}

/**
 * Decifra um token cifrado com `encryptToken`. Caller é responsável por
 * zerar o Buffer retornado quando terminar.
 */
export async function decryptToken(
  input: EnvelopeInput,
  kms: KmsClient = getKmsClient(),
): Promise<Buffer> {
  if (input.algo !== ALGO_VERSION) {
    throw errors.internal(`Unsupported envelope algo: ${input.algo}`);
  }
  if (input.nonce.length !== 12) {
    throw errors.internal("Invalid nonce length (expected 12 bytes)");
  }
  if (input.authTag.length !== 16) {
    throw errors.internal("Invalid auth tag length (expected 16 bytes)");
  }

  const dek = await kms.decryptDataKey(
    input.dekCiphertext,
    input.dekKeyId,
    input.encryptionContext,
  );
  try {
    const decipher = createDecipheriv("aes-256-gcm", dek, input.nonce);
    decipher.setAAD(aadBytes(input.encryptionContext));
    decipher.setAuthTag(input.authTag);
    return Buffer.concat([decipher.update(input.ciphertext), decipher.final()]);
  } catch (err) {
    throw errors.internal("Envelope decryption failed (auth tag/aad mismatch)", err);
  } finally {
    zeroize(dek);
  }
}
