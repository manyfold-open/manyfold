---
version: '0.2.1'
date: '2026-05-06'
---

## CLI 0.2.1 — Daemon lifecycle hardening

This patch release hardens local daemon process management and CLI authentication session handling.

### Highlights

- Hardened `nca daemon` start and stop behavior with shared pidfile handling.
- Added stale-pid recovery when a previous daemon process exited unexpectedly.
- Added a start lock to avoid overlapping daemon launches.
- Propagated daemon-stopped state back to agents more reliably.
- Bounded CLI login sessions and consumed login state atomically.

### Notes

- This release focuses on reliability for local machine runtimes and browser-based CLI login.
