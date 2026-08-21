---
version: '0.22.5'
date: '2026-08-07'
---

## CLI 0.22.5 — Safer recovery across runner reconnects

This patch hardens the daemon-side stream recovery used when a self-owned
computer or runner replaces its connection while a turn is starting.

### Highlights

- **Terminal results stay terminal.** A completed resume probe is returned as
  the result instead of being mistaken for another connection failure and
  retried in a loop.
- **Cancellation wins.** Cancelling during reconnect backoff now remains a
  cancellation rather than surfacing the earlier offline error.
- **Bounded recovery probes.** When the API stops waiting for remote recovery,
  the CLI detaches that subscriber so it cannot linger behind the scenes.
- **Rolling-upgrade compatibility.** Transport errors carry explicit origin
  metadata while remaining compatible with servers and CLIs that have not yet
  upgraded.
