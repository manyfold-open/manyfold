---
'@manyfold/cli': minor
---

File-based execs (`MF_DAEMON_EXEC_FILES=1`, ADR-0029 §4) now cover execs that run under a runtime auth profile and execs with temporary settings. The profile lease travels with the exec as a path in its meta (never the composed env): a daemon that adopts the exec after a restart re-stamps the lease with itself before it reconnects, and stops the exec instead if the lease is already gone or held by another live process; the temporary-settings directory is drained and removed at completion whichever daemon gets there. Only an exec that keeps stdin open still uses the pipe path.
