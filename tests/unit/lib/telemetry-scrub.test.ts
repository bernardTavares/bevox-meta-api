/**
 * Tests para `scrubSentryEvent` em `src/lib/telemetry.ts` — A2 (audit
 * 2026-06-02). Garantia: events Sentry NÃO podem conter tokens crus em
 * message, exception.values[*].value, breadcrumbs ou frames de stack.
 */

import { describe, expect, it } from "vitest";

import { scrubSentryEvent } from "@/lib/telemetry.js";

const FAKE_JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" +
  ".eyJzdWIiOiI0MiIsImlhdCI6MTcwMDAwMDAwMH0" +
  ".AbCdEf-GhIjKl_mNoPqR";
const FAKE_META = "EAAGm0PX4ZCpsBOZBfakeexamplelongLivedTokenAbCdEfGh1234";

describe("scrubSentryEvent — Sentry beforeSend", () => {
  it("scrubs event.message", () => {
    const ev: Record<string, unknown> = { message: `failed token=${FAKE_JWT}` };
    const out = scrubSentryEvent(ev);
    expect(out.message).toBe("failed token=[REDACTED_TOKEN]");
  });

  it("scrubs exception.values[*].value", () => {
    const ev: Record<string, unknown> = {
      exception: { values: [{ value: `boom with ${FAKE_META}` }] },
    };
    const out = scrubSentryEvent(ev) as {
      exception: { values: Array<{ value: string }> };
    };
    expect(out.exception.values[0]!.value).not.toContain(FAKE_META);
    expect(out.exception.values[0]!.value).toContain("[REDACTED_TOKEN]");
  });

  it("scrubs stacktrace context_line de cada frame", () => {
    const ev: Record<string, unknown> = {
      exception: {
        values: [
          {
            value: "ok",
            stacktrace: {
              frames: [
                { context_line: `await fetch(url, {Authorization: 'Bearer ${FAKE_JWT}'})` },
                { context_line: `meta.post(${FAKE_META})` },
              ],
            },
          },
        ],
      },
    };
    const out = scrubSentryEvent(ev) as {
      exception: { values: Array<{ stacktrace: { frames: Array<{ context_line: string }> } }> };
    };
    const frames = out.exception.values[0]!.stacktrace.frames;
    expect(frames[0]!.context_line).not.toContain(FAKE_JWT);
    expect(frames[1]!.context_line).not.toContain(FAKE_META);
    expect(frames[0]!.context_line).toContain("[REDACTED_TOKEN]");
    expect(frames[1]!.context_line).toContain("[REDACTED_TOKEN]");
  });

  it("scrubs breadcrumbs[].message", () => {
    const ev: Record<string, unknown> = {
      breadcrumbs: [{ message: `meta call token=${FAKE_JWT} returned 401` }, { message: "ok" }],
    };
    const out = scrubSentryEvent(ev) as { breadcrumbs: Array<{ message: string }> };
    expect(out.breadcrumbs[0]!.message).not.toContain(FAKE_JWT);
    expect(out.breadcrumbs[0]!.message).toContain("[REDACTED_TOKEN]");
    expect(out.breadcrumbs[1]!.message).toBe("ok");
  });

  it("event sem campos sensíveis passa intacto", () => {
    const ev: Record<string, unknown> = { event_id: "abc-123", level: "error" };
    const out = scrubSentryEvent(ev);
    expect(out).toEqual({ event_id: "abc-123", level: "error" });
  });
});
