---
'@manyfold/web': minor
'@manyfold/api': minor
---

The chat's right-hand runtime session panel becomes **Agent sessions**, and it
opens on a list of every conversation the agent has instead of dropping you into
one transcript.

The list is the union of both places a session can live. The cloud database
holds the conversations you started in the web app; the framework's own CLI
leaves transcripts on the runtime. They are joined on the runtime's session id,
so a conversation that exists on both sides is one row, and each row says which
sides it is on, whether it is the conversation currently open, how many messages
it holds, when it was last active, the model that wrote the newest reply and
what that reply said. A row we never read on the runtime stays silent about
replies rather than claiming there were none.

An unreachable runtime no longer fails the whole panel. A stopped sandbox or an
offline daemon now degrades to the cloud half of the list and says the local
side is unknown, instead of returning a service error.

Each row carries a menu to copy the framework's resume command, the session id
and the transcript's file path, refused with a reason where the row has no
runtime transcript or the framework's CLI cannot be pointed at a session by id.
The copied command is deliberately the plain `claude --resume <id>` /
`codex resume <id>` form: the terminal's own resume adds a permission-bypass
flag because it is entering a runtime that is already the trust boundary, and a
command on your clipboard runs wherever you paste it.

Opening the panel used to read a whole transcript before it could show anything.
The list is now its own endpoint, `POST /agents/:id/runtime-sessions/list`, which
runs one bounded scan and reads no transcript; opening a named session skips the
scan the caller already paid for. That scan now also reads the last 64 KiB of any
transcript past its head window, because the newest reply, its timestamp and its
model are at the end of the file. Frameworks whose transcripts record no model —
OpenClaw and Hermes — leave that field empty rather than showing a guess.
