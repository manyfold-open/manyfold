---
version: '0.9.0'
date: '2026-05-15'
---

## CLI 0.9.0 — Channel session switching

`nca channels` gains a `sessions` subcommand group for inspecting and managing the per-scope chat sessions that channel bridges create. Same primitives the in-channel slash commands and the web sidebar use, now scriptable from the terminal.

### Highlights

- `nca channels sessions scopes <channelId>` — list scopes in a channel with their active session, total session count, and last activity timestamp.
- `nca channels sessions list <channelId> [--scope-key <key>] [--include-archived]` — list sessions, with active marker, channel session id, scope, and display name (🏷️ when user-set).
- `nca channels sessions new <channelId> --scope-key <key> [--name <name>]` — create a new active session in a scope; the previous active becomes inactive.
- `nca channels sessions switch <channelId> <sessionId>` — make a session active in its scope.
- `nca channels sessions rename <channelId> <sessionId> <name>` — set the channel display name (the 🏷️ label that shows in `/list` inside the channel and in the web sidebar).
- `nca channels sessions delete <channelId> <sessionId> [--activate-fallback]` — archive a session; with `--activate-fallback`, auto-activate the newest remaining if you delete the active one.

Every command supports `--json` to emit raw JSON for piping into other tools.

### Notes

- Slash commands inside each connected channel — `/new`, `/list`, `/switch`, `/current`, `/rename`, `/delete`, `/help` — are now always on and mirror the CLI semantics.
- Display name and chat-session title are independent: rename in the CLI / web "Rename channel display" updates `display_name`; rename in web "Rename session title" updates the chat-session title. Either appears in the web sidebar; the 🏷️ marker indicates a user-set channel display name.
- `nca update --force --yes` pulls the new binary; existing daemons keep working unchanged.
