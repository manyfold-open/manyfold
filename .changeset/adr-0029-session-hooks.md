---
'@manyfold/api': minor
'@manyfold/cli': minor
'@manyfold/web': patch
---

Terminals now tell the platform which CLI session they are on (ADR-0029 §3, hook reporting).

- `mf daemon hooks install | uninstall | status`: Manyfold's `SessionStart` / `SessionEnd` hooks for `claude` and `codex`, written as one marked script plus one marked entry per event in `~/.claude/settings.json` and `~/.codex/hooks.json`, next to your own hooks. `mf daemon register` asks once (`-y` says yes, `--no-hooks` says no); the choice is remembered and `mf daemon start` keeps the hooks current. A sprite runner installs them by default. The hooks act only inside a terminal Manyfold opened (`MF_TERMINAL_ID`), never print, and are not installed on Windows.
- API: `POST /terminal/session-hooks`, reachable only with the token of a live Manyfold terminal. A resume that came back under a new id, or a compaction that changed it, moves the chat session to the new ref after importing the old ref's tail; a TUI that opens an idle chat session takes its hold; one that opens a session with a turn in flight, or held by another terminal, is left alone and the tab is warned; a session that started fresh in the terminal (`startup`, `/clear`, fork) becomes a chat session of its own — marked `origin: terminal` — when the terminal ends, if its transcript is not empty; `SessionEnd` gives the hold back and runs the import without waiting for the terminal to close.
- Every terminal Manyfold opens now carries the full four-key runtime identity (`MF_API_URL` and `MF_DEPLOY_ENV` were missing on the daemon arm) plus `MF_TERMINAL_ID`, registered as terminal surfaces of the exec env contract.
