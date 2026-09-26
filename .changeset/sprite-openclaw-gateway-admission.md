---
'@manyfold/api': minor
---

OpenClaw turns on sprites are no longer refused with `openclaw_daemon_gateway_unavailable` when the sprite has just woken up. A sprite's gateway is a service the platform runs, like a cloud computer's, so only a BYOD daemon's heartbeat probe can refuse a turn now. A sprite runner takes that probe as it connects, a few seconds before the gateway it woke with starts answering, so the probe said the gateway was down when it was only booting.
