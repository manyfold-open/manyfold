---
'@manyfold/api': patch
---

Keep External A2A grants target-bound during a rolling Phase 8 upgrade while leaving personal tokens unbound. A temporary database trigger maintains the binding flag for older API readers when switch writers omit it. Deploy this preparation release across the fleet before the separate column-removal release, which also removes the trigger.
