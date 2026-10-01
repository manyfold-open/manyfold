---
'@manyfold/api': minor
'@manyfold/web': minor
'@manyfold/cli': minor
---

A sandbox CLI update that the sandbox defers until its current sessions finish now completes. Before, the sandbox could fall asleep with the update half done. The API keeps the sandbox awake until the new CLI reports, which takes at most about 12 minutes and counts as active time.

While the update waits, the sandbox summary carries `cliUpdateDeferred` (`activeSessions`, `deadline`). The runtimes page and `mf sandbox update` say how many active sessions the update is waiting for, instead of reporting the old version as upgraded. The Update Center keeps the row waiting until the sandbox reports another CLI. Asking again while the daemon is applying the update now waits for the new CLI instead of answering 503.
