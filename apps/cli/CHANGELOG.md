# @manyfold/cli

Notes before 0.23.3 predate this repository's public history; they live on
the docs site's changelog pages.

## 0.23.3

### Patch Changes

- `mf daemon register` now resolves its API endpoint the same way every other command does: an explicit root `--api-url` wins, then the profile's stored `apiUrl` from `mf login`, then the channel default. Previously the stored profile endpoint was skipped, so a machine logged into a self-hosted API silently tried to enrol against the default endpoint and was told its daemon token did not exist.
