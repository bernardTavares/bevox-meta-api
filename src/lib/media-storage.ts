/**
 * Abstração de storage de mídia S3-compatible (MinIO em V1; portável a R2/S3).
 * Privada do meta-api (ADR-012). Key = {tenant_id}/{media_id}. URLs pré-assinadas
 * TTL curto; NUNCA logar a URL.
 */
import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { env } from "@/config/env.js";

let client: S3Client | null = null;
function s3(): S3Client {
  if (!client) {
    const e = env();
    if (!e.MEDIA_S3_ENDPOINT || !e.MEDIA_S3_ACCESS_KEY || !e.MEDIA_S3_SECRET_KEY) {
      throw new Error("media storage não configurado (MEDIA_S3_* ausente)");
    }
    client = new S3Client({
      endpoint: e.MEDIA_S3_ENDPOINT,
      region: e.MEDIA_S3_REGION,
      credentials: {
        accessKeyId: e.MEDIA_S3_ACCESS_KEY,
        secretAccessKey: e.MEDIA_S3_SECRET_KEY,
      },
      forcePathStyle: true,
    });
  }
  return client;
}

function bucket(): string {
  const b = env().MEDIA_S3_BUCKET;
  if (!b) {
    throw new Error("media storage não configurado (MEDIA_S3_BUCKET ausente)");
  }
  return b;
}

const SAFE = /^[A-Za-z0-9._:-]+$/;
export function mediaObjectKey(tenantId: string, mediaId: string): string {
  if (
    !tenantId ||
    !mediaId ||
    !SAFE.test(tenantId) ||
    !SAFE.test(mediaId) ||
    tenantId === ".." ||
    mediaId === ".."
  ) {
    throw new Error("invalid media key part");
  }
  return `${tenantId}/${mediaId}`;
}

export async function putMedia(key: string, bytes: Buffer, contentType: string): Promise<void> {
  await s3().send(
    new PutObjectCommand({ Bucket: bucket(), Key: key, Body: bytes, ContentType: contentType }),
  );
}

export async function headMedia(key: string): Promise<boolean> {
  try {
    await s3().send(new HeadObjectCommand({ Bucket: bucket(), Key: key }));
    return true;
  } catch {
    return false;
  }
}

export async function getPresignedUrl(key: string, ttlSeconds: number): Promise<string> {
  return getSignedUrl(s3(), new GetObjectCommand({ Bucket: bucket(), Key: key }), {
    expiresIn: ttlSeconds,
  });
}

export async function deleteMedia(key: string): Promise<void> {
  await s3().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
}

/** Enumera keys de um tenant (prefixo) — usado no DSR erasure cascade. */
export async function listMediaKeys(tenantId: string): Promise<string[]> {
  const out: string[] = [];
  let token: string | undefined;
  do {
    const r = await s3().send(
      new ListObjectsV2Command({
        Bucket: bucket(),
        Prefix: `${tenantId}/`,
        ContinuationToken: token,
      }),
    );
    for (const o of r.Contents ?? []) if (o.Key) out.push(o.Key);
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return out;
}
