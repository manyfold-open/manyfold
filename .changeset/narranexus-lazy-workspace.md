---
"@manyfold/api": patch
---

Allow a fresh NarraNexus runner turn to reach its local gateway before the gateway has lazily created the agent workspace. Runner admission no longer rejects the not-yet-created NarraNexus workspace; coding and Hermes workspace checks remain unchanged.
