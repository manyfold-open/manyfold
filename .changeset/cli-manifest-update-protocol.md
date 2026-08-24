---
'@manyfold/cli': minor
---

`mf update` now resolves releases through a JSON manifest instead of a plaintext
`latest/version.txt` plus a derived download path.

The old protocol asked the CDN for a version string, then built the asset URL
and a sibling `.sha256` URL by string concatenation. That meant three requests
where the checksum could be served from a different cache generation than the
bytes it described, and it hard-coded the storage layout into every installed
binary — so the artifacts could never move.

A channel now points at one manifest, and the manifest names every artifact by
absolute URL with its sha256:

- `https://github.com/manyfold-open/manyfold/releases/download/cli-channels/{stable,dev}.json`
  for the channel head, and a per-release `manifest.json` so `mf update --to`
  and the daemon's remote upgrade can still reach an arbitrary past build.
- Two round trips instead of three, and the checksum can no longer disagree
  with the archive it covers.
- The binary derives no URLs, so a future storage move needs a new manifest,
  not a new release of the CLI.

**The dev channel is ordered by commit, not semver.** Consecutive dev builds
share a base version, so the comparator reported them equal forever. Builds now
carry their source commit and build time, and `mf version --verbose` / `--json`
report them — the dev channel sees an update when the commit moves even though
`x.y.z` has not.

**The dev channel is an update policy, not an environment.** It no longer
carries its own API endpoint: both channels default to the production API, and a
pre-production endpoint is selected per profile with an explicit `--api-url` at
login. `mf update --channel dev` says so when it switches.

Also in this change:

- New `mf version` command: bare output is byte-identical to `mf --version`,
  with `--verbose` and `--json` adding channel, commit, build time, target,
  install method and paths.
- The daemon's background auto-updater follows the **saved** update channel.
  It previously used the baked one, so a machine where someone ran
  `mf update --channel dev` kept auto-updating along stable, silently undoing
  the choice on the next tick.
- `mf update` and the API share one version comparator (`compareCliSemver`)
  instead of keeping a second, prerelease-blind copy in the CLI.
- The `daemon.update` RPC reports which commit it landed on.

Channel switching stays on `mf update --channel <dev|stable>`; no `mf channel`
command was added, because `mf channels` already manages messaging channels and
the singular/plural pair would be a permanent trap.
