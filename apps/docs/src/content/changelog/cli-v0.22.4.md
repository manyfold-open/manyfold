---
version: '0.22.4'
date: '2026-08-06'
---

## CLI 0.22.4 — Reliable long-running Hermes and OpenClaw turns

This patch stops active Hermes, OpenClaw, and NarraNexus turns from being
mistaken for stalled work when they run beyond the old fixed deadline.

### Highlights

- **Activity-aware timeouts.** Streaming output now refreshes the inactivity
  budget, so productive long-running turns continue instead of being cut off
  after four minutes.
- **Separate safety ceilings.** Connection, inactivity, and maximum-duration
  failures are tracked independently and report which budget expired.
- **Consistent runner transport.** The same timeout model applies when a turn
  runs through a self-owned computer, including compatibility with older
  runners that still understand the legacy timeout field.
- **Immediate cancellation.** Cancelling an OpenClaw turn now aborts the live
  gateway request instead of leaving its response stream running.
