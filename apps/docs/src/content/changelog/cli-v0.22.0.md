---
version: '0.22.0'
date: '2026-07-30'
---

## CLI 0.22.0 — Explicit profiles for every environment

CLI credentials and daemon control state now live in named profiles, with
commands to inspect and safely remove them. This is a breaking local-state
migration.

### Highlights

- **Profile management.** `mf profile show`, `list`, and `delete` expose the
  active environment, paths, login, and daemon state.
- **Explicit selection.** Use `--profile <name>` or `MF_PROFILE`; stable
  binaries default to `default`, dev binaries to `staging`.
- **Per-profile daemon units.** Production, staging, and self-hosted daemons can
  coexist with distinct state and autostart units.
- **Shared agent data.** Workspaces and the host skill store remain
  machine-scoped; deleting a profile never removes them.
- **Headless setup repaired.** `mf login --no-launch-browser` and
  `mf setup --no-launch-browser` now use the paste-back authorization-code
  flow correctly.
- **Reliable re-registration.** Duplicate machine/runtime display names no
  longer make setup fail, and API failures include an actionable trace ID.

### Upgrade note

Legacy flat config and daemon fallbacks were removed. After upgrading from CLI
0.21 or earlier, run `mf login` and `mf daemon register` again in the intended
profile. Existing data under `~/.manyfold/workspaces` and
`~/.manyfold/skills` remains in place.
