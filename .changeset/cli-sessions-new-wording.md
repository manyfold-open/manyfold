---
'@manyfold/cli': minor
---

`mf channels sessions new --help` and the agent guide no longer say that `new` archives the current session. It leaves that session inactive: it stays in `sessions list`, and `sessions switch` brings it back. Only `delete` archives. The `sessions delete` help now says that `--activate-fallback` activates a fallback only when the active session is the one deleted.
