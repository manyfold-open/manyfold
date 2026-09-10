---
'@manyfold/cli': minor
---

Send daemon WebSocket credentials in the Authorization header instead of the
URL. Self-hosted deployments must upgrade to Manyfold v0.5.0 (API 1.1.0) or
newer before updating the daemon. Daemons advertise `ws.auth-header` so operators can verify the fleet
before retiring query authentication.
