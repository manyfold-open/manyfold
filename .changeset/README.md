# Changesets

This directory is the queue of unreleased changes. Each file names the
packages a change affects and how far to bump them; `changeset version`
consumes the queue into version bumps and `CHANGELOG.md` entries, then
deletes the files it used.

## Which packages take a changeset

Five product surfaces are versioned:

- `@manyfold/api`
- `@manyfold/web`
- `@manyfold/admin`
- `@manyfold/cli`
- `@manyfold/k8s-gateway`

The internal packages are listed in the `ignore` array of
[config.json](./config.json) and never get a version of their own. That
includes `@manyfold/docs`: the docs site ships continuously from `apps/docs`,
so a docs-only change needs no changeset. A changeset naming nothing but an
ignored package can never be consumed — it stays here forever and makes
`.changeset/` lie about what is unreleased, which is why
[#36](https://github.com/manyfold-open/manyfold/pull/36) deleted three of
them.

A change confined to an internal package still needs a changeset when the
behavior reaches people through a product surface. Name the surface, not the
internal package.

## Bump levels

- **patch** — a fix, or an internal change that alters no documented
  behavior.
- **minor** — new or changed behavior someone can observe: an endpoint, a
  flag, a command, a screen, a setting, user-facing copy. The common case.
- **major** — a break in one of the contract surfaces that
  [CONTRIBUTING.md](../CONTRIBUTING.md) enumerates: port interfaces, the
  composition-root seams, the capabilities endpoint, or the exported types of
  a `@manyfold/*` package. Downstream compositions build against those, so
  the PR description has to say so too.

Every product surface is still on 0.x, and changesets applies semver
literally — a `major` bump takes one to 1.0.0.

## How

```sh
pnpm changeset         # pick packages, pick bumps, write the summary
pnpm changeset:status   # what is queued
```

The summary goes into the changelog as written, so write it for the person
reading the release notes: what changed and why it matters, not which files
moved.

When a PR touches a product package but genuinely owes no release note —
tests, refactors, comments — record that decision rather than skipping it:

```sh
pnpm exec changeset --empty
```
