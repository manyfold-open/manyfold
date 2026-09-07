---
'@manyfold/api': patch
---

Fix newly created OpenClaw sprite agents answering every request with `proxy_attribution_required`. OpenClaw 2026.8.1 and later attribute proxy-shaped traffic to a client IP before gateway auth and reject what they cannot attribute, so the loopback-only `trustedProxies` we wrote into `openclaw.json` made the sprite platform's own ingress untrusted — the agent's chat endpoint and its Control UI both returned 403 before the gateway token was ever read.
