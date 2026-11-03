# syntax=docker/dockerfile:1.7

# ============================================================================
# Stage 1 — deps: instala todas as dependências (prod + dev) usando pnpm.
# ============================================================================
FROM node:22-alpine AS deps
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.15.1 --activate

COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# ============================================================================
# Stage 2 — builder: compila TypeScript -> dist/.
# Inclui db/ no contexto porque os imports `@db/*` precisam estar visíveis
# para o type-checker (não basta src/).
# ============================================================================
FROM node:22-alpine AS builder
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.15.1 --activate

COPY --from=deps /app/node_modules ./node_modules
COPY package.json pnpm-lock.yaml tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY db ./db

RUN pnpm build

# ============================================================================
# Stage 3 — prod-deps: dependências apenas de produção.
# ============================================================================
FROM node:22-alpine AS prod-deps
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.15.1 --activate

COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prod

# ============================================================================
# Stage 4 — migrator: imagem one-shot para rodar `pnpm migrate:up` em Job k8s.
# Inclui scripts/, db/migrations e dev deps (tsx, drizzle-orm). Não é a imagem
# de runtime — usar tag dedicada (ex.: ghcr.io/bevox/bevox-meta-api:migrator-<sha>).
# ============================================================================
FROM node:22-alpine AS migrator
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.15.1 --activate \
    && addgroup -g 1001 -S nodejs \
    && adduser -S -u 1001 -G nodejs bevox

ENV NODE_ENV=production

COPY --from=deps  --chown=bevox:nodejs /app/node_modules ./node_modules
COPY --chown=bevox:nodejs package.json pnpm-lock.yaml tsconfig.json ./
COPY --chown=bevox:nodejs scripts ./scripts
COPY --chown=bevox:nodejs db ./db

USER bevox

CMD ["pnpm", "migrate:up"]

# ============================================================================
# Stage 5 — runtime: imagem final.
#
# NOTA staging V1: o build TS gera dist/ correto, mas em runtime os imports
# de path-alias (`@/*`, `@db/*`) não são resolvidos por Node nativo (não há
# tsc-alias / tsconfig-paths configurado). Workaround pragmático: rodar via
# `tsx` que respeita tsconfig.json. Slower startup (~1s), aceitável para
# staging. Backlog pós-V1: adicionar tsc-alias no build e voltar a `node dist/`.
# ============================================================================
FROM node:22-alpine AS runtime
WORKDIR /app

# wget para HEALTHCHECK; node:20-alpine não inclui curl.
RUN apk add --no-cache wget tini \
    && addgroup -g 1001 -S nodejs \
    && adduser -S -u 1001 -G nodejs bevox

# BUILD_SHA é o git SHA curto do commit usado neste build. Injetado pelo
# pipeline (`docker build --build-arg BUILD_SHA=<sha> ...`); default
# "unknown" permite builds locais sem anotação. Exposto em /healthz para
# diagnosticar drift "prod tá na versão X?" sem ssh/kubectl exec.
ARG BUILD_SHA=unknown

ENV NODE_ENV=production \
    PORT=3000 \
    BUILD_SHA=${BUILD_SHA}

# Usamos node_modules do `deps` (com tsx incluso) ao invés de prod-deps,
# enquanto o runtime depende de tsx. Aumenta a imagem ~50MB; aceitável.
COPY --from=deps    --chown=bevox:nodejs /app/node_modules ./node_modules
COPY --chown=bevox:nodejs package.json pnpm-lock.yaml tsconfig.json ./
COPY --chown=bevox:nodejs src ./src
COPY --chown=bevox:nodejs db ./db
# OpenAPI spec é carregado por @fastify/swagger em mode static no boot.
COPY --chown=bevox:nodejs docs/architecture/openapi.yaml ./docs/architecture/openapi.yaml

USER bevox

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD wget --quiet --spider http://localhost:3000/healthz || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--import", "tsx/esm", "src/index.ts"]
