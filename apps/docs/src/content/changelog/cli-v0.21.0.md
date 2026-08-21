---
version: '0.21.0'
date: '2026-07-29'
---

## CLI 0.21.0 — More agent turns survive API restarts

Hermes and OpenClaw turns can keep their upstream process and stream alive in
the daemon while the Manyfold API restarts.

### Highlights

- **Daemon-owned turn transport.** The daemon journals frames to its durable
  exec buffer while the API reads and replays them.
- **Positive completion evidence.** Recovery marks a turn complete only after
  the framework supplies its real end signal; ambiguous streams stay
  retryable.
- **Faster runner presence.** The daemon connects its WebSocket before slow
  framework probes, reducing false offline timeouts.
- **Earlier Hermes validation.** A missing primary model is rejected during
  creation instead of producing an unusable agent.
