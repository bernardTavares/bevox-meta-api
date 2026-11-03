import { describe, expect, it } from "vitest";

import { redact, redactSecrets } from "@/lib/logger.js";

describe("redactSecrets (persisted/forwarded payload — preserves message content, scrubs secrets)", () => {
  it("PRESERVES message content (text/body/content)", () => {
    const wa = {
      messages: [{ type: "text", text: { body: "olá quero agendar" } }],
      contacts: [{ profile: { name: "João" } }],
    };
    const r = redactSecrets(wa) as {
      messages: Array<{ text: { body: string } }>;
      contacts: Array<{ profile: { name: string } }>;
    };
    expect(r.messages[0]!.text.body).toBe("olá quero agendar"); // NOT [REDACTED]
    expect(r.contacts[0]!.profile.name).toBe("João");
  });

  it("STILL scrubs secrets", () => {
    const r = redactSecrets({
      access_token: "tok",
      secret: "s",
      authorization: "Bearer x",
      nested: { password: "p" },
    }) as {
      access_token: string;
      secret: string;
      authorization: string;
      nested: { password: string };
    };
    expect(r.access_token).toBe("[REDACTED]");
    expect(r.secret).toBe("[REDACTED]");
    expect(r.authorization).toBe("[REDACTED]");
    expect(r.nested.password).toBe("[REDACTED]");
  });

  it("redact() (logs) still censors content (unchanged)", () => {
    expect((redact({ text: { body: "x" } }) as { text: string }).text).toBe("[REDACTED]");
  });
});

describe("OAuth code/state — redaction em redact() e redactSecrets()", () => {
  it("redact() censura chave code em raiz", () => {
    const r = redact({ code: "FB_AUTH_CODE_XYZ", other: "ok" }) as {
      code: string;
      other: string;
    };
    expect(r.code).toBe("[REDACTED]");
    expect(r.other).toBe("ok");
  });

  it("redact() censura chave state em raiz", () => {
    const r = redact({ state: "OPAQUE_STATE_TOKEN_XYZ" }) as { state: string };
    expect(r.state).toBe("[REDACTED]");
  });

  it("redact() censura code/state aninhados", () => {
    const r = redact({
      query: { code: "FB_AUTH_CODE", state: "STATE_TOKEN" },
      meta: { error_description: "user_cancelled with PII" },
    }) as {
      query: { code: string; state: string };
      meta: { error_description: string };
    };
    expect(r.query.code).toBe("[REDACTED]");
    expect(r.query.state).toBe("[REDACTED]");
    expect(r.meta.error_description).toBe("[REDACTED]");
  });

  it("redactSecrets() também censura code/state (secret-only set)", () => {
    const r = redactSecrets({
      code: "FB_AUTH_CODE",
      state: "STATE",
      payload: { text: { body: "olá" }, code: "CODE_NESTED" },
    }) as {
      code: string;
      state: string;
      payload: { text: { body: string }; code: string };
    };
    expect(r.code).toBe("[REDACTED]");
    expect(r.state).toBe("[REDACTED]");
    expect(r.payload.code).toBe("[REDACTED]");
    // message content NÃO é secret — preservado por redactSecrets
    expect(r.payload.text.body).toBe("olá");
  });
});
