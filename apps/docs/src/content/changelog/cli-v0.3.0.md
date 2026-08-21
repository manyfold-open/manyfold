---
version: '0.3.0'
date: '2026-05-07'
---

## CLI 0.3.0 — Workspace and terminal runtime updates

This minor release updates the CLI and daemon runtime protocol for newer Cloud Agents workspace behavior.

### Highlights

- Added support for custom workspace directories across hosted and local agent runtimes.
- Repaired local terminal session handling for daemon-backed agents.
- Improved runtime diagnostics by using the runtime kind when checking agents.
- Added support for Unicode agent display names.
- Updated object-id-compatible runtime naming used by hosted sprite-backed agents.

### Notes

- This release includes protocol and runtime compatibility updates for the broader Cloud Agents product, not only command-line UX changes.
