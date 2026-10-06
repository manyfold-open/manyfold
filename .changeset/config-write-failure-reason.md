---
'@manyfold/api': patch
---

A configuration write that fails on a machine now logs which host and agent it was for and why, in fixed words: `outside_allowed_roots`, `timeout`, `offline`, a `config_commit_*` code, or the error's class. This covers both the context file and each MCP scope. Before, the warning said only that a write had failed, and the daemon's own reason was dropped.
