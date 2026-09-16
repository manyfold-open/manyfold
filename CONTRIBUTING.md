# Contributing to Manyfold

Thanks for helping build Manyfold. This document covers the mechanics of a
good change; [GOVERNANCE.md](./GOVERNANCE.md) covers how this repository
relates to the hosted cloud edition, and [SECURITY.md](./SECURITY.md) covers
vulnerability reporting.

## The one rule that shapes everything

**This repository is the single source of truth for the core.** Every core
change — including those from the Manyfold team — lands here as a public PR.
The cloud edition composes this tree unmodified and adds closed modules
through the seams you can see in the code (DI ports, overlay slots,
registries). That has two practical consequences for contributors:

- You are never looking at a lagging mirror; what you patch is what ships.
- A handful of surfaces are downstream contracts and need a breaking-change
  note when you touch them (see below).

## Getting set up

```sh
just bootstrap   # install deps, start postgres (docker), run migrations
just dev         # api :2222, web :3002, admin :3001
```

`AGENTS.md` documents the monorepo layout and code conventions (4-space
indent, single quotes, no semicolons, no trailing commas, comments only for
non-obvious WHY). Before pushing:

```sh
pnpm check && pnpm lint && pnpm knip
pnpm -r test
```

## Pull requests

- Keep PRs focused; match the existing style of the file you are in.
- Any user-visible behavior change needs a changeset (`pnpm changeset`) that
  names every affected product surface (`@manyfold/api`, `@manyfold/web`,
  `@manyfold/admin`, `@manyfold/cli`, `@manyfold/k8s-gateway`). CI enforces
  presence on every pull request: touch a product package and the PR must add
  a changeset naming it, or an empty one (`pnpm changeset --empty`) whose body
  says why no release note is owed. `.changeset/README.md` explains bump
  levels. Only Git Added changesets count: editing, deleting or renaming a
  pre-existing note does not make it this PR's release artifact.
- Tests must encode why the behavior matters, not just what it does. Tests
  here are hermetic: they run against the open-source composition only, with
  no external credentials (CI has zero secrets).

## Test isolation

Sealed test commands require Node 20.6 or later for module loader hooks. Older
runtimes fail explicitly instead of running without protection. This does not
change the production runtime or package engine declaration.

Use package test commands and CI runners. Their sealed wrapper intercepts
PostgreSQL driver factories and dotenv configuration through ESM and CommonJS,
including tsx and imported helpers. Forbidden calls are recorded and fail the
run even when a test catches the error. Dormant factories and injected fake
connections remain valid. Ordinary test children cannot open a database even
in a run with `RUN_PG_E2E=1`; explicitly opted-in `*.pg.test.*` entries and their
helper processes receive that access.

This is an entrypoint guard, not an OS or network sandbox. HTTP fixtures,
native executables and direct filesystem access are not denied. A new database
driver needs a guard and executable negative coverage before tests may use it.

PostgreSQL runners discover `test/**/*.pg.test.ts` recursively in stable order.
The required suite runs serially and rejects empty or skipped TAP results.
`pnpm --filter @manyfold/api test:pg:audit` additionally creates and migrates a
unique scratch database, runs each file and declared concurrent pairings, then
force-drops its database on success or failure. It requires `PG_TEST_SCRATCH=1`
and a loopback `PG_TEST_ADMIN_URL`.

## Contract surfaces (breaking-change discipline)

Changes to any of the following are breaking changes for downstream
compositions and must say so in the PR description:

- port interfaces under `apps/api/src/common/ports/`
- the `CORE_MODULES` export and the composition-root seams
  (`startApiServer`, registries such as capabilities, ObjectId prefixes,
  feature toggles, raw-body path prefixes)
- the capabilities endpoint contract (`GET /api/config/capabilities`)
- exported types of the `@manyfold/*` workspace packages

Port default implementations live next to their interfaces and must stay
behavior-complete for the open-source composition (the best stub is "the
module is absent", not an empty shell).

## Database migrations

This repository owns the **core** tables. Rules the CI ownership check
enforces:

- Migrations here may only create/alter tables in the core ownership list.
- Foreign keys from core tables to downstream (closed) tables are forbidden;
  the reverse direction is the downstream edition's business, not ours.
- If a feature needs per-user state that only makes sense in a hosted
  product, it does not belong in a core table.

## Where does a feature belong?

Answer this in every feature PR (one line is fine): *useful to everyone
self-hosting, with no proprietary dependency?* Then it belongs here. If it
depends on a paid upstream, hosted-only infrastructure, or pricing/billing
logic, it belongs to a downstream edition and this repo should at most gain
a neutral seam (port/slot/registry entry) for it.

## Licensing of contributions

By contributing you agree your contribution is licensed under this
repository's [Apache License 2.0](./LICENSE). Keep third-party code out
of PRs unless its license is compatible with Apache-2.0.
