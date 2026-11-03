/**
 * Tests for `src/lib/redact.ts` — string/stack scrubbing.
 *
 * Audit finding A2: tokens incrustados em stack trace (libs externas que
 * fazem string interpolation, mensagens de erro concatenando tokens) ou
 * em `AppError.details` nunca eram limpos antes do Pino. Estes testes
 * cobrem o módulo canônico que faz o scrub.
 */

import { describe, expect, it } from "vitest";

import { redactStringSecrets, serializeErrorRedacted, type SerializedError } from "@/lib/redact.js";

// Tokens-shape de teste — construídos sem segredos reais; só batem o regex.
// JWT shape canônico: header.body.signature (cada segmento base64url).
const FAKE_JWT_HEADER = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
const FAKE_JWT_BODY = "eyJzdWIiOiIxMjM0NSIsImlhdCI6MTcwMDAwMDAwMH0";
const FAKE_JWT_SIG = "AbCdEf-GhIjKl_mNoPqR";
const FAKE_JWT = `${FAKE_JWT_HEADER}.${FAKE_JWT_BODY}.${FAKE_JWT_SIG}`;
const FAKE_META_TOKEN = "EAAGm0PX4ZCpsBOZBfakeexamplelongLivedTokenAbCdEfGh1234";

describe("redactStringSecrets", () => {
  it("substitui JWT 3-segmentos em string arbitrária", () => {
    const input = `Auth failed for token=${FAKE_JWT} (user 42)`;
    const out = redactStringSecrets(input);
    expect(out).toBe("Auth failed for token=[REDACTED_TOKEN] (user 42)");
  });

  it("substitui Meta long-lived (EAA…) em string", () => {
    const input = `Meta GET failed: ${FAKE_META_TOKEN} 401`;
    const out = redactStringSecrets(input);
    expect(out).toBe("Meta GET failed: [REDACTED_TOKEN] 401");
  });

  it("substitui Authorization Bearer inline", () => {
    const input = `curl -H 'Authorization: Bearer ${FAKE_JWT}' https://x`;
    const out = redactStringSecrets(input) as string;
    // Bearer pattern absorbe o prefixo "Bearer …" inteiro.
    expect(out).not.toContain(FAKE_JWT);
    expect(out).toContain("[REDACTED_TOKEN]");
  });

  it("preserva strings normais sem tokens", () => {
    expect(redactStringSecrets("Plain error message, no secrets")).toBe(
      "Plain error message, no secrets",
    );
  });

  it("não modifica não-strings", () => {
    expect(redactStringSecrets(42)).toBe(42);
    expect(redactStringSecrets(null)).toBe(null);
    expect(redactStringSecrets(undefined)).toBe(undefined);
    expect(redactStringSecrets({ x: 1 })).toEqual({ x: 1 });
  });

  it("redacta múltiplos tokens na mesma string", () => {
    const input = `Tried ${FAKE_JWT} then fell back to ${FAKE_META_TOKEN}`;
    const out = redactStringSecrets(input) as string;
    expect(out).not.toContain(FAKE_JWT);
    expect(out).not.toContain(FAKE_META_TOKEN);
    expect(out.match(/\[REDACTED_TOKEN\]/g)?.length).toBe(2);
  });
});

