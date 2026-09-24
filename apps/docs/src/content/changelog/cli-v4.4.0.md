---
version: '4.4.0'
date: '2026-09-24'
---

Pi (pi.dev) joins the coding CLIs the daemon runs. The daemon detects `pi`
and runs Pi agents on your computer. It reports what Pi's own sign-in can use
there — its `auth.json` sign-ins, keys and the models `pi --list-models`
offers — so an agent can run on it. A runtime account for Pi signs in by
running `pi` and `/login` in that account's own agent dir. `mf daemon hooks
install` adds Pi's session hook, an extension Pi loads on its own, so a Pi
TUI opened from Manyfold reports its session like Claude Code and Codex do.
herdr can start Pi for a handed-over conversation. The daemon now reads Pi's
session files under `~/.pi`, which listing, viewing and syncing Pi sessions
need. `mf agent create --framework pi` takes `--pi-api-key` with
`--pi-provider`.
