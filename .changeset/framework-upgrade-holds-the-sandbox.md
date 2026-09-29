---
'@manyfold/api': minor
---

A framework upgrade on a sandbox keeps the sandbox awake from its first step through verification. Before, a rebuilt Hermes or NarraNexus service could time out while starting on a sandbox that had fallen asleep, which left the service down. OpenClaw's service restart after an in-place upgrade no longer has that problem either.
