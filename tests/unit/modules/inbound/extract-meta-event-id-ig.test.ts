/**
 * A8 fix (audit 2026-06-02) — Instagram inbound events agora têm
 * `mid` extraído para dedup. Antes, `extractMetaEventId` só conhecia
 * a shape WhatsApp (`messages[].id`, `statuses[].id`) → todo webhook
 * IG passava por `null` → dedup desligado → re-deliveries da Meta
 * entravam duplicadas no banco.
 *
 * Teste do extrator puro (exportado para testabilidade) — integration
 * end-to-end com Redis mock dedup é coberta separadamente.
 */

import { describe, it, expect } from "vitest";

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "fatal";
process.env.DATABASE_URL = "postgresql://b:p@l/t";
process.env.REDIS_URL = "redis://localhost:6379";
process.env.KMS_PROVIDER = "local";
process.env.KMS_KEY_ID = "test-key";
process.env.KMS_LOCAL_MASTER_KEY = Buffer.alloc(32, 0x42).toString("base64");
process.env.ADMIN_API_KEY = "test-admin-key-1234";

describe("extractMetaEventId — IG shapes (A8)", () => {
  it("WhatsApp `messages[].id` continua extraído (regressão)", async () => {
    const { extractMetaEventId } = await import("@/modules/inbound/service.js");
    expect(extractMetaEventId("messages", { messages: [{ id: "wa-msg-1" }] })).toBe("wa-msg-1");
  });

  it("WhatsApp `statuses[].id` continua extraído (regressão)", async () => {
    const { extractMetaEventId } = await import("@/modules/inbound/service.js");
    expect(extractMetaEventId("statuses", { statuses: [{ id: "wa-status-1" }] })).toBe(
      "wa-status-1",
    );
  });

  it("IG `messaging[].message.mid` → extraído", async () => {
    const { extractMetaEventId } = await import("@/modules/inbound/service.js");
    const value = {
      messaging: [
        {
          sender: { id: "u1" },
          recipient: { id: "p1" },
          timestamp: 1700000000,
          message: { mid: "ig-mid-abc" },
        },
      ],
    };
    expect(extractMetaEventId(undefined, value)).toBe("ig-mid-abc");
  });

  it("IG `messaging[].read.mid` (read receipt) → extraído", async () => {
    const { extractMetaEventId } = await import("@/modules/inbound/service.js");
    const value = {
      messaging: [
        {
          sender: { id: "u1" },
          timestamp: 1700000001,
          read: { mid: "ig-mid-read" },
        },
      ],
    };
    expect(extractMetaEventId(undefined, value)).toBe("ig-mid-read");
  });

  it("IG `messaging[].reaction.mid` → extraído", async () => {
    const { extractMetaEventId } = await import("@/modules/inbound/service.js");
    const value = {
      messaging: [
        {
          sender: { id: "u1" },
          timestamp: 1700000002,
          reaction: { mid: "ig-mid-reaction" },
        },
      ],
    };
    expect(extractMetaEventId(undefined, value)).toBe("ig-mid-reaction");
  });

  it("IG event sem mid mas com sender+timestamp → fallback `ig:<sender>:<ts>`", async () => {
    const { extractMetaEventId } = await import("@/modules/inbound/service.js");
    const value = {
      messaging: [
        {
          sender: { id: "user-99" },
          timestamp: 1700000003,
          // sem message/read/reaction
        },
      ],
    };
    expect(extractMetaEventId(undefined, value)).toBe("ig:user-99:1700000003");
  });

  it("IG event totalmente vazio → null (sem chave estável)", async () => {
    const { extractMetaEventId } = await import("@/modules/inbound/service.js");
    const value = { messaging: [{}] };
    expect(extractMetaEventId(undefined, value)).toBeNull();
  });

  it("payload sem messages/statuses/messaging → null (regressão WA)", async () => {
    const { extractMetaEventId } = await import("@/modules/inbound/service.js");
    expect(extractMetaEventId(undefined, { other: "field" })).toBeNull();
    expect(extractMetaEventId(undefined, undefined)).toBeNull();
  });
});
