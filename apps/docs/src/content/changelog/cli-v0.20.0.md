---
version: '0.20.0'
date: '2026-07-28'
---

## CLI 0.20.0 — A2A access management and streaming file transfer

The CLI can manage hosted A2A exposure and callers, while runtime file
transfers become stream-safe and capability-aware.

### Highlights

- **A2A lifecycle controls.** `mf a2a exposure` and `mf a2a callers` manage
  public exposure, peer grants, External client tokens, and revocation.
- **One-time External client bearers.** Human output can be redirected straight
  to a secret store; endpoint guidance remains on stderr.
- **Streaming upload/download.** `mf files upload` and `download` keep memory
  flat and preserve an existing local file if a transfer fails.
- **Agent context for files.** Every file command can use `--agent-id` or
  `MF_AGENT_ID`, so the positional agent ID is optional.
- **Visible transfer limits.** `mf files roots` reports each transport's real
  limits and capabilities; oversized uploads fail before transfer.
- **Symlink containment.** File operations reject symlinks that resolve outside
  the authorized root.
