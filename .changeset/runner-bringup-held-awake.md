---
'@manyfold/api': minor
'@manyfold/cli': minor
---

A turn on a sandbox whose runner has to be started no longer fails with "Chat runner unavailable" because the sandbox went to sleep while the runner was connecting. The sandbox is now kept awake from the moment its runner starts until the runner connects, whether a turn started it, a sign-in on the runtime page woke it, or an mf CLI upgrade restarted it. The first start after a CLI upgrade can take about a minute.

A daemon no longer exits at startup when a herdr or coding CLI binary it finds cannot be executed, such as an empty file left behind by an interrupted install; that binary is reported without a version instead. A sandbox with an empty herdr gets herdr reinstalled the next time its runner starts, and a herdr update that cannot run herdr at all now says so instead of reporting a timeout.
