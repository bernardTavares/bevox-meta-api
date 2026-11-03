import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const REQUIRED_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  LOG_LEVEL: "fatal",
  DATABASE_URL: "postgresql://bevox:pwd@localhost:5432/test",
  REDIS_URL: "redis://localhost:6379",
  KMS_PROVIDER: "local",
  KMS_KEY_ID: "test-key",
  KMS_LOCAL_MASTER_KEY: Buffer.alloc(32, 0x42).toString("base64"),
  ADMIN_API_KEY: "test-admin-key-1234",
};

const undiciState = vi.hoisted(() => ({
  request: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));

vi.mock("undici", () => ({
  request: (url: unknown, opts: unknown) => undiciState.request(url, opts),
}));

beforeAll(() => {
  for (const [k, v] of Object.entries(REQUIRED_ENV)) process.env[k] = v;
});

afterEach(() => {
  vi.clearAllMocks();
});

afterAll(() => {
  vi.restoreAllMocks();
});

const TOKEN = "WABA-bearer-token";

describe("UndiciMetaOAuthClient.getMediaMetadata", () => {
  it("parses a well-formed metadata response and sends the Bearer token", async () => {
    const { getMetaOAuthClient } = await import("@/integration/meta-client.js");

    undiciState.request.mockResolvedValueOnce({
      statusCode: 200,
      body: {
        json: async () => ({
          url: "https://cdn.fbsbx.com/v/abc",
          mime_type: "image/jpeg",
          file_size: 12345,
          sha256: "deadbeef",
          messaging_product: "whatsapp",
        }),
      },
    });

    const meta = await getMetaOAuthClient().getMediaMetadata("MEDIA-123", TOKEN);

    expect(meta).toEqual({
      url: "https://cdn.fbsbx.com/v/abc",
      mime_type: "image/jpeg",
      file_size: 12345,
      sha256: "deadbeef",
    });

    expect(undiciState.request).toHaveBeenCalledTimes(1);
    const [url, opts] = undiciState.request.mock.calls[0]! as [
      URL,
      { headers: Record<string, string> },
    ];
    expect(url.toString()).toContain("/MEDIA-123");
    expect(opts.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("returns sha256 undefined when omitted by Meta", async () => {
    const { getMetaOAuthClient } = await import("@/integration/meta-client.js");

    undiciState.request.mockResolvedValueOnce({
      statusCode: 200,
      body: {
        json: async () => ({
          url: "https://cdn.fbsbx.com/v/xyz",
          mime_type: "audio/ogg",
          file_size: 999,
        }),
      },
    });

    const meta = await getMetaOAuthClient().getMediaMetadata("MEDIA-456", TOKEN);
    expect(meta.sha256).toBeUndefined();
    expect(meta.url).toBe("https://cdn.fbsbx.com/v/xyz");
  });

  it("throws when url is missing", async () => {
    const { getMetaOAuthClient } = await import("@/integration/meta-client.js");

    undiciState.request.mockResolvedValueOnce({
      statusCode: 200,
      body: {
        json: async () => ({ mime_type: "image/png", file_size: 10 }),
      },
    });

    await expect(getMetaOAuthClient().getMediaMetadata("MEDIA-789", TOKEN)).rejects.toThrow();
  });

  it("maps a 4xx Meta error", async () => {
    const { getMetaOAuthClient } = await import("@/integration/meta-client.js");

    undiciState.request.mockResolvedValueOnce({
      statusCode: 404,
      body: {
        json: async () => ({ error: { message: "Unsupported get request", code: 100 } }),
      },
    });

    await expect(getMetaOAuthClient().getMediaMetadata("MEDIA-404", TOKEN)).rejects.toThrow();
  });
});

describe("UndiciMetaOAuthClient.downloadMedia", () => {
  it("returns the binary buffer on 200 and sends the Bearer token", async () => {
    const { getMetaOAuthClient } = await import("@/integration/meta-client.js");

    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    undiciState.request.mockResolvedValueOnce({
      statusCode: 200,
      body: {
        arrayBuffer: async () => bytes.buffer,
      },
    });

    const buf = await getMetaOAuthClient().downloadMedia("https://cdn.fbsbx.com/v/abc", TOKEN);

    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.equals(Buffer.from(bytes))).toBe(true);

    expect(undiciState.request).toHaveBeenCalledTimes(1);
    const [url, opts] = undiciState.request.mock.calls[0]! as [
      string,
      { headers: Record<string, string> },
    ];
    expect(url).toBe("https://cdn.fbsbx.com/v/abc");
    expect(opts.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("throws on non-2xx", async () => {
    const { getMetaOAuthClient } = await import("@/integration/meta-client.js");

    undiciState.request.mockResolvedValueOnce({
      statusCode: 500,
      body: {
        json: async () => ({ error: { message: "boom" } }),
      },
    });

    await expect(
      getMetaOAuthClient().downloadMedia("https://cdn.fbsbx.com/v/err", TOKEN),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// C2 SSRF guard tests (audit 2026-06-02): downloadMedia agora bloqueia URLs
// fora da allowlist Meta CDN ANTES de enviar o Bearer.
// ---------------------------------------------------------------------------

describe("isAllowedMetaMediaUrl (C2 SSRF guard)", () => {
  it("aceita hosts Meta CDN com https", async () => {
    const { isAllowedMetaMediaUrl } = await import("@/integration/meta-client.js");
    expect(isAllowedMetaMediaUrl("https://lookaside.fbsbx.com/v/abc")).toBe(true);
    expect(isAllowedMetaMediaUrl("https://cdn.fbsbx.com/v/abc")).toBe(true);
    expect(isAllowedMetaMediaUrl("https://scontent.xx.fbcdn.net/v/x")).toBe(true);
    expect(isAllowedMetaMediaUrl("https://scontent-abc.cdninstagram.com/v/y")).toBe(true);
    expect(isAllowedMetaMediaUrl("https://mmg.whatsapp.net/file")).toBe(true);
  });

  it("rejeita scheme não-https", async () => {
    const { isAllowedMetaMediaUrl } = await import("@/integration/meta-client.js");
    expect(isAllowedMetaMediaUrl("http://lookaside.fbsbx.com/v/abc")).toBe(false);
    expect(isAllowedMetaMediaUrl("ftp://lookaside.fbsbx.com/v/abc")).toBe(false);
    expect(isAllowedMetaMediaUrl("file:///etc/passwd")).toBe(false);
  });

  it("rejeita hosts fora da allowlist", async () => {
    const { isAllowedMetaMediaUrl } = await import("@/integration/meta-client.js");
    expect(isAllowedMetaMediaUrl("https://evil.example.com/v/abc")).toBe(false);
    expect(isAllowedMetaMediaUrl("https://internal.example.com/v/abc")).toBe(false);
    expect(isAllowedMetaMediaUrl("https://169.254.169.254/latest")).toBe(false); // AWS IMDS
    expect(isAllowedMetaMediaUrl("https://localhost/admin")).toBe(false);
  });

  it("rejeita tentativas de typosquatting de subdomínio", async () => {
    const { isAllowedMetaMediaUrl } = await import("@/integration/meta-client.js");
    // Sufixo precisa estar APÓS um ponto — não pode ser parte de outro hostname.
    expect(isAllowedMetaMediaUrl("https://attackerfbsbx.com/v/abc")).toBe(false);
    expect(isAllowedMetaMediaUrl("https://fbsbx.com.attacker.com/v/abc")).toBe(false);
    expect(isAllowedMetaMediaUrl("https://fbcdn.net.evil.io/")).toBe(false);
  });

  it("rejeita URL malformada", async () => {
    const { isAllowedMetaMediaUrl } = await import("@/integration/meta-client.js");
    expect(isAllowedMetaMediaUrl("not-a-url")).toBe(false);
    expect(isAllowedMetaMediaUrl("")).toBe(false);
    expect(isAllowedMetaMediaUrl("https://")).toBe(false);
  });
});

describe("UndiciMetaOAuthClient.downloadMedia — SSRF guard (C2)", () => {
  it("URL fora da allowlist → throw SEM enviar Bearer", async () => {
    const { getMetaOAuthClient } = await import("@/integration/meta-client.js");
    await expect(
      getMetaOAuthClient().downloadMedia("https://evil.example.com/leak", TOKEN),
    ).rejects.toThrow(/allowlist Meta CDN/);
    // CRÍTICO: undici.request NUNCA foi chamado — Bearer nunca saiu para o host malicioso.
    expect(undiciState.request).not.toHaveBeenCalled();
  });

  it("scheme http → throw mesmo em host Meta válido (downgrade attack)", async () => {
    const { getMetaOAuthClient } = await import("@/integration/meta-client.js");
    await expect(
      getMetaOAuthClient().downloadMedia("http://lookaside.fbsbx.com/v/abc", TOKEN),
    ).rejects.toThrow(/allowlist Meta CDN/);
    expect(undiciState.request).not.toHaveBeenCalled();
  });

  it("AWS instance metadata service URL → throw (defesa contra cloud SSRF)", async () => {
    const { getMetaOAuthClient } = await import("@/integration/meta-client.js");
    await expect(
      getMetaOAuthClient().downloadMedia("https://169.254.169.254/latest/meta-data/", TOKEN),
    ).rejects.toThrow();
    expect(undiciState.request).not.toHaveBeenCalled();
  });

  it("URL Meta válida ainda funciona (regressão happy path)", async () => {
    const { getMetaOAuthClient } = await import("@/integration/meta-client.js");
    undiciState.request.mockResolvedValueOnce({
      statusCode: 200,
      body: { arrayBuffer: async () => new ArrayBuffer(8) },
    });
    const buf = await getMetaOAuthClient().downloadMedia(
      "https://lookaside.fbsbx.com/v/legit-media",
      TOKEN,
    );
    expect(buf).toBeInstanceOf(Buffer);
    expect(undiciState.request).toHaveBeenCalledTimes(1);
  });
});

describe("UndiciMetaOAuthClient.getPhoneCoexInfo", () => {
  it("GET /{phone}?fields=is_on_biz_app,platform_type → mapeia flags COEX", async () => {
    const { getMetaOAuthClient } = await import("@/integration/meta-client.js");
    undiciState.request.mockResolvedValueOnce({
      statusCode: 200,
      body: {
        json: async () => ({ is_on_biz_app: true, platform_type: "CLOUD_API", id: "PHONE-1" }),
      },
    });
    const info = await getMetaOAuthClient().getPhoneCoexInfo("PHONE-1", TOKEN);
    expect(info).toEqual({
      phone_number_id: "PHONE-1",
      is_on_biz_app: true,
      platform_type: "CLOUD_API",
    });
    const [url] = undiciState.request.mock.calls[0]! as [URL, unknown];
    expect(url.toString()).toContain("/PHONE-1");
    expect(url.searchParams.get("fields")).toBe("is_on_biz_app,platform_type");
    expect(url.searchParams.get("access_token")).toBe(TOKEN);
  });

  it("is_on_biz_app ausente → false; platform_type ausente → null", async () => {
    const { getMetaOAuthClient } = await import("@/integration/meta-client.js");
    undiciState.request.mockResolvedValueOnce({
      statusCode: 200,
      body: { json: async () => ({ id: "PHONE-2" }) },
    });
    const info = await getMetaOAuthClient().getPhoneCoexInfo("PHONE-2", TOKEN);
    expect(info).toEqual({ phone_number_id: "PHONE-2", is_on_biz_app: false, platform_type: null });
  });
});

describe("UndiciMetaOAuthClient.triggerSmbAppDataSync", () => {
  it("faz 2 POSTs (smb_app_state_sync + history) com Bearer e retorna request_ids", async () => {
    const { getMetaOAuthClient } = await import("@/integration/meta-client.js");
    undiciState.request
      .mockResolvedValueOnce({
        statusCode: 200,
        body: { json: async () => ({ messaging_product: "whatsapp", request_id: "req-state" }) },
      })
      .mockResolvedValueOnce({
        statusCode: 200,
        body: { json: async () => ({ messaging_product: "whatsapp", request_id: "req-hist" }) },
      });
    const r = await getMetaOAuthClient().triggerSmbAppDataSync("PHONE-1", TOKEN);
    expect(r).toEqual({ state_sync_request_id: "req-state", history_request_id: "req-hist" });
    expect(undiciState.request).toHaveBeenCalledTimes(2);

    const [url0, opts0] = undiciState.request.mock.calls[0]! as [
      URL,
      { method: string; body: string; headers: Record<string, string> },
    ];
    expect(url0.toString()).toContain("/PHONE-1/smb_app_data");
    expect(opts0.method).toBe("POST");
    expect(opts0.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(opts0.body)).toEqual({
      messaging_product: "whatsapp",
      sync_type: "smb_app_state_sync",
    });

    const [, opts1] = undiciState.request.mock.calls[1]! as [URL, { body: string }];
    expect(JSON.parse(opts1.body)).toEqual({ messaging_product: "whatsapp", sync_type: "history" });
  });
});

describe("UndiciMetaOAuthClient.discoverWaba — por waba_id (ES/COEX)", () => {
  it("com hint.wabaId → GET /{waba_id}?fields=... e mapeia owner_business_info.id", async () => {
    const { getMetaOAuthClient } = await import("@/integration/meta-client.js");
    undiciState.request.mockResolvedValueOnce({
      statusCode: 200,
      body: {
        json: async () => ({
          id: "WABA-1",
          name: "Acme",
          verified_name: "Acme Verified",
          status: "APPROVED",
          owner_business_info: { id: "BIZ-9" },
        }),
      },
    });
    const d = await getMetaOAuthClient().discoverWaba(TOKEN, { wabaId: "WABA-1" });
    expect(d).toEqual({
      meta_business_id: "BIZ-9",
      meta_waba_id: "WABA-1",
      display_name: "Acme Verified",
      verified_status: "APPROVED",
    });
    expect(undiciState.request).toHaveBeenCalledTimes(1);
    const [url] = undiciState.request.mock.calls[0]! as [URL, unknown];
    expect(url.toString()).toContain("/WABA-1");
    expect(url.searchParams.get("fields")).toContain("owner_business_info");
    expect(url.searchParams.get("access_token")).toBe(TOKEN);
  });

  it("sem owner/obo mas com hint.businessId → usa o hint", async () => {
    const { getMetaOAuthClient } = await import("@/integration/meta-client.js");
    undiciState.request.mockResolvedValueOnce({
      statusCode: 200,
      body: { json: async () => ({ id: "WABA-2", name: "X", status: "APPROVED" }) },
    });
    const d = await getMetaOAuthClient().discoverWaba(TOKEN, {
      wabaId: "WABA-2",
      businessId: "BIZ-HINT",
    });
    expect(d.meta_business_id).toBe("BIZ-HINT");
    expect(d.meta_waba_id).toBe("WABA-2");
  });

  it("sem nenhuma fonte de business id → META_REJECTED claro", async () => {
    const { getMetaOAuthClient } = await import("@/integration/meta-client.js");
    undiciState.request.mockResolvedValueOnce({
      statusCode: 200,
      body: { json: async () => ({ id: "WABA-3", name: "X", status: "APPROVED" }) },
    });
    await expect(getMetaOAuthClient().discoverWaba(TOKEN, { wabaId: "WABA-3" })).rejects.toThrow(
      /no business id/i,
    );
  });
});
