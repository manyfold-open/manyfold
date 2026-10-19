---
'@manyfold/api': minor
---

A sandbox whose machine keeps running but has accepted no command for 30 minutes now goes into maintenance, so its owner is told and its turns are refused at once instead of each one failing after a wait. The health check used to look only at whether the machine was powered on, so a machine stuck that way read as healthy indefinitely. A sandbox in maintenance for this reason leaves it as soon as a command gets through again. Operators can tune the threshold with `MF_SANDBOX_EXEC_DEAD_AFTER_MS`.
