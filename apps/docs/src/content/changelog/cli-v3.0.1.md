---
version: '3.0.1'
date: '2026-09-16'
---

The daemon now admits one process per profile. Concurrent foreground starts
stop before opening a connection or sending heartbeats, and a live control
socket prevents a second daemon from starting even when its PID file is missing.
Kernel ownership is recovered after a crash, including container restarts that
reuse PID 1.

Repeated starts and reconnect callbacks keep one connection attempt active.
Events from an older socket cannot close its successor or remove a newer RPC's
cancellation handler. Connection diagnostics can report the client process
identity without changing the existing authentication contract.

Let active work finish and close any duplicate foreground copies from an older
CLI. Run `mf daemon stop`, `mf update`, then `mf daemon start` for the selected
profile. Keep its registration and workspace data. See the self-owned computer
guide for profile-specific commands and recovery guidance.
