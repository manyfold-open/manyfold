---
'@manyfold/api': minor
'@manyfold/web': minor
'@manyfold/cli': minor
---

Retire the Phase 8 user-grant compatibility layer. The API no longer exposes the legacy CLI poll route or bearer-grant endpoint, runtime authorization no longer uses `enforce_agent_binding`, and the web CLI approval screen keeps only browser login. External A2A grants remain supported.
