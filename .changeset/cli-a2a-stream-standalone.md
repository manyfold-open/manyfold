---
'@manyfold/cli': minor
---

`mf a2a send --stream` no longer hangs in the standalone `mf` binary. Before, the reply finished on the server within seconds, but the command printed nothing and never exited. A2A requests from the standalone binary now use Bun's own fetch. They are still pinned to the address the SSRF check approved, and the TLS certificate is still verified against the endpoint's host name. The source build was not affected.
