---
'@manyfold/api': patch
'@manyfold/web': patch
---

Fixes for folding a resumed TUI's messages back into the chat. Appended
messages now carry their `done` terminal in the same transaction (all recovery
writers), so a page reload no longer mistakes a synced turn for a dead inflight
one and stamps `server_restart` over it. The append is idempotent by
`source_event_key`, so repeated Chat↔TUI switches can no longer duplicate
messages, and a TUI turn that is still streaming is left for the next sync
instead of being frozen as an empty bubble. The session terminal now follows
the sidebar's session switch, resuming the newly selected session — and the
sync runs the other way too: messages sent from the chat after the TUI was
opened rebuild it on the next switch, so the resumed TUI always shows the
whole conversation.
