---
'@manyfold/admin': minor
'@manyfold/api': minor
---

Show each turn's prompt and result on the admin chat-session page.

The page had three cards — Session, Turns, Events — and none of them showed a
line of message body. The Turns table identified a turn by a bare UUID, so the
first question anyone opens the page with ("what did the user ask, and what did
the agent answer?") could only be answered by reading `token` event payloads
back one row at a time, and only for as long as those rows exist.

A Transcript card now sits between Turns and Events, pairing each assistant
turn with what was sent to produce it, newest first, 20 turns to a page. Each
entry carries the same figures as the table row above it — state, model,
tokens, cost, TTFT, duration — plus a `Trace events` button that drives the
Events card's existing per-turn filter, so one click gets you the prompt, the
answer and the event trace for the same turn.

It reads `chat_messages.content_blocks_json`, which outlives the event log:
stream-log compaction deletes a turn's token and thinking rows, so for a
compacted turn these blocks are the only surviving copy of what it produced.
The card says so.

The result renders as the answer text the user saw, with `thinking`,
`tool_call` and `tool_result` blocks folded behind a toggle that names what it
holds (`1 thinking block · 2 tool calls · 2 tool results`) — a coding turn with
forty tool calls would otherwise bury the answer it is supposed to show. An
unrecognised block kind keeps its raw type and renders as JSON rather than
being dropped: the column is jsonb, and a row recovered from a runtime session
file is not this build's to assume.

Three states that used to be indistinguishable now say which they are. A turn
whose prompt row retention has already deleted reports that, instead of
borrowing the previous turn's prompt or rendering blank — retention deletes
`chat_messages` in batches, so a turn really can outlive its own prompt. A
still-streaming turn says it is streaming rather than claiming it produced
nothing, because the blocks are written at the terminal event. A turn that
genuinely produced no answer text says that.

`GET /admin/chat-sessions/:id/turns?limit=&before=` is the new endpoint behind
it, keyset-paged on `(created_at, id)` like the share transcript it mirrors.
Content stays off `GET /admin/chat-sessions/:id`, whose response already
carries up to 100 turns and would grow by tens of kilobytes each. A turn's
input is the messages between the previous assistant message and this one —
normally one user message, but a recovered transcript can carry a system
preamble and more than one prompt, and they arrive in the order the agent
received them.
