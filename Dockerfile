# Production image (M1 step 11): one container running the Fastify server,
# which serves the API, the /gateway WebSocket, and the built web app
# (WEB_DIST). Migrations run on boot. Build from the repo root:
#
#   docker build --target runtime -t emberchat .
#
# The `sim` target packages fchat-sim for the compose smoke profile — never
# deploy it.

FROM node:24-slim AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

# ── Build: full workspace install + turbo build ──────────────────────────────
FROM base AS build
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
RUN pnpm install --frozen-lockfile
RUN pnpm build

# ── Prod deps: server's production node_modules only ─────────────────────────
# Manifests + lockfile only, so this layer survives source-only changes.
FROM base AS proddeps
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/protocol/package.json packages/protocol/
COPY packages/fchat-protocol/package.json packages/fchat-protocol/
COPY packages/fchat-sim/package.json packages/fchat-sim/
COPY packages/markdown-bbcode/package.json packages/markdown-bbcode/
COPY packages/session-engine/package.json packages/session-engine/
RUN pnpm install --prod --frozen-lockfile --filter @emberchat/server...
# @electric-sql/pglite is only a devDependency — it backs the desktop client's
# embedded database (MX2) and the pglite CI leg — but drizzle-orm declares it
# as an OPTIONAL PEER, so pnpm resolves it into the virtual store even here,
# and the server image would carry ~25 MB of WASM it can never execute. The
# pglite arm of createDb is a dynamic import() that only runs under
# DB_DRIVER=pglite; on this image that arm now fails with an error saying so
# (apps/server/src/db/index.ts). Removing it is the point, not an accident.
RUN rm -rf node_modules/.pnpm/@electric-sql+pglite@*

# ── Runtime ──────────────────────────────────────────────────────────────────
FROM node:24-slim AS runtime
# Baked by the release workflow from the git tag; also the IDN cversion.
ARG CLIENT_VERSION=0.0.0
ENV NODE_ENV=production \
    CLIENT_VERSION=$CLIENT_VERSION
WORKDIR /app
# The pnpm layout (symlinks into node_modules/.pnpm) must be copied whole.
COPY --from=proddeps /repo/node_modules ./node_modules
COPY --from=proddeps /repo/apps/server/node_modules ./apps/server/node_modules
COPY --from=proddeps /repo/packages ./packages
COPY --from=build /repo/packages/protocol/dist ./packages/protocol/dist
COPY --from=build /repo/packages/fchat-protocol/dist ./packages/fchat-protocol/dist
COPY --from=build /repo/packages/markdown-bbcode/dist ./packages/markdown-bbcode/dist
COPY --from=build /repo/packages/session-engine/dist ./packages/session-engine/dist
COPY --from=build /repo/apps/server/package.json ./apps/server/package.json
COPY --from=build /repo/apps/server/drizzle ./apps/server/drizzle
COPY --from=build /repo/apps/server/dist ./apps/server/dist
COPY --from=build /repo/apps/web/dist ./apps/web/dist

ENV HOST=0.0.0.0 \
    PORT=3000 \
    WEB_DIST=/app/apps/web/dist
EXPOSE 3000
USER node
CMD ["node", "apps/server/dist/main.js"]

# ── fchat-sim (smoke/dev profile only) ───────────────────────────────────────
FROM build AS sim
ENV NODE_ENV=production \
    FCHAT_SIM_HOST=0.0.0.0 \
    FCHAT_SIM_PORT=9090
EXPOSE 9090
USER node
CMD ["node", "packages/fchat-sim/dist/cli.js"]
