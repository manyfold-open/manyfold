---
'@manyfold/web': minor
'@manyfold/api': minor
---

The chat's right-hand runtime session panel is now Agent session history, and it
opens on a list instead of dropping you straight into one transcript. Each row
carries the prompt that started the session, the agent's most recent reply, how
many messages it holds, when it was last active and which model wrote that last
reply; clicking a row opens the transcript, with the preview / raw switch and
the restore, open and rebuild actions unchanged behind a back button.

Opening the panel used to read a whole transcript before showing anything, and
the only way to see the other sessions was a dropdown of bare identifiers. The
list is now its own endpoint, `POST /agents/:id/runtime-sessions/list`, which
runs the bounded candidate scan and reads no transcript at all; opening a named
session skips the scan it already paid for. The scan additionally reads the last
64 KiB of any transcript longer than its head window, because the newest reply,
its timestamp and its model are at the end of the file and nothing in the head
can stand in for them. Frameworks whose transcripts record no model — OpenClaw
and Hermes — leave that field empty rather than showing a guess.
