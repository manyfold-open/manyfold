# @manyfold/web

The user-facing workbench: Vite + React 18 + TypeScript + Tailwind, same stack as `apps/admin`. Runs on port 3002 and proxies `/api` to `apps/api` (`http://localhost:2222`). Login providers come from the API's admin-managed auth config, not from build-time env.

`DESIGN.md` is the source of truth for the visual and interaction language — read it before adding or changing any UI.

## Development

```bash
pnpm --filter @manyfold/web dev     # http://localhost:3002
pnpm --filter @manyfold/web check   # tsc --noEmit
pnpm --filter @manyfold/web test
pnpm --filter @manyfold/web build
```

From the repo root: `just dev-web` for this app alone, `just dev` for the whole tree.

## Working against a remote API

For UI-only work, you can skip the local backend and the login flow entirely: point the vite proxy at a deployed API and hand the dev bundle a personal access token.

Issue the PAT once. In a browser signed in to `https://manyfold.ai`, copy the `Authorization: Bearer mfs_…` session token from any `/api/…` request in DevTools → Network, then exchange it for a long-lived token:

```bash
SESSION="mfs_..."
curl -s https://api.manyfold.ai/api/me/api-tokens \
  -X POST \
  -H "Authorization: Bearer $SESSION" \
  -H 'Content-Type: application/json' \
  -d '{"name":"local-dev","scopes":["api.full"]}'
# → { "token": "nca_...", "summary": { "id": "..." } }
```

The token is returned only once — put it in a password manager, and re-issue if you lose it. Then:

```bash
echo 'VITE_DEV_BEARER_TOKEN=nca_...' > apps/web/.env.local
just dev-web-remote                 # prod; also takes `staging` or any API base URL
```

`http://localhost:3002` now opens straight into the workspace against real data.

Staging is a separate database, so a prod token is not valid there. Issue a second one the same way from your staging deployment's web app, or via the CLI:

```bash
mf login --profile staging --api-url https://api.<your-staging-host>/api
cat ~/.manyfold/profiles/staging/config.json    # copy "token"
echo 'VITE_DEV_BEARER_TOKEN=nca_...' > apps/web/.env.staging.local
just dev-web-remote staging
```

`--profile staging` keeps this out of the profile your everyday `mf` uses. `just dev-web-remote staging` starts vite with `--mode staging`, and `.env.staging.local` outranks `.env.local`, so the token follows the environment.

How it works:

- `MF_DEV_API_TARGET` is the vite proxy upstream (dev server only). `just dev-web-remote` also forces `VITE_API_URL=/api` so the browser stays same-origin on `localhost:3002` and never trips remote CORS.
- `VITE_DEV_BEARER_TOKEN` hits a dev-only early return at the top of `src/lib/auth.tsx` that renders `DevTokenAuthProvider`, whose `getToken()` returns the PAT. `import.meta.env.DEV` is false in production builds, so the whole branch is tree-shaken away.

Two cautions: a PAT carries your full account permissions — never commit it, never leave it in a screenshot; revoke with `DELETE /api/me/api-tokens/:id` using the `summary.id` from the issue response. And you are looking at real production data, so keep to UI work. Deleting `VITE_DEV_BEARER_TOKEN` restores the normal login flow immediately.

## Environment

Copy `.env.example` to `.env`:

- `VITE_API_URL` — defaults to `http://localhost:2222/api`. Local dev talks to the API's own origin on purpose: sharing `localhost:3002` would let long-lived SSE connections eat the ~6 HTTP/1.1 connection slots and hang the page. Remote debugging forces `/api` through the proxy instead
- `VITE_DOCS_URL` — public docs site
- `VITE_AXIOM_TOKEN` / `VITE_AXIOM_DATASET` — frontend RUM; the token is ingest-only and ships in the bundle
- `VITE_SENTRY_DSN` — error tracking; empty means Sentry is never initialised
- `VITE_GA_MEASUREMENT_ID` — GA4; production only, empty means gtag.js never loads
- `MF_DEV_API_TARGET` — dev-only, vite proxy upstream, defaults to `http://localhost:2222`
- `VITE_DEV_BEARER_TOKEN` — dev-only, PAT used as the bearer to skip login
