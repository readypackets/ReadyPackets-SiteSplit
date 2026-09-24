# ReadyPackets Portal — production image
#
# Multi-stage build. The final image contains the compiled server bundle, the
# built client assets, production dependencies, and nothing else: no compiler,
# no source tree, no package manager, no shell utilities beyond what the base
# image provides. It runs as an unprivileged user on a read-only root
# filesystem (see docker-compose.yml), so a code-execution bug has almost no
# writable surface to work with.

# ---------------------------------------------------------------------------
# Stage 1 — dependencies
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS deps

WORKDIR /build

# argon2 is a native module and needs a toolchain to compile.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml* ./
RUN pnpm install --frozen-lockfile=false


# ---------------------------------------------------------------------------
# Stage 2 — build
# ---------------------------------------------------------------------------
FROM deps AS build

WORKDIR /build

COPY tsconfig.json vite.config.ts vite.split.config.ts vite.public.config.ts vite.portal.config.ts postcss.config.mjs ./
COPY shared ./shared
COPY server ./server
COPY client ./client
COPY scripts ./scripts
COPY drizzle ./drizzle

ENV NODE_ENV=production

# The client bundle and the server bundle. Type checking runs in CI rather than
# here so a deployment is never blocked by a type error in a test file.
RUN pnpm run build:client \
 && pnpm exec esbuild server/index.ts \
      --bundle \
      --platform=node \
      --target=node22 \
      --format=esm \
      --packages=external \
      --outfile=dist/server.js \
 && pnpm exec esbuild scripts/migrate.ts \
      --bundle --platform=node --target=node22 --format=esm --packages=external \
      --outfile=dist/migrate.js \
 && pnpm exec esbuild scripts/seed.ts \
      --bundle --platform=node --target=node22 --format=esm --packages=external \
      --outfile=dist/seed.js \
 && pnpm exec esbuild scripts/create-admin.ts \
      --bundle --platform=node --target=node22 --format=esm --packages=external \
      --outfile=dist/create-admin.js


# ---------------------------------------------------------------------------
# Stage 3 — production dependencies only
# ---------------------------------------------------------------------------
FROM deps AS prod-deps

WORKDIR /build
RUN pnpm prune --prod


# ---------------------------------------------------------------------------
# Stage 4 — runtime
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

# Native converters are installed explicitly and pinned as part of the
# self-hosted runtime contract. The application invokes fixed executable paths
# with argument arrays; it does not discover host binaries or run shell input.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates tini ffmpeg antiword poppler-utils pandoc ghostscript libreoffice-writer python3-pip \
 && python3 -m pip install --no-cache-dir --break-system-packages "pdf2docx==0.5.8" \
 && rm -rf /var/lib/apt/lists/* \
 && apt-get purge -y --auto-remove

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    BIND_HOST=0.0.0.0 \
    NODE_OPTIONS=--max-old-space-size=512

# The node image ships an unprivileged `node` user (uid 1000); reuse it rather
# than creating another.
COPY --from=prod-deps --chown=root:root /build/node_modules ./node_modules
COPY --from=build     --chown=root:root /build/dist ./dist
COPY --from=build     --chown=root:root /build/client/dist ./client/dist
COPY --from=build     --chown=root:root /build/client/dist-public ./client/dist-public
COPY --from=build     --chown=root:root /build/client/dist-portal ./client/dist-portal
COPY --from=build     --chown=root:root /build/drizzle/migrations ./drizzle/migrations
COPY --chown=root:root package.json ./package.json

# Storage is a mounted volume; the mount point must be writable by the runtime
# user while the rest of the tree stays owned by root and read-only.
RUN mkdir -p /var/lib/readypackets/storage \
 && chown -R node:node /var/lib/readypackets

USER node

EXPOSE 3000

# The readiness probe also verifies database connectivity, so an unhealthy
# database marks the container unhealthy rather than silently serving errors.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS -H "Host: ${HEALTHCHECK_HOST:-localhost}" \
      "http://127.0.0.1:${PORT}/api/health/ready" || exit 1

# tini reaps zombies and forwards signals so graceful shutdown works.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server.js"]
