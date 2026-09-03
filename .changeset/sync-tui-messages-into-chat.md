---
'@manyfold/web': minor
'@manyfold/api': minor
---

Messages you write in the resumed terminal TUI now appear back in the chat
view. The TUI writes only to the framework CLI's own transcript, which the
cloud chat never read, so continuing a conversation there used to vanish from
the structured view. The chat now folds that transcript's additions back into
the session — on switching back from the terminal, and on opening the session —
by diffing the CLI's file against the stored messages and appending only what
is new. Idempotent and skipped while a live turn is running, so it is safe to
run automatically. Claude Code and Codex; the API endpoint is
`POST /agents/:id/runtime-sessions/sync`.
