---
'@manyfold/api': minor
---

Creating an agent on an existing sandbox (`POST /agents` with `sandboxId`) now checks that the sandbox belongs to the account the agent is created for, under the same rules as installing a framework onto it, and answers 404 `SANDBOX_NOT_FOUND` otherwise. Adding an agent to a runtime checks the runtime's owner the same way.
