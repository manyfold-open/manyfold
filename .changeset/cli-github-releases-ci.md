---
'@manyfold/cli': patch
---

The CLI now builds and publishes from this repository, on its own release train.

Two channels, two triggers:

- **stable** — a `cli-v<version>` tag. `release-cli` builds the five targets,
  creates the `cli-v<version>` release, then promotes that release's manifest to
  `stable.json`.
- **dev** — every `develop` commit whose `ci` run passed. `release-cli-dev`
  builds the same five targets, attaches them to the rolling `cli-dev`
  prerelease, then rewrites `dev.json`.

Both write the channel pointer last, so a reader never sees a manifest naming an
artifact that is still uploading. The pointers live on a fixed `cli-channels`
prerelease, which keeps their URLs stable forever.

The dev channel is gated on CI completion rather than on push, because it has
to mean "latest successful develop build" — a red build must never become the
thing every dev machine installs.

`ci` now also runs on `develop` pushes, and a `sync-release-to-develop`
workflow back-merges `main` after a version PR; without it `changeset version`
would delete consumed changesets on `main` only and the next promotion would
resurrect them.
