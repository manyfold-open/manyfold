# @manyfold/docs

Public docs / changelog / status / legal site for Manyfold. Astro static site, hosted on Cloudflare Pages at `docs.manyfold.ai`.

## Develop

```sh
just docs-dev          # → http://localhost:3003
# or:
pnpm --filter @manyfold/docs dev
```

## Build

```sh
just docs-build
# or:
pnpm --filter '@manyfold/docs...' build
```

Output goes to `apps/docs/dist/`.

## Deploy

Pushing changes under `apps/docs/**` to `main` triggers `.github/workflows/deploy-docs.yml` which builds and `wrangler pages deploy`s to the Cloudflare Pages project `nca-docs`.

## Adding pages

- **Docs articles**: drop a markdown file under `src/content/docs/` with frontmatter `title:`, `description:`, `order:`. Routed automatically to `/docs/<slug>`.
- **Changelog entries**: drop a markdown file under `src/content/changelog/` named `<version>.md` with frontmatter `version:` and `date:`. Listed on `/changelog` newest-first.
- **One-off pages** (privacy / terms / status etc.): add an `.astro` file under `src/pages/`.
