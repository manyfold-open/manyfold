# syntax=docker/dockerfile:1.7

FROM node:20-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.29.3 --activate
ENV PNPM_HOME=/root/.local/share/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /repo

FROM base AS deps
COPY .npmrc pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json ./
COPY apps/k8s-gateway/package.json apps/k8s-gateway/
COPY packages/k8s-exec-core/package.json packages/k8s-exec-core/
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter @manyfold/k8s-gateway...

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/k8s-exec-core ./packages/k8s-exec-core
COPY apps/k8s-gateway ./apps/k8s-gateway
RUN pnpm turbo run build --filter=@manyfold/k8s-gateway...

FROM node:20-bookworm-slim AS runtime
RUN corepack enable && corepack prepare pnpm@10.29.3 --activate
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
COPY --from=build /repo/package.json /repo/pnpm-workspace.yaml /repo/pnpm-lock.yaml /repo/turbo.json ./
COPY --from=build /repo/tsconfig.base.json ./
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages/k8s-exec-core ./packages/k8s-exec-core
COPY --from=build /repo/apps/k8s-gateway/package.json ./apps/k8s-gateway/package.json
COPY --from=build /repo/apps/k8s-gateway/tsconfig.json ./apps/k8s-gateway/tsconfig.json
COPY --from=build /repo/apps/k8s-gateway/dist ./apps/k8s-gateway/dist
COPY --from=build /repo/apps/k8s-gateway/node_modules ./apps/k8s-gateway/node_modules
WORKDIR /app/apps/k8s-gateway
EXPOSE 3000
CMD ["node", "dist/main.js"]
