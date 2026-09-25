---
'@manyfold/cli': minor
---

The runner no longer admits a framework home directory outside the core set by default. A framework that keeps its workspace under its own home now has the API register that root with the runner before a turn, so its agents keep working.
