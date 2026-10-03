---
version: '5.10.0'
date: '2026-10-03'
---

The daemon now starts again after a restart that left its old pid file
behind, and stopping it never signals some other process.

A daemon killed without cleaning up leaves its pid file in place, and after
the machine or its container restarts, that number can belong to another
process. `mf daemon start` used to take that process for the daemon and exit
with "daemon already running" every time, until the file was removed by
hand, and `mf daemon stop` signalled it. Both now treat a pid file written
before the process holding its pid started as stale: the daemon starts, and
stop leaves the other process alone. `mf daemon status` and `mf doctor`
report the daemon the same way.
