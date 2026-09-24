---
'@manyfold/api': patch
---

An agent added to a sandbox that already exists, which is how the four-step
create flow always adds one, now gets its Manyfold context doc
(`AGENTS.manyfold.md` and the reference in its instruction file), as an agent
created with its own sandbox always did. And a Codex turn that another API
instance finished after a restart no longer comes back as duplicate messages
the next time the conversation syncs with the runtime.
