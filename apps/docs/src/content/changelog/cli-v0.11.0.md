---
version: '0.11.0'
date: '2026-05-28'
---

## CLI 0.11.0 — chat sessions survive daemon disconnects

Chat runs backed by your local `nca` daemon now survive transient
daemon↔cloud connection loss — laptop sleep, network blips, or a server
restart no longer kill an in-progress assistant turn with a
`claude_exec_failed` error.

### Highlights

- The daemon buffers exec output to disk and replays it after reconnecting, so a brief disconnect no longer loses work.
- When the daemon comes back, the cloud transparently resumes the in-flight assistant turn instead of failing the message.
- Messages whose daemon is temporarily offline are now held in a `suspended` state and resume automatically, rather than ending in an error.

### Notes

- To get the new behaviour, update the daemon: `nca update --force --yes`, then restart any long-running daemons.
- Fully backward compatible — older `nca` versions keep working against the updated cloud API; the disconnect-survival path engages once you are on 0.11.0.
