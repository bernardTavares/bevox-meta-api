/**
 * Service — admin gestão de ConsumerApp + AppKey.
 *
 * Geração de chaves: RSA 2048 via node:crypto. Private key é retornada UMA
 * VEZ na criação/rotação; nunca persistimos plaintext (Bevox-side é só a
 * pública).
 */

import { generateKeyPairSync } from "node:crypto";

import type { AppKey, ConsumerApp } from "@db/schema/index.js";

import { errors } from "@/lib/errors.js";

import {
  createConsumerAppWithKey,
  findConsumerAppById,
  listConsumerApps as listConsumerAppsRepo,
  rotateAppKey,
  setConsumerAppStatus,
} from "./repository.js";

const DEFAULT_GRACE_DAYS = 14;

export interface AppResponse {
  id: string;
  name: string;
  description: string | null;
  status: "active" | "deactivated";
  current_public_key_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateAppResponse extends AppResponse {
  key_id: string;
  /** Retornada UMA VEZ na criação. NUNCA persistida em plaintext. */
  private_key_pem: string;
}

export interface RotateKeyResponse {
  app_id: string;
  new_kid: string;
  superseded_keys: number;
  grace_window_days: number;
  /** Retornada UMA VEZ na rotação. */
  private_key_pem: string;
}

function toResponse(app: ConsumerApp): AppResponse {
  return {
    id: app.id,
    name: app.name,
    description: app.description,
    status: app.status,
    current_public_key_id: app.currentPublicKeyId,
    created_at: app.createdAt.toISOString(),
    updated_at: app.updatedAt.toISOString(),
  };
}

function generateRsaKeyPair(): { publicKeyPem: string; privateKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

export async function createApp(input: {
  name: string;
  description?: string;
}): Promise<CreateAppResponse> {
  const { publicKeyPem, privateKeyPem } = generateRsaKeyPair();
  const { app, key } = await createConsumerAppWithKey({
    name: input.name,
    description: input.description ?? null,
    publicKeyPem,
  });
  return {
    ...toResponse(app),
    key_id: key.id,
    private_key_pem: privateKeyPem,
  };
}

export async function listApps(): Promise<AppResponse[]> {
  const rows = await listConsumerAppsRepo();
  return rows.map(toResponse);
}

export async function rotateKey(input: {
  appId: string;
  graceWindowDays?: number;
}): Promise<RotateKeyResponse> {
  const app = await findConsumerAppById(input.appId);
  if (!app) throw errors.notFound("app", input.appId);
  if (app.status !== "active") {
    throw errors.conflict("cannot rotate key for inactive app", {
      app_id: input.appId,
      status: app.status,
    });
  }

  const { publicKeyPem, privateKeyPem } = generateRsaKeyPair();
  const grace = input.graceWindowDays ?? DEFAULT_GRACE_DAYS;
  const { newKey, supersededKeys } = await rotateAppKey({
    appId: input.appId,
    newPublicKeyPem: publicKeyPem,
    graceWindowDays: grace,
  });
  return {
    app_id: input.appId,
    new_kid: newKey.id,
    superseded_keys: supersededKeys,
    grace_window_days: grace,
    private_key_pem: privateKeyPem,
  };
}

export async function deactivateApp(appId: string): Promise<AppResponse> {
  const app = await findConsumerAppById(appId);
  if (!app) throw errors.notFound("app", appId);
  if (app.status === "deactivated") {
    throw errors.conflict("app already deactivated", { app_id: appId });
  }
  const row = await setConsumerAppStatus(appId, "deactivated");
  if (!row) throw errors.conflict("app state changed concurrently");
  return toResponse(row);
}

export type { AppKey };
