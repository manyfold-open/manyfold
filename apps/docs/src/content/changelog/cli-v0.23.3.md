---
version: "0.23.3"
date: "2026-08-21"
---

Patch release for daemon enrolment on self-hosted deployments:

- **`mf daemon register` now honors the API endpoint stored by `mf login`.**
  The command resolves its endpoint the same way every other command does: an
  explicit `--api-url` wins, then the profile's stored endpoint, then the
  channel default. Previously the stored profile endpoint was skipped, so a
  machine logged into a self-hosted API silently tried to enrol against the
  default endpoint and was told its daemon token did not exist.
