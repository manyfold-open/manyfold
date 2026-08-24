---
'@manyfold/api': minor
'@manyfold/web': patch
---

The API and web app now point at `https://manyfold.ai/cli/install.sh` and read
CLI versions from the release manifests instead of the CDN.

- The copy-paste install commands in the runtime dialogs, and the install script
  the API runs inside sprites, all use the one installer URL. The channel now
  rides `MF_CHANNEL=dev` rather than a separate staging URL.
- `GET /daemon/cli-versions` lists stable releases from
  `manyfold-open/manyfold` and reports the dev channel as the single build its
  manifest names — a rolling channel has exactly one installable build by
  definition.
- Versions below `0.24.0` are filtered out of the stable list: they have no
  per-version manifest, so a pinned upgrade to one could not be resolved by the
  current CLI or installer. Offering it would hand the operator an upgrade that
  fails at download time.
- The daemon's latest-version probe reads the channel manifest and now also
  reports the target commit, which is what distinguishes two dev builds that
  share a version.

**Operator-visible:** the API no longer reads `R2_S3_ENDPOINT`,
`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` or `R2_PUBLIC_BUCKET` for the CLI
version catalog — listing dev builds out of an object store is gone. Those
variables are still used by other features; nothing needs to change to deploy
this, and they can be retired from the CLI catalog's perspective.
