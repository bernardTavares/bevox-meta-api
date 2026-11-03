/**
 * Cliente HTTP fino para bevox-meta-api.
 *
 * Faz: assinatura de JWT por request, headers obrigatórios, retry com idempotência,
 * mapeamento de erro canônico para classe própria.
 *
 * Uso:
 *   const client = createMetaApiClient({
 *     baseUrl: process.env.META_API_BASE_URL!,
 *     signer: createJwtSigner({ ... }),
 *   });
 *
 *   const tenant = await client.request({
 *     method: "POST",
 *     path: "/v1/tenants",
 *     scope: "tenants:write",
 *     idempotencyKey: `tenant-bootstrap-${workspaceId}`,
 *     body: { external_id: workspaceId, display_name: "Clínica X" },
 *   });
 *
 * Dependências: nenhuma além de Node 20+ (fetch global) + jose (no signer).
 *
 * Referências:
 *   - skill: references/03-endpoints.md, 07-error-codes.md, 08-idempotency.md
 */
import type { JwtSigner } from "./jwt-signer";

export interface MetaApiClientConfig {
  baseUrl: string;
  signer: JwtSigner;
  /** Timeout total da request em ms. Default 15000. */
  timeoutMs?: number;
  /** Tentativas máximas. Default 3 (1 + 2 retries). */
  maxAttempts?: number;
}

export interface RequestOptions {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  scope: string | string[];
  /** Obrigatório para mutações. Derivar de evento de domínio. */
  idempotencyKey?: string;
  /** Tenant scope; obrigatório para a maioria dos endpoints. */
  tenantId?: string;
  body?: unknown;
  /** Query string params. */
  query?: Record<string, string | number | undefined>;
  /** Headers extras (raros). */
  headers?: Record<string, string>;
}

export interface MetaApiSuccess<T = unknown> {
  ok: true;
  status: number;
  requestId: string;
  data: T;
}

export class MetaApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus: number,
    public readonly requestId: string,
    public readonly details?: Record<string, unknown>,
    public readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "MetaApiError";
  }

  /** Indica se vale a pena tentar de novo com mesma idempotency-key. */
  get isRetryable(): boolean {
    return (
      this.httpStatus === 429 ||
      this.httpStatus === 502 ||
      this.httpStatus === 503 ||
      this.httpStatus === 504 ||
      this.code === "META_UNAVAILABLE" ||
      this.code === "INTERNAL"
    );
  }
}

const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface MetaApiClient {
  request<T = unknown>(opts: RequestOptions): Promise<T>;
}

export function createMetaApiClient(config: MetaApiClientConfig): MetaApiClient {
  const timeoutMs = config.timeoutMs ?? 15_000;
  const maxAttempts = config.maxAttempts ?? 3;

  return {
    async request<T = unknown>(opts: RequestOptions): Promise<T> {
      if (MUTATION_METHODS.has(opts.method) && !opts.idempotencyKey) {
        throw new Error(
          `Idempotency-Key obrigatório para ${opts.method} ${opts.path}`,
        );
      }

      const scopes = Array.isArray(opts.scope) ? opts.scope : [opts.scope];
      const url = buildUrl(config.baseUrl, opts.path, opts.query);

      let lastError: MetaApiError | Error | null = null;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const jwt = await config.signer(scopes);
        const headers: Record<string, string> = {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/json",
          ...(opts.headers ?? {}),
        };
        if (opts.tenantId) headers["X-Tenant-Id"] = opts.tenantId;
        if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
        if (opts.body !== undefined) headers["Content-Type"] = "application/json";

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);

        try {
          const res = await fetch(url, {
            method: opts.method,
            headers,
            body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
            signal: controller.signal,
          });
          clearTimeout(timeout);

          const requestId = res.headers.get("x-request-id") ?? "unknown";

          if (res.ok) {
            return (await res.json()) as T;
          }

          const errorBody = await readErrorBody(res);
          const error = new MetaApiError(
            errorBody.code,
            errorBody.message,
            res.status,
            requestId,
            errorBody.details,
            parseRetryAfter(res.headers.get("retry-after")),
          );

          if (!error.isRetryable || attempt === maxAttempts) throw error;

          lastError = error;
          await sleep(backoffMs(attempt, error.retryAfter));
        } catch (e) {
          clearTimeout(timeout);
          if (e instanceof MetaApiError) throw e;
          // Network / timeout
          lastError = e as Error;
          if (attempt === maxAttempts) throw e;
          await sleep(backoffMs(attempt));
        }
      }
      throw lastError ?? new Error("request failed without error");
    },
  };
}

interface CanonicalErrorBody {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

async function readErrorBody(res: Response): Promise<CanonicalErrorBody> {
  try {
    const json = (await res.json()) as { error?: CanonicalErrorBody };
    if (json.error?.code) return json.error;
  } catch {
    // body não-JSON
  }
  return {
    code: "INTERNAL",
    message: `HTTP ${res.status} sem body canônico`,
  };
}

function buildUrl(
  baseUrl: string,
  path: string,
  query?: Record<string, string | number | undefined>,
): string {
  const url = new URL(path, baseUrl);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = parseInt(header, 10);
  return Number.isFinite(seconds) ? seconds : undefined;
}

function backoffMs(attempt: number, retryAfter?: number): number {
  if (retryAfter) return retryAfter * 1000;
  // 200ms, 800ms, 3.2s
  return Math.min(200 * 4 ** (attempt - 1), 10_000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
