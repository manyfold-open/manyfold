---
'@manyfold/api': minor
'@manyfold/web': minor
---

Make a terminal's hold on a chat session explicit, and gate the next turn on importing what it wrote (ADR-0029 §1, §2).

- Resuming a session's TUI in the terminal now takes the session's writes as its last step. While held, web sends, channel messages, A2A tasks and the OpenAI-compatible endpoint are refused with a stable `409 session_held_by_terminal`; channel messages get a notice, ones already queued stay queued. The invariant is a database CHECK, so two writers can no longer share one transcript.
- The chat view shows "Open in a terminal · Back to web" over a read-only composer; a second tab sees the same and can release from there. Closing the terminal, a reconnecting tab, or a lease that ran out (the reaper, audited) all release it by killing the process through its handle first.
- Releasing stamps the import pending in the same statement and imports the terminal's transcript; a turn is refused with `409 session_import_pending` until that import has actually read the transcript, with one bounded retry at the gate, a manual retry, and an explicit abandon (automatic when the runtime is no longer the one the terminal wrote on).
- Sprites terminals now kill their exec session on close instead of leaving it running and billed; daemon terminals wait for the pty close ack before releasing.