describe("serializeErrorRedacted — stack redaction", () => {
  it("redacta JWT embarcado no err.stack", () => {
    // Construímos um Error e injetamos um stack sintético com o token.
    // É comum quando uma lib (fetch wrapper, ORM) faz string interpolation.
    const err = new Error("boom");
    err.stack = `Error: boom
    at fetchMeta (/app/meta-client.ts:42) — token=${FAKE_JWT}
    at processRequest (/app/server.ts:88)`;
    const out = serializeErrorRedacted(err);

    expect(out.stack).toBeDefined();
    expect(out.stack).not.toContain(FAKE_JWT);
    expect(out.stack).toContain("[REDACTED_TOKEN]");
  });

  it("redacta Meta access token (EAA…) no err.stack", () => {
    const err = new Error("upstream failure");
    err.stack = `Error: upstream failure
    at metaPost (line:55) — Authorization=${FAKE_META_TOKEN}
    at runWorker (line:90)`;
    const out = serializeErrorRedacted(err);

    expect(out.stack).not.toContain(FAKE_META_TOKEN);
    expect(out.stack).toContain("[REDACTED_TOKEN]");
  });

  it("redacta token em diferentes posições da stack (top, middle, bottom)", () => {
    const err = new Error("multi");
    err.stack = `Error: multi
    at topFrame /app/a.ts ${FAKE_JWT}
    at middleFrame /app/b.ts something
    at bottomFrame /app/c.ts ${FAKE_META_TOKEN}`;
    const out = serializeErrorRedacted(err);

    const stack = out.stack ?? "";
    expect(stack).not.toContain(FAKE_JWT);
    expect(stack).not.toContain(FAKE_META_TOKEN);
    // 2 substituições devem ter ocorrido.
    expect(stack.match(/\[REDACTED_TOKEN\]/g)?.length).toBe(2);
    // Frames preservados (apenas tokens substituídos).
    expect(stack).toContain("topFrame /app/a.ts");
    expect(stack).toContain("middleFrame /app/b.ts something");
    expect(stack).toContain("bottomFrame /app/c.ts");
  });

  it("redacta JWT na err.message (mensagem de erro com token concatenado)", () => {
    const err = new Error(`Token rejected: ${FAKE_JWT}`);
    const out = serializeErrorRedacted(err);
    expect(out.message).toBe("Token rejected: [REDACTED_TOKEN]");
  });

  it("preserva type/name do erro", () => {
    class CustomErr extends Error {
      override name = "MyDomainError";
    }
    const err = new CustomErr("plain");
    const out = serializeErrorRedacted(err);
    expect(out.type).toBe("MyDomainError");
    expect(out.message).toBe("plain");
  });

  it("não-Error (string thrown) cai em type:NonError", () => {
    const out = serializeErrorRedacted(`failed with ${FAKE_JWT}`);
    expect(out.type).toBe("NonError");
    expect(out.message).toBe("failed with [REDACTED_TOKEN]");
  });

  it("não-Error (number) é stringificado seguro", () => {
    const out = serializeErrorRedacted(42);
    expect(out.type).toBe("NonError");
    expect(out.message).toBe("42");
  });

  it("redacta chaves sensíveis em err.details (AppError.details)", () => {
    // Simulamos um AppError-like: tem `details` com access_token.
    const err = Object.assign(new Error("boom"), {
      details: {
        meta_endpoint: "/messages",
        access_token: "anything-sensitive",
        nested: { secret: "shh", text: { body: "olá" } },
      },
    });
    const out = serializeErrorRedacted(err) as SerializedError;
    const details = out.details as {
      meta_endpoint: string;
      access_token: string;
      nested: { secret: string; text: { body: string } };
    };
    expect(details.access_token).toBe("[REDACTED]");
    expect(details.nested.secret).toBe("[REDACTED]");
    // content/text/body NÃO é segredo para `redactSecrets` (preserva
    // mensagem para forwarding) — assertion garante esse contract.
    expect(details.nested.text.body).toBe("olá");
    expect(details.meta_endpoint).toBe("/messages");
  });

  it("redacta token-shape em string de err.details (após scrub de chaves)", () => {
    const err = Object.assign(new Error("meta call failed"), {
      details: {
        meta_response_body: `{"error":{"message":"Invalid token ${FAKE_META_TOKEN}"}}`,
      },
    });
    const out = serializeErrorRedacted(err) as SerializedError;
    const details = out.details as { meta_response_body: string };
    expect(details.meta_response_body).not.toContain(FAKE_META_TOKEN);
    expect(details.meta_response_body).toContain("[REDACTED_TOKEN]");
  });

  it("redacta cause (Error encadeado)", () => {
    const inner = new Error(`Inner token leak: ${FAKE_JWT}`);
    const outer = new Error("outer", { cause: inner });
    const out = serializeErrorRedacted(outer);
    expect(out.cause).toBeDefined();
    const cause = out.cause as SerializedError;
    expect(cause.message).toBe("Inner token leak: [REDACTED_TOKEN]");
  });

  it("redacta cause quando cause é string com token", () => {
    const outer = Object.assign(new Error("outer"), {
      cause: `fetch failed (${FAKE_META_TOKEN})`,
    });
    const out = serializeErrorRedacted(outer);
    expect(out.cause).toBe("fetch failed ([REDACTED_TOKEN])");
  });

  it("idempotente — chamar duas vezes não introduz mudanças", () => {
    const err = new Error(`token=${FAKE_JWT}`);
    const first = serializeErrorRedacted(err);
    // Mesmo Error reaproveitado — em produção `request.log.error` chama uma
    // vez, mas vale garantir que rechamar com o output não amplifica.
    const second = serializeErrorRedacted({
      name: first.type,
      message: first.message,
      stack: first.stack,
    });
    expect(second.message).toBe(first.message);
    expect(second.message).not.toContain(FAKE_JWT);
  });
});
