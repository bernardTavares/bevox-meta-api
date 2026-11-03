/**
 * Redact / seal helpers para jobs BullMQ — fix A3 (audit 2026-06-02).
 *
 * Problema: `POST /v1/messages/async` enfileirava `OutboundJobPayload` cru
 * em Redis (BullMQ) contendo `request_body` (PII: número de telefone,
 * conteúdo de mensagem) e `callback_secret` (segredo compartilhado para
 * assinatura HMAC do callback). Qualquer leitor de Redis (operador,
 * snapshot, backup, log de eval) via os dois em plaintext — vetor de
 * exfiltração comparável a vazamento de DB.
 *
 * Fix: ao enfileirar, cifra os campos sensíveis (`request_body` +
 * `callback_secret`) com AES-256-GCM via envelope encryption (MA-008,
 * mesmo crypto-envelope.ts dos tokens Meta). Em Redis fica apenas o
 * blob ciphertext + metadados de KMS; o worker decifra no consumo.
 *
 * Contexto KMS (AAD): `{ app_id, tenant_id, job_id, kind: "outbound-job-v1" }`
 * — amarra o ciphertext ao job específico; tentativa de swap entre
 * jobs/tenants falha decryption.
 *
 * NÃO usar para logs/audit: `redact()` / `redactSecrets()` em
 * `src/lib/logger.ts` continuam sendo os helpers corretos para
 * scrub destrutivo de PII em log paths.
 */

import { decryptToken, encryptToken } from "@/lib/crypto-envelope.js";
import type { EncryptionContext } from "@/integration/kms-client.js";
import { env } from "@/config/env.js";
import { errors } from "@/lib/errors.js";

/**
 * Estrutura do ciphertext serializado no payload do job BullMQ.
 *
 * Todos os Buffers são serializados como base64 — BullMQ usa JSON.stringify
 * sobre o payload e `Buffer` puro vira `{ "type": "Buffer", "data": [...] }`
 * (4x maior + frágil ao round-trip).
 */
export interface SealedSecrets {
  /** Identificador da KEK usada para cifrar a DEK. */
  kek_key_id: string;
  /** Identificador retornado pelo provider (LocalKMS / GCP-KMS) p/ a DEK cifrada. */
  dek_key_id: string;
  /** DEK cifrada pela KEK (base64). */
  dek_ciphertext_b64: string;
  /** Nonce AES-GCM (12 bytes, base64). */
  nonce_b64: string;
  /** Auth tag AES-GCM (16 bytes, base64). */
  auth_tag_b64: string;
  /** Ciphertext do plaintext sealed (base64). */
  ciphertext_b64: string;
  /** Versão do algoritmo do envelope (AES-256-GCM-v1). */
  algo: string;
  /** Encryption context (AAD); echoed para decryption. */
  encryption_context: EncryptionContext;
}

/**
 * Plaintext sensível extraído do payload de outbound-job antes do seal.
 * Cifrado como bloco único para evitar 2 round-trips ao KMS.
 */
export interface OutboundJobSecrets {
  /** Body normalizado do request /v1/messages/async (PII: to, content). */
  request_body: Record<string, unknown>;
  /** Shared secret para HMAC do callback (se presente no request). */
  callback_secret?: string;
}

function resolveKekKeyId(): string {
  // Reusa a KEK configurada para tokens (KMS_KEY_ID). Não introduzimos
  // KEK separada para jobs — manter superfície KMS pequena.
  const cfg = env();
  if (!cfg.KMS_KEY_ID) {
    throw errors.internal("KMS_KEY_ID missing — cannot seal outbound job secrets");
  }
  return cfg.KMS_KEY_ID;
}

/**
 * Cifra os campos sensíveis de um outbound-job em um blob único.
 *
 * Encryption context (AAD) amarra ao job específico:
 *   `{ kind: "outbound-job-v1", app_id, tenant_id, job_id }`
 *
 * Tentativa de swap (mover SealedSecrets de um job_id para outro) falha
 * decryption — auth tag verifica AAD.
 */
export async function sealOutboundJobSecrets(input: {
  appId: string;
  tenantId: string;
  jobId: string;
  secrets: OutboundJobSecrets;
}): Promise<SealedSecrets> {
  const kekKeyId = resolveKekKeyId();
  const ctx: EncryptionContext = {
    kind: "outbound-job-v1",
    app_id: input.appId,
    tenant_id: input.tenantId,
    job_id: input.jobId,
  };

  const plaintext = Buffer.from(JSON.stringify(input.secrets), "utf8");
  const envelope = await encryptToken(plaintext, kekKeyId, ctx);
  // Zera o plaintext após uso (best-effort; JSON.stringify pode ter cópias).
  plaintext.fill(0);

  return {
    kek_key_id: kekKeyId,
    dek_key_id: envelope.dekKeyId,
    dek_ciphertext_b64: envelope.dekCiphertext.toString("base64"),
    nonce_b64: envelope.nonce.toString("base64"),
    auth_tag_b64: envelope.authTag.toString("base64"),
    ciphertext_b64: envelope.ciphertext.toString("base64"),
    algo: envelope.algo,
    encryption_context: ctx,
  };
}

/**
 * Decifra o blob `SealedSecrets` produzido por `sealOutboundJobSecrets`.
 * Lança `errors.internal` se o encryption_context não confere (swap)
 * ou se o ciphertext foi adulterado.
 */
export async function unsealOutboundJobSecrets(sealed: SealedSecrets): Promise<OutboundJobSecrets> {
  const plaintext = await decryptToken({
    ciphertext: Buffer.from(sealed.ciphertext_b64, "base64"),
    dekCiphertext: Buffer.from(sealed.dek_ciphertext_b64, "base64"),
    dekKeyId: sealed.dek_key_id,
    encryptionContext: sealed.encryption_context,
    algo: sealed.algo,
    nonce: Buffer.from(sealed.nonce_b64, "base64"),
    authTag: Buffer.from(sealed.auth_tag_b64, "base64"),
  });
  try {
    const decoded = JSON.parse(plaintext.toString("utf8")) as OutboundJobSecrets;
    if (!decoded || typeof decoded !== "object" || !decoded.request_body) {
      throw errors.internal("Sealed outbound-job payload missing request_body after decrypt");
    }
    return decoded;
  } finally {
    plaintext.fill(0);
  }
}
