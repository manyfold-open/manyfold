---
version: "0.30.3"
date: "2026-09-07"
---

No command, flag or output changed in this release.

Internally, the daemon's ACP client now shares one implementation with the
platform's: the decoders that read an agent's streamed events, permission
requests and session state moved into a common package, so a turn you run
locally and a turn replayed after a reconnect are read by exactly the same
code. Behaviour is unchanged in both directions.
