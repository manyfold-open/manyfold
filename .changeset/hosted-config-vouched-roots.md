---
'@manyfold/api': minor
---

A sandbox agent whose workspace sits outside its daemon's own workspace tree, such as one created under the older `~/.nca/workspaces`, gets its context file and its project MCP servers again. Configuration is written through the daemon's protected file calls, which refuse a folder the daemon does not know, so every delivery to such an agent failed on each reconnect while its turns still ran. On a hosted machine the platform now vouches for the agent's workspace on each configuration read and write, as the files view already does. A self-owned computer still accepts only the folders its own daemon registered.
