---
version: '4.6.1'
date: '2026-09-25'
---

`mf a2a send --stream` and `mf a2a tasks subscribe` now print a peer's answer
once, when the stream ends, instead of writing each chunk as it arrives. A
peer can replace an artifact it has already sent, and text written to a pipe
cannot be taken back, so the final text is what you get. Status lines still
go to stderr as the task progresses, and `--json` still emits every event
live.
