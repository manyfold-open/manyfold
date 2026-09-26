---
'@manyfold/api': patch
'@manyfold/cli': patch
---

Harden A2A calls: invalidate peer tickets when their owner is deactivated, recover task results after a server restart, block DNS rebinding, and preserve concurrent agent configuration updates. Apply CLI send deadlines to discovery and streaming, report remote cancellation consistently, retain input and authentication prompts, and preserve HTTP error status and reasons.
