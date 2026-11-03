/**
 * Pub/sub Redis para eventos realtime (SSE).
 *
 * Canal: `events:<app_id>`. Payload é JSON do `EventBusMessage`.
 * Subscribers filtram por tenant_id em-memória se necessário.
 */

import { Redis } from "ioredis";

import { env } from "@/config/env.js";

export interface EventBusMessage {
  event_id: string;
  event_type: string;
  app_id: string;
  tenant_id: string | null;
  occurred_at: string;
  data: unknown;
}

const channelFor = (appId: string): string => `events:${appId}`;

let publisher: Redis | null = null;

function pub(): Redis {
  if (publisher === null) {
    publisher = new Redis(env().REDIS_URL, { lazyConnect: false });
  }
  return publisher;
}

export async function publishEvent(message: EventBusMessage): Promise<void> {
  await pub().publish(channelFor(message.app_id), JSON.stringify(message));
}

/**
 * Cria subscriber dedicado para um app. ioredis exige conexão exclusiva
 * em modo subscribe. Caller fecha via `.quit()` quando termina.
 */
export function createEventSubscriber(appId: string): {
  subscriber: Redis;
  channel: string;
} {
  const subscriber = new Redis(env().REDIS_URL, { lazyConnect: false });
  return { subscriber, channel: channelFor(appId) };
}

export async function closeEventBus(): Promise<void> {
  if (publisher) {
    const p = publisher;
    publisher = null;
    await p.quit();
  }
}

export function __resetEventBusForTests(): void {
  publisher = null;
}
