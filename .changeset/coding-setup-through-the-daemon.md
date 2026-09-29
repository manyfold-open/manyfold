---
'@manyfold/api': minor
---

Creating a coding agent on a sandbox now sets its framework up through the sandbox's daemon, the way a cloud computer does. It no longer logs codex in with the platform key, which left the key in `~/.codex`, and no longer spends a paid Claude Code check turn. A custom workspace is checked and admitted by the daemon, and the agent's context doc is delivered once the agent exists. Resuming a codex conversation in the sandbox terminal now follows the sandbox's model-credentials setting, like Claude Code, pi and Antigravity CLI: the TUI gets the platform key for that session only.
