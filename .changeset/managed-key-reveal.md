---
'@manyfold/api': minor
---

Platform-managed provider keys can no longer be revealed. `GET /api/model-providers/:id/reveal` on a managed provider, and `GET /api/agents/:id/credentials/reveal` for an agent whose key belongs to one, now answer 403 with code `managed_key_not_revealable`. A managed key draws on platform-funded credit, so it is only used inside an agent's runtime; keys you added yourself can be revealed as before.
