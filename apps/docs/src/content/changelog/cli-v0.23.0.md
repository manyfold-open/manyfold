---
version: '0.23.0'
date: '2026-08-13'
---

## CLI 0.23.0 — Recoverable turns and managed MCP config

This release restores interrupted turns on your own computers and runners, lets
the daemon manage Claude Code's user-level MCP configuration on your behalf, and
retires a command that never worked.

### Highlights

- **Interrupted turns finish instead of restarting.** When the connection
  carrying an OpenClaw turn drops, the daemon can reattach and complete the same
  assistant message rather than starting a second run. You are not charged for a
  duplicate model call, and cancelling a resumed turn stops the original work.
- **Managed MCP configuration.** The daemon can read and write Claude Code's
  user-level `~/.claude.json` for Manyfold-managed MCP servers. Only that exact
  path is accepted and never through a symlink, and older daemons are never
  asked to do it.
- **Config files carrying secrets are written `600`.** File writes now honour an
  explicit permission mode, so generated config lands readable only by you
  instead of at the default permissions.
- **Less local metadata retained.** The daemon no longer records execution
  environment into its local stream metadata; connection tokens and platform
  identity travelled in that payload and nothing ever read it back.

### Removed

- `mf agent logs` is gone. It was advertised in help output but never fetched or
  displayed agent logs. Nothing that worked before stops working.
