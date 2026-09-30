---
'@manyfold/api': minor
'@manyfold/web': minor
---

`PATCH /agents/:id` with `mcp` changes only the scopes it names, as its contract says: a scope left out keeps its MCP servers, and an empty string clears one. The whole per-scope map used to be replaced, so an update of Claude Code's `user` scope dropped the `project` scope's servers, and the next push emptied the workspace's `.mcp.json`. The merge happens in the database, so two scope edits at once both land. Reading a machine's MCP config back into Manyfold (`POST /agents/:id/mcp/refresh`) likewise writes only the scopes it read in. The web app now sends only the scope it edits.
