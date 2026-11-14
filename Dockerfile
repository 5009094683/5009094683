# syntax=docker/dockerfile:1.7
#
# One file, four images. Build each with its target:
#   docker build --target api     -t pms-api .
#   docker build --target worker  -t pms-worker .
#   docker build --target web     -t pms-web .
#   docker build --target booking -t pms-booking .
# docker-compose.yml does this for you.

ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@10.33.4 --activate
WORKDIR /repo

# The whole workspace with its dependencies, shared by the build stages below.
# Fetching from the lockfile alone keeps this layer cached until a dependency changes.
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm fetch
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --offline --frozen-lockfile

# The API and the worker: one bundle each, plus only what they load at run time.
FROM deps AS build-services
RUN pnpm --filter @pms/api --filter @pms/worker build
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter @pms/api deploy --prod --legacy /out/api \
 && pnpm --filter @pms/worker deploy --prod --legacy /out/worker \
 && rm -rf /out/api/src /out/worker/src

# The address the web apps use to reach the API from inside the network is
# fixed when they are built: it becomes part of their routing table.
FROM deps AS build-web
ARG API_INTERNAL_URL=http://api:4000
ENV API_INTERNAL_URL=${API_INTERNAL_URL} NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @pms/web build

FROM deps AS build-booking
ARG API_INTERNAL_URL=http://api:4000
ARG BOOKING_ORG_SLUG=
ENV API_INTERNAL_URL=${API_INTERNAL_URL} BOOKING_ORG_SLUG=${BOOKING_ORG_SLUG} NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @pms/booking build

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production
# tini passes signals on, so a stop lets work in progress finish.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENTRYPOINT ["/usr/bin/tini", "--"]

FROM runtime AS api
COPY --from=build-services --chown=node:node /out/api ./
# Uploaded files (identity documents, attachments) live here: mount a volume shared with the worker.
RUN mkdir -p /data/files && chown node:node /data/files
ENV API_HOST=0.0.0.0 API_PORT=4000 STORAGE_DIR=/data/files
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=4 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||4000)+'/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]

FROM runtime AS worker
COPY --from=build-services --chown=node:node /out/worker ./
RUN mkdir -p /data/files && chown node:node /data/files
ENV STORAGE_DIR=/data/files
USER node
CMD ["node", "dist/main.js"]

FROM runtime AS web
COPY --from=build-web --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build-web --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
ENV PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=4 \
  CMD node -e "fetch('http://127.0.0.1:3000/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]

FROM runtime AS booking
COPY --from=build-booking --chown=node:node /repo/apps/booking/.next/standalone ./
COPY --from=build-booking --chown=node:node /repo/apps/booking/.next/static ./apps/booking/.next/static
ENV PORT=3001 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
USER node
EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=4 \
  CMD node -e "fetch('http://127.0.0.1:3001/robots.txt').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/booking/server.js"]
