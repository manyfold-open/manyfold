---
version: '4.1.0'
date: '2026-09-18'
---

The daemon now reports the coding CLI's own session to the platform through
Claude Code and Codex session hooks, installed with consent at `mf daemon
register` / `mf setup` (`--no-hooks` to skip) and managed with `mf daemon
hooks install|uninstall|status`. Terminals opened from the workbench belong to
the daemon: a dropped tab reattaches to the same shell with its screen intact,
and `mf daemon status` shows the terminals kept and attached. Behind
`MF_DAEMON_EXEC_FILES=1` (macOS / Linux preview), chat-turn execs run detached
through files and survive a daemon restart, profile lease included;
`mf daemon stop --keep-execs` leaves them for the next daemon, `mf daemon
doctor` reports whether execs would survive, and a `manual` install can take a
remote upgrade by handing off to a successor it watches.
