---
'@manyfold/cli': minor
'@manyfold/web': patch
---

The installer is now manifest-driven and served from `https://manyfold.ai/cli/install.sh`.

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
