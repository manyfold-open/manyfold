---
'@manyfold/api': minor
---

Upgrading a sandbox's Manyfold CLI now keeps the sandbox awake until the updated daemon reports back, and the upgrade answers with the new version. The sandbox no longer falls asleep during the handover and shows the old CLI until its next wake.
