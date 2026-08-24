# @manyfold/cli

## 0.24.0

### Minor Changes

- [#17](https://github.com/manyfold-open/manyfold/pull/17) [`a365fa8`](https://github.com/manyfold-open/manyfold/commit/a365fa8e2a3046e0826a13e22a824e7147508467) Thanks [@yingca1](https://github.com/yingca1)! - The installer is now manifest-driven and served from `https://manyfold.ai/cli/install.sh`.

    `install.sh` used to call the GitHub Releases API to find a release, scrape
    `browser_download_url` out of the JSON, and recover the CLI version from the
    asset filename. It now reads the same release manifest `mf update` reads, which:

    - removes the GitHub API dependency and its unauthenticated rate limit — the
      common failure mode was an installer that worked yesterday and 403s today;
    - drops the download from three requests to two, because the checksum travels
      inside the manifest instead of a detached `.sha256` that could be served from
      a different cache generation than the archive it describes;
    - stops depending on `releases/latest`, which is what makes it safe for the CLI
      to leave the edition release train;
    - supports `MF_CHANNEL=dev` for real (`staging` is accepted as the pre-rename
      alias), and `VERSION=` pins either a stable or a dev build.

    The script is also served by the web app at `/cli/install.sh`, so the advertised
    install command becomes:

    ```sh
    curl -fsSL https://manyfold.ai/cli/install.sh | sh -s -- setup
    ```

    It is a committed copy under `apps/web/public/cli/`, kept honest by a
    byte-equality test: neither the OSS nor the cloud web Dockerfile has `apps/cli`
    in scope, so a build-time copy or a symlink would break the image builds.

- [#20](https://github.com/manyfold-open/manyfold/pull/20) [`c738de9`](https://github.com/manyfold-open/manyfold/commit/c738de9aa8e21810070569ae35c752cdb0aa6bf1) Thanks [@yingca1](https://github.com/yingca1)! - `mf update` now resolves releases through a JSON manifest instead of a plaintext
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

### Patch Changes

- [#15](https://github.com/manyfold-open/manyfold/pull/15) [`1909ba4`](https://github.com/manyfold-open/manyfold/commit/1909ba441c54570ff977b1399c9e08d39a2afaf7) Thanks [@yingca1](https://github.com/yingca1)! - Rename the mf CLI's pre-release update channel from `staging` to `dev`
  throughout. The channel a user selects with `mf update --channel dev` and the
  name the product reports are now the same word.

    - The runtime list labels the channel "Dev" instead of "Staging".
    - `staging` stays accepted as an alias everywhere it can arrive from an older
      peer: the `--channel` flag, a saved `~/.manyfold/update-channel.json`
      preference, the `daemon.update` RPC payload, and version strings — builds
      published before this rename are versioned `x.y.z-staging.<stamp>.<sha>` and
      are still installed in the field, so they keep reading as dev builds.
    - `GET /daemon/cli-versions` gains a `dev` list; the `staging` list is retained
      as a deprecated mirror so an older web bundle keeps working against a newer
      API during a rolling deploy.

    No distribution or update-source behaviour changes here.

- [#18](https://github.com/manyfold-open/manyfold/pull/18) [`d454437`](https://github.com/manyfold-open/manyfold/commit/d4544372f03391943400bf874f87c9bcbaac386b) Thanks [@yingca1](https://github.com/yingca1)! - The CLI now builds and publishes from this repository, on its own release train.

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

Notes before 0.23.3 predate this repository's public history; they live on
the docs site's changelog pages.

## 0.23.3

### Patch Changes

- `mf daemon register` now resolves its API endpoint the same way every other command does: an explicit root `--api-url` wins, then the profile's stored `apiUrl` from `mf login`, then the channel default. Previously the stored profile endpoint was skipped, so a machine logged into a self-hosted API silently tried to enrol against the default endpoint and was told its daemon token did not exist.
