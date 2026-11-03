/**
 * Serializer Pino customizado de request para o bevox-meta-api.
 *
 * Motivação (achado C1 da auditoria interna): Fastify 5 com
 * `disableRequestLogging:false` loga `req.url` COM query string inteira.
 * Para as rotas públicas GET /v1/oauth/{waba,ig}/callback, isso vaza o
 * `code` (authorization code da Meta) e o `state` (anti-CSRF) em texto
 * claro nos logs — e via pipeline OTEL/Sentry. Os campos NÃO são chaves
 * conhecidas pelo Pino, portanto não são capturados por `redact.paths`.
 *
 * Decisão: serializer canônico que:
 *   1. Para rotas /v1/oauth/{waba,ig}/callback (match por route OU path),
 *      RETIRA a query string inteira da URL antes de logar — não basta
 *      remover só `code`/`state`, pois Meta pode acrescentar
 *      `error_description` com mensagem de erro que correlaciona PII.
 *   2. Para outras rotas, preserva URL completa (telemetria normal —
 *      `include_disconnected=true` etc. são úteis para debugging e não
 *      são sensíveis).
 *   3. Mantém o shape Pino canônico (`method`, `url`, `remoteAddress`,
 *      `remotePort`) para não quebrar parsers downstream.
 *
 * Reutilizado em `src/bootstrap/server.ts` via `logger.serializers.req`.
 */

/**
 * Rotas cuja query string DEVE ser sempre redijida (removida do log).
 * Comparação é feita contra `req.routeOptions.url` (path do schema da
 * rota) e, como fallback, contra o pathname puro de `req.url`.
 */
const OAUTH_CALLBACK_ROUTES = new Set(["/v1/oauth/waba/callback", "/v1/oauth/ig/callback"]);

interface MinimalFastifyReq {
  method?: string;
  url?: string;
  id?: string;
  routeOptions?: { url?: string };
  ip?: string;
  socket?: { remotePort?: number };
}

export interface SerializedReq {
  method?: string;
  url: string;
  remoteAddress?: string;
  remotePort?: number;
  // Index signature exigido pelo tipo `FastifyLoggerOptions.serializers.req`
  // (ver `node_modules/fastify/types/logger.d.ts`).
  [key: string]: unknown;
}

/**
 * Constrói o serializer `req` do Pino usado pelo logger Fastify.
 *
 * Idempotente — chamadas múltiplas retornam funções equivalentes (não há
 * estado por instância). Exposto como factory por simetria com `logger()`
 * e para facilitar mock/stub em testes.
 */
export function buildRequestSerializer(): (req: MinimalFastifyReq) => SerializedReq {
  return (req: MinimalFastifyReq): SerializedReq => {
    const rawUrl = req.url ?? "";
    const routeUrl = req.routeOptions?.url;
    const pathname = rawUrl.split("?")[0] ?? rawUrl;

    const isOAuthCallback =
      (routeUrl !== undefined && OAUTH_CALLBACK_ROUTES.has(routeUrl)) ||
      OAUTH_CALLBACK_ROUTES.has(pathname);

    const url = isOAuthCallback ? pathname : rawUrl;

    return {
      method: req.method,
      url,
      remoteAddress: req.ip,
      remotePort: req.socket?.remotePort,
    };
  };
}
