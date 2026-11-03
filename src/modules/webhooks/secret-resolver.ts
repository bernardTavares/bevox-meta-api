/**
 * Resolve o secret HMAC plaintext de uma WebhookSubscription via envelope
 * decryption (MA-008).
 *
 * Caller deve usar o secret IMEDIATAMENTE para HMAC e não logá-lo
 * (CLAUDE.md §5.4).
 */

import type { WebhookSubscription } from "@db/schema/index.js";

import { decryptToken } from "@/lib/crypto-envelope.js";

export async function resolveSubscriptionSecret(sub: WebhookSubscription): Promise<string> {
  const plaintext = await decryptToken({
    ciphertext: sub.secretCiphertext,
    dekCiphertext: sub.secretDekCiphertext,
    dekKeyId: sub.secretDekKeyId,
    encryptionContext: sub.secretEncryptionContext as Record<string, string>,
    algo: sub.secretAlgo,
    nonce: sub.secretNonce,
    authTag: sub.secretAuthTag,
  });
  try {
    return plaintext.toString("utf8");
  } finally {
    plaintext.fill(0);
  }
}
