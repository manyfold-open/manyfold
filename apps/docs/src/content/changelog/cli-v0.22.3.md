---
version: '0.22.3'
date: '2026-08-05'
---

## CLI 0.22.3 — More reliable turns across reconnects

This patch makes long-running agent turns safer when a daemon or API instance
reconnects, and improves runner support for agents with custom workspaces.

### Highlights

- **Authoritative reconnect state.** The daemon now distinguishes a confirmed
  empty stream list from a failed enumeration, so a reconnect cannot
  incorrectly mark active turns as lost.
- **Longer resume window.** Completed execution buffers remain available for
  60 minutes, giving the platform time to finish draining or resume a turn
  across rolling deploys and transient disconnects.
- **Custom workspace support.** Runner daemons recognise NarraNexus workspace
  roots, preventing `outside allowed roots` failures for co-resident coding
  agents.
