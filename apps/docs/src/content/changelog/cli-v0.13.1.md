---
version: '0.13.1'
date: '2026-06-17'
---

## CLI 0.13.1 — whoami works inside hosted agents

`mf whoami` now recognizes hosted runtime identity tokens, so an agent can
inspect its own authenticated identity and context without a human login.

### Highlights

- **Runtime identity support.** Hosted agents no longer fail identity
  inspection.
- **No token exposure.** The command reports identity metadata, not the
  injected bearer.
