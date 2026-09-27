---
version: '5.1.0'
date: '2026-09-27'
---

A turn now carries the directories it may work in. The platform sends them
with each `exec.start`, and the daemon admits them for that exec only, so an
agent whose workspace sits outside the managed tree (a coding agent that
shares a sandbox with another framework) no longer needs a separate
registration round trip before every turn. The daemon advertises this as
`exec.roots.v1`; a platform that needs it on an older daemon asks for an
update instead of failing mid-turn.
