---
'@manyfold/api': minor
---

Upgrading OpenClaw's version on a sprite now restarts its gateway onto the new version. sprites.dev has no service restart endpoint: the upgrade installed the new binary, then failed with a 404 and left the gateway running the old version. It now stops the service and starts it again, and it reports an error instead of claiming a restart if sprites.dev refuses to stop the service.
