---
'@manyfold/api': patch
---

The runner and sandbox-probe events added in the previous release no longer bring new attribute names to the log store, which is at its column limit and refused every batch that carried one. `chat.runner.resolve` reports its attempt as `attempts`, and `sprite_exec.probe` no longer sends `cold` (its `leaseMs` already tells a cold probe from a warm one). Chat-turn logs and traces reach the log store again.
