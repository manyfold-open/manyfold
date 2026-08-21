---
version: '0.6.0'
date: '2026-05-12'
---

## CLI 0.6.0 — Command surface expansion

This minor release significantly expands the CLI surface, adding new top-level command groups for managing Cloud Agents resources, plus per-agent token binding support for the OAuth grant flow.

### Highlights

- Added new top-level command groups: `nca model-config`, `nca files`, `nca automations`, `nca backups`, `nca skills`, `nca usage`.
- Expanded `nca agent` (alias `agents`) with `get`, `update`, `delete`, `diagnose`, `health-check`, `storage-usage`, `model-config`, and `credentials`.
- Expanded `nca runtime` (alias `agent-runtimes`) with `control-ui`, `dashboard`, and `agents {add,list,remove}`.
- `nca login --poll` accepts `--limit-to-agent` to bind the new token to a specific agent (full API support lands in a follow-up).

### Notes

- Runtime helper markdown emitted by agents now lists every CLI subtree; the legacy raw-`curl` Path-B section is removed.
- Use `nca update --force --yes` to reinstall the latest standalone binary.
