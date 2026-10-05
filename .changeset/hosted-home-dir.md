---
'@manyfold/api': minor
---

A sandbox or cloud computer created before 8.0.0 gets its agents' MCP servers again when its daemon reconnects, and importing MCP servers from it works. The 8.0.0 upgrade that merged each machine's runner into the machine left the machine without a home directory. Since then, the automatic delivery after every reconnect failed for every MCP scope, with nothing in the logs, and an import answered `agent runtime home dir is unknown`. A migration restores the home directory the machine's image runs under (`/home/sprite` on a sandbox, `/home/node` on a cloud computer). The workspace and skill roots are left as they were, because only the machine's own registration can declare them.
