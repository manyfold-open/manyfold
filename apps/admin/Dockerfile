# syntax=docker/dockerfile:1.7

FROM node:20-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.29.3 --activate
WORKDIR /repo

FROM base AS deps
COPY .npmrc pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json ./
COPY apps/api/package.json apps/api/
COPY apps/admin/package.json apps/admin/
COPY apps/web/package.json apps/web/
COPY apps/cli/package.json apps/cli/
COPY packages/db/package.json packages/db/
COPY packages/external-providers/package.json packages/external-providers/
COPY packages/k8s-exec-core/package.json packages/k8s-exec-core/
COPY packages/shared/package.json packages/shared/
COPY packages/sdk/package.json packages/sdk/
COPY packages/i18n/package.json packages/i18n/
COPY packages/sprites/package.json packages/sprites/
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

FROM deps AS build
ARG VITE_API_URL
ENV VITE_API_URL=$VITE_API_URL
ARG VITE_AXIOM_TOKEN
ENV VITE_AXIOM_TOKEN=$VITE_AXIOM_TOKEN
ARG VITE_AXIOM_DATASET
ENV VITE_AXIOM_DATASET=$VITE_AXIOM_DATASET
ARG VITE_MF_ENV
ENV VITE_MF_ENV=$VITE_MF_ENV
ARG VITE_NCA_ENV
ENV VITE_NCA_ENV=$VITE_NCA_ENV
ARG VITE_SENTRY_DSN
ENV VITE_SENTRY_DSN=$VITE_SENTRY_DSN
ARG SENTRY_ORG
ENV SENTRY_ORG=$SENTRY_ORG
ARG SENTRY_PROJECT
ENV SENTRY_PROJECT=$SENTRY_PROJECT
ARG GIT_SHA
ENV GIT_SHA=$GIT_SHA
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/admin ./apps/admin
COPY apps/web/vite-overlay.ts ./apps/web/vite-overlay.ts
# The auth token is a build secret, never an ARG: ARGs persist in the build
# stage's image history on the shared fly builder. Absent secret => empty value
# => the Sentry plugin disables itself and the build is unchanged.
RUN --mount=type=secret,id=SENTRY_AUTH_TOKEN \
    SENTRY_AUTH_TOKEN="$(cat /run/secrets/SENTRY_AUTH_TOKEN 2>/dev/null || true)" \
    pnpm turbo run build --filter=@manyfold/admin...
# Belt and braces: hidden sourcemaps are still fetchable if guessed, and the
# plugin only deletes them when an upload actually ran.
RUN find /repo/apps/admin/dist -name '*.map' -delete

FROM caddy:2-alpine AS runtime
COPY --from=build /repo/apps/admin/dist /srv
COPY apps/admin/Caddyfile /etc/caddy/Caddyfile
EXPOSE 8080
