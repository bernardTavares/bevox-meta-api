/**
 * Cliente KMS — abstração sobre o provider real (AWS KMS, GCP KMS) com
 * implementação `local` para dev/test (NUNCA usar em produção; o env validator
 * já bloqueia isso — ver src/config/env.ts).
 *
 * Contrato:
 *   - generateDataKey(keyId, aad) → { plaintext: Buffer(32), ciphertext: Buffer }
 *   - decryptDataKey(ciphertext, keyId, aad) → plaintext: Buffer(32)
 *
 * AAD (additional authenticated data) carrega o `encryption_context` do MA-008
 * e é validado pelo provider — proteção anti-swap entre tenants/wabas.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { KeyManagementServiceClient } from "@google-cloud/kms";

import { env } from "@/config/env.js";
import { errors } from "@/lib/errors.js";

export type EncryptionContext = Record<string, string>;

export interface DataKey {
  plaintext: Buffer;
  ciphertext: Buffer;
  keyId: string;
}

export interface KmsClient {
  generateDataKey(keyId: string, context: EncryptionContext): Promise<DataKey>;
  decryptDataKey(ciphertext: Buffer, keyId: string, context: EncryptionContext): Promise<Buffer>;
  /**
   * Read-only liveness probe usado por `/readyz`. Implementações DEVEM
   * exercitar a credencial + endpoint reais (não apenas o construtor lazy)
   * para evitar A19: readyz verde com KMS quebrado (broken OAuth/cifra em
   * silêncio). Lançar em qualquer falha (timeout, 401, 403, 5xx, etc.).
   */
  healthCheck(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Local provider — KEK derivada de KMS_LOCAL_MASTER_KEY (dev/test only).
// ---------------------------------------------------------------------------

const LOCAL_KEK_VERSION = 1;
const LOCAL_PROVIDER_PREFIX = "local-kms";

function loadLocalMasterKey(): Buffer {
  const cfg = env();
  if (cfg.KMS_PROVIDER !== "local") {
    throw errors.internal("Local KMS used while KMS_PROVIDER != 'local'");
  }
  if (!cfg.KMS_LOCAL_MASTER_KEY) {
    throw errors.internal("KMS_LOCAL_MASTER_KEY missing");
  }
  const buf = Buffer.from(cfg.KMS_LOCAL_MASTER_KEY, "base64");
  if (buf.length < 32) {
    throw errors.internal("KMS_LOCAL_MASTER_KEY must be ≥ 32 bytes (base64)");
  }
  return buf.subarray(0, 32);
}

function aadBytes(context: EncryptionContext, keyId: string): Buffer {
  const sortedKeys = Object.keys(context).sort();
  const canonical: Record<string, string> = {};
  for (const k of sortedKeys) canonical[k] = context[k]!;
  const blob = JSON.stringify({ keyId, ctx: canonical });
  return Buffer.from(blob, "utf8");
}

class LocalKmsClient implements KmsClient {
  async healthCheck(): Promise<void> {
    // Provider local: força carregar a master key + verifica que é AES-256
    // utilizável. Síncrono in-process, então não há timeout/network a
    // preocupar. Falha aqui = config corrompida ou env não-validado.
    const kek = loadLocalMasterKey();
    if (kek.length !== 32) {
      throw errors.internal(`Local KEK length != 32 (got ${kek.length})`);
    }
  }

  async generateDataKey(keyId: string, context: EncryptionContext): Promise<DataKey> {
    const dek = randomBytes(32);
    const ciphertext = await this.encryptDek(dek, keyId, context);
    return { plaintext: dek, ciphertext, keyId: this.formatKeyId(keyId) };
  }

  async decryptDataKey(
    ciphertext: Buffer,
    keyId: string,
    context: EncryptionContext,
  ): Promise<Buffer> {
    // Formato local: [1 byte version][12 byte iv][16 byte tag][...rest = ciphertext]
    if (ciphertext.length < 1 + 12 + 16) {
      throw errors.internal("Local KMS ciphertext too short");
    }
    const version = ciphertext.readUInt8(0);
    if (version !== LOCAL_KEK_VERSION) {
      throw errors.internal(`Unsupported local KEK version: ${version}`);
    }
    const iv = ciphertext.subarray(1, 13);
    const tag = ciphertext.subarray(13, 29);
    const enc = ciphertext.subarray(29);

    const kek = loadLocalMasterKey();
    const decipher = createDecipheriv("aes-256-gcm", kek, iv);
    decipher.setAAD(aadBytes(context, this.normalizeKeyId(keyId)));
    decipher.setAuthTag(tag);
    try {
      const dek = Buffer.concat([decipher.update(enc), decipher.final()]);
      if (dek.length !== 32) throw new Error("DEK length != 32");
      return dek;
    } catch (err) {
      throw errors.internal("Local KMS DEK decryption failed", err);
    }
  }

  private formatKeyId(rawKeyId: string): string {
    return `${LOCAL_PROVIDER_PREFIX}:${rawKeyId}:v${LOCAL_KEK_VERSION}`;
  }

  private normalizeKeyId(keyId: string): string {
    // Permite passar tanto o ID cru quanto o formatado.
    return keyId.startsWith(`${LOCAL_PROVIDER_PREFIX}:`) ? keyId : this.formatKeyId(keyId);
  }

  private async encryptDek(
    dek: Buffer,
    keyId: string,
    context: EncryptionContext,
  ): Promise<Buffer> {
    const kek = loadLocalMasterKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", kek, iv);
    cipher.setAAD(aadBytes(context, this.formatKeyId(keyId)));
    const enc = Buffer.concat([cipher.update(dek), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([Buffer.from([LOCAL_KEK_VERSION]), iv, tag, enc]);
  }
}

// ---------------------------------------------------------------------------
// GCP provider — envelope encryption via Cloud KMS (MA-008).
// ---------------------------------------------------------------------------

const GCP_KEK_NAMES = new Set(["waba-tokens", "ig-tokens", "webhook-secrets"]);

export class GcpKmsClient implements KmsClient {
  constructor(
    private readonly client: KeyManagementServiceClient = new KeyManagementServiceClient(),
  ) {}

  /**
   * A19 v2 (audit 2026-06-03): exercitar exatamente o chain de perms que o
   * runtime usa (encrypt + decrypt sobre cryptoKey real), não um proxy mais
   * frouxo.
   *
   * Versão anterior chamava `getKeyRing` (metadata) achando que era barato e
   * suficiente — mas exige `cloudkms.keyRings.get` (role `cloudkms.viewer`),
   * perm DIFERENTE de `cryptoKeyEncrypterDecrypter` que o runtime de fato
   * precisa. Resultado: `/readyz` ficava 503 mesmo com IAM 100% correto
   * para operações reais, exigindo grant extra de `viewer` puramente para
   * o probe (defesa-em-profundidade às avessas).
   *
   * Agora encriptamos+decifrar um sentinel mínimo (`readyz-probe`) via
   * `webhook-secrets` (qualquer cryptoKey do keyring serviria; este foi
   * escolhido por estar fora do hot-path de OAuth/messages). Custo:
   * 2 ops × probe ≈ < US$1/mês (GCP KMS: US$0,03 / 10k ops).
   */
  async healthCheck(): Promise<void> {
    const cryptoKeyName = `${env().KMS_KEY_ID}/cryptoKeys/webhook-secrets`;
    const probe = Buffer.from("readyz-probe", "utf8");
    try {
      const [encResp] = await this.client.encrypt({ name: cryptoKeyName, plaintext: probe });
      if (!encResp.ciphertext) {
        throw errors.internal("GCP KMS encrypt returned empty ciphertext");
      }
      const [decResp] = await this.client.decrypt({
        name: cryptoKeyName,
        ciphertext: encResp.ciphertext,
      });
      const recovered = decResp.plaintext
        ? Buffer.from(decResp.plaintext as Uint8Array).toString("utf8")
        : "";
      if (recovered !== "readyz-probe") {
        throw errors.internal(`GCP KMS roundtrip mismatch: got ${JSON.stringify(recovered)}`);
      }
    } catch (err) {
      throw errors.internal("GCP KMS healthCheck failed", err);
    }
  }

  private resolveCryptoKey(logicalId: string): string {
    // Esperado: "bevox-meta-api/<name>/v<n>"
    const name = logicalId.split("/")[1];
    if (!name || !GCP_KEK_NAMES.has(name)) {
      throw errors.internal(`Unknown GCP KEK id: ${logicalId}`);
    }
    return `${env().KMS_KEY_ID}/cryptoKeys/${name}`;
  }

  async generateDataKey(keyId: string, context: EncryptionContext): Promise<DataKey> {
    const cryptoKey = this.resolveCryptoKey(keyId);
    const aad = aadBytes(context, keyId);
    const dek = randomBytes(32);

    let rawCiphertext: string | Uint8Array | Buffer | null | undefined;
    try {
      const [resp] = await this.client.encrypt({
        name: cryptoKey,
        plaintext: dek,
        additionalAuthenticatedData: aad,
      });
      rawCiphertext = resp?.ciphertext;
    } catch (err) {
      throw errors.internal("GCP KMS encrypt failed", err);
    }
    if (!rawCiphertext) {
      throw errors.internal("GCP KMS encrypt returned empty ciphertext");
    }
    const ciphertext =
      typeof rawCiphertext === "string"
        ? Buffer.from(rawCiphertext, "base64")
        : Buffer.from(rawCiphertext);
    return { plaintext: dek, ciphertext, keyId };
  }

  async decryptDataKey(
    ciphertext: Buffer,
    keyId: string,
    context: EncryptionContext,
  ): Promise<Buffer> {
    const cryptoKey = this.resolveCryptoKey(keyId);
    const aad = aadBytes(context, keyId);

    let rawPlaintext: string | Uint8Array | Buffer | null | undefined;
    try {
      const [resp] = await this.client.decrypt({
        name: cryptoKey,
        ciphertext,
        additionalAuthenticatedData: aad,
      });
      rawPlaintext = resp?.plaintext;
    } catch (err) {
      throw errors.internal("GCP KMS decrypt failed", err);
    }

    if (!rawPlaintext) {
      throw errors.internal("GCP KMS decrypt returned empty plaintext");
    }
    const dek =
      typeof rawPlaintext === "string"
        ? Buffer.from(rawPlaintext, "base64")
        : Buffer.from(rawPlaintext);
    if (dek.length !== 32) {
      throw errors.internal(`GCP KMS DEK length != 32 (got ${dek.length})`);
    }
    return dek;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

let cached: KmsClient | null = null;

export function getKmsClient(): KmsClient {
  if (cached) return cached;
  const cfg = env();
  switch (cfg.KMS_PROVIDER) {
    case "local":
      cached = new LocalKmsClient();
      return cached;
    case "gcp":
      cached = new GcpKmsClient();
      return cached;
    case "aws":
      throw errors.internal(`KMS provider "aws" not implemented yet (task-master pendente)`);
  }
}

export function __resetKmsClientForTests(): void {
  cached = null;
}
