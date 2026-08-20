# Manyfold Monorepo

TypeScript monorepo (Turborepo + pnpm) for Manyfold — a platform for creating, deploying and hosting agents. It holds the API, the user workbench, the admin control plane, the CLI, the public docs site and the runtime integrations.

## Workspaces

- `apps/api` — NestJS 11 + Fastify + Drizzle: auth, orchestration, persistence, external integrations. Port 2222, global prefix `/api`
- `apps/web` — Vite + React 18 user workbench: agent create/chat, runtimes, channels, automations, models, billing. Port 3002
- `apps/admin` — Vite + React 18 control plane: login providers, runtimes, model providers, catalog, users. Port 3001
- `apps/docs` — Astro public docs site. Product capability, install and usage content only; no internal implementation, ops detail or developer-only context
- `apps/cli` — Commander + tsup, ships the `mf` binary and the local daemon
- `apps/k8s-gateway` — in-cluster exec gateway
- `packages/shared` — constants, DTOs, API paths, ObjectId, validation shared across apps
- `packages/db` — Drizzle schema, the single source of truth for the database
- `packages/sdk` — typed HTTP client used by web, admin and the CLI
- `packages/i18n` — `t()` plus the shared locale catalogs
- `packages/a2a` — A2A protocol types, JSON-RPC client, SSE and URL guard
- `packages/sprites` — sprites.dev REST / WSS / filesystem client
- `packages/k8s-exec-core` — Kubernetes exec primitive
- `packages/external-providers` — Dify / Langflow / A2A provider adapters

Apps depend on packages; only `apps/api` writes the database or talks to runtimes. Front ends and the CLI consume the API through `@manyfold/sdk` and `@manyfold/shared`. Details in `docs/engineering/architecture.md` and `docs/product/system-overview.md`.

## Setup

Needs Node >= 20, pnpm 10.29.3 and Docker for Postgres.

```bash
just bootstrap      # install + copy .env files + start Postgres + run migrations
# fill API_CRYPTO_KEY and AUTH_SETUP_TOKEN in apps/api/.env
just dev            # turbo dev across every workspace that has a dev script
```

Configure the first login provider at `/setup` on first start. `API_CRYPTO_KEY` is the long-lived encryption master key — keep it wherever the database backups live; losing it makes every encrypted row unreadable. `AUTH_SETUP_TOKEN` is only the one-time token that guards setup on an empty database.

## Commands

Entry points are `justfile` recipes (`just` lists them all); each one wraps pnpm or docker compose.

| Command                                       | What it does                                 |
| --------------------------------------------- | -------------------------------------------- |
| `just dev-api` / `dev-admin` / `dev-web`      | run one app instead of the whole tree        |
| `just cli <args>`                             | run an `mf` subcommand against the local API |
| `just db-up` / `db-down` / `db-reset`         | Postgres container (`manyfold-pg`)           |
| `just db-migrate` / `db-generate` / `db-psql` | migrate, generate a migration, open psql     |
| `just check` / `lint` / `knip`                | the gates, same as the pnpm scripts below    |
| `just health`                                 | `curl /api/health`                           |

```bash
pnpm check         # turbo check — tsc --noEmit per workspace
pnpm test          # turbo test
pnpm lint          # ESLint
pnpm knip          # dead code and phantom dependencies (CI gate)
pnpm build         # turbo build
pnpm changeset     # required for any user-, admin-, operator- or CLI-visible change
```

Run `pnpm check && pnpm lint && pnpm knip` before opening a PR. When knip reports a false positive, add the `entry`/`ignoreDependencies` in `knip.json` and say why in the PR.

## Conventions

- 4-space indent, single quotes, no semicolons, no trailing commas (`.prettierrc`)
- `@/` path alias inside an app, `@manyfold/*` for workspace packages
- No comments unless the WHY is genuinely non-obvious
- Comments recording measured evidence use `// Seen on <env> [YYYY-MM-DD]: …` (something broke) or `// Measured on <env> [YYYY-MM-DD]: …` (observed or quantified normal behavior). The environment is mandatory; omit the date rather than inventing one
- `any` is allowed inside NestJS decorators — ESLint exempts `apps/api/**`
- Touch only what the change needs. Don't reformat, reorder imports or restructure files you aren't changing, and don't run `pnpm format` across the repo — formatting is not machine-enforced, so a repo-wide pass buries the real diff
- Hard conventions live in `docs/engineering/conventions.md`; breaking one needs an ADR in `docs/decisions/`, and an accepted ADR's body is never rewritten
