---
'@manyfold/api': minor
---

Add an API-driven ACP transport for openclaw chat turns on the sprites-no-runner and k8s cells, behind `MF_OPENCLAW_ACP` (default off). When enabled, the adapter drives `openclaw acp` — a bridge to the resident gateway — over the interactive exec transport using the shared `AcpTurn` client, replacing the stateless gateway-HTTP path (30-message resend) with the gateway's own server-side history keyed by a deterministic `_meta.sessionKey`. narranexus keeps the gateway-HTTP path (the ACP branch is guarded on `framework === 'openclaw'`). Non-resumable by construction; every failure is a retryable error, never suspended.
