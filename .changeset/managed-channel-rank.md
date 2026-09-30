---
'@manyfold/api': minor
---

The model provider list (`GET /model-providers`) now reports `managedRank` on managed rows where the edition ranks its channels. It gives the order in which "Manyfold managed" picks a channel when several can serve an agent, lowest first, so every client resolves that choice the same way.
