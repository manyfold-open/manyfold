---
'@manyfold/cli': minor
---

`mf daemon start` no longer refuses with "daemon already running" when the daemon's pid file is left over from before a restart and its number now belongs to another process, and `mf daemon stop` no longer signals that process. A pid file written before the process now holding its pid started is treated as stale. Before, a daemon killed without cleanup could leave a machine whose daemon never started again until the file was removed by hand.
