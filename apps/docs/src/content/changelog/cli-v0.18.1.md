---
version: '0.18.1'
date: '2026-07-16'
---

## CLI 0.18.1 — The installer can run setup safely

The one-line installer can pass control to interactive `mf setup` without
logging forwarded secrets.

### Highlights

- **Install and onboard in one command.**
  `curl … | sh -s -- setup` remains interactive.
- **No unnecessary download.** An already-installed matching version is reused
  before the requested setup command runs.
- **Correct environment examples.** Installer configuration examples now put
  variables on the process that actually consumes them.
