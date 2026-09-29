---
'@manyfold/api': minor
'@manyfold/cli': minor
---

A sandbox or cloud computer whose daemon has work in progress when it needs a newer Manyfold CLI now answers "updating once its current work finishes; retry in a few minutes" within seconds. Before, the caller waited three minutes and was told the daemon did not come back. The update is asked for once: a daemon that is draining for an update now keeps its first deadline, so asking again no longer puts the update off.
