---
version: "0.24.0"
date: "2026-08-24"
---

The update mechanism moves off the CDN and onto release manifests, and the
pre-release channel is now called `dev` everywhere.

- **`mf update` resolves a release manifest instead of a version file.** The old
  path fetched a plain version string, then built the archive URL and a separate
  checksum URL by string concatenation — so the checksum could be served from a
  different cache generation than the bytes it described, and the storage layout
  was baked into every installed binary. A channel is now one manifest that names
  every artifact by absolute URL with its checksum: two requests instead of
  three, and the download location can move without reissuing binaries.

- **The `dev` channel is ordered by commit.** Consecutive dev builds share the
  same `x.y.z`, so version comparison called them identical and the channel could
  not tell "newer" from "different". Builds now carry their source commit, and
  `mf update` follows it.

- **`dev` is an update policy, not an environment.** Both channels default to the
  production API; a dev binary simply installs newer code sooner, in its own
  `dev` profile. To work against a pre-production API, pin it at login with
  `--api-url`.

- **New `mf version`.** Bare output is identical to `mf --version`; `--verbose`
  and `--json` add the update channel, source commit, build time, platform
  target, install method and config paths — the things a bug report needs.

- **Install from `https://manyfold.ai/cli/install.sh`.** The installer reads the
  same manifests, so it no longer calls the GitHub API and is no longer subject
  to its rate limit. `MF_CHANNEL=dev` selects the pre-release channel and
  `VERSION=` pins any published build.

- **Fixed:** the daemon's background auto-updater followed the channel its binary
  was built for rather than the channel you selected, so a machine switched to
  `dev` quietly drifted back to stable on the next check.

`--channel staging` still works as an alias for `dev`, saved preferences are
migrated on read, and builds published as `-staging.` are still recognised as dev
builds — nothing needs to be reinstalled.
