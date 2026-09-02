# syntax=docker/dockerfile:1.7

FROM node:20-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.29.3 --activate
ENV PNPM_HOME=/root/.local/share/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /repo

# Release version bumps rewrite every package.json "version" without touching
# dependencies. Normalizing versions in a throwaway stage keys the deps stage
# COPY --from on the normalized content, so the pnpm install layer survives
# version-bump-only releases (normalizing inside deps would not help: the
# changed COPY layer would already have invalidated the install layer).
FROM base AS manifests
COPY .npmrc pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json ./
COPY apps/api/package.json apps/api/
COPY apps/admin/package.json apps/admin/
COPY apps/web/package.json apps/web/
COPY apps/cli/package.json apps/cli/
COPY packages/a2a/package.json packages/a2a/
COPY packages/db/package.json packages/db/
COPY packages/external-providers/package.json packages/external-providers/
COPY packages/k8s-exec-core/package.json packages/k8s-exec-core/
COPY packages/shared/package.json packages/shared/
COPY packages/sdk/package.json packages/sdk/
COPY packages/i18n/package.json packages/i18n/
COPY packages/sprites/package.json packages/sprites/
COPY packages/tokens/package.json packages/tokens/
RUN find . -name package.json | xargs node -e ' \
    const fs = require("fs"); \
    for (const file of process.argv.slice(1)) { \
        const manifest = JSON.parse(fs.readFileSync(file, "utf8")); \
        manifest.version = "0.0.0"; \
        fs.writeFileSync(file, JSON.stringify(manifest, null, 4) + "\n"); \
    }'

FROM base AS deps
COPY --from=manifests /repo/ ./
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/api ./apps/api
RUN --mount=type=cache,id=turbo,target=/repo/.turbo/cache \
    pnpm turbo run build --filter=@manyfold/api...

# A self-contained production install of the api alone: workspace packages are
# copied in as real directories, dev dependencies and the other apps stay out.
# --legacy because inject-workspace-packages is not enabled for this workspace.
FROM build AS pruned
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm --filter @manyfold/api --prod deploy --legacy /pruned

# Same /app/apps/api layout as before the pruning: otel.ts registers
# tsconfig-paths at boot, which resolves tsconfig.json + ../../tsconfig.base.json
# relative to the CWD, and the fly release_command stays `node dist/db/migrate.js`.
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=2222
COPY --from=build /repo/tsconfig.base.json ./tsconfig.base.json
COPY --from=pruned /pruned/package.json ./apps/api/package.json
COPY --from=pruned /pruned/node_modules ./apps/api/node_modules
COPY --from=build /repo/apps/api/tsconfig.json ./apps/api/tsconfig.json
COPY --from=build /repo/apps/api/dist ./apps/api/dist
COPY --from=build /repo/apps/api/drizzle ./apps/api/drizzle
WORKDIR /app/apps/api
EXPOSE 2222
CMD ["node", "--enable-source-maps", "dist/main.js"]
