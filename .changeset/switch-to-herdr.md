---
'@manyfold/api': minor
'@manyfold/web': minor
'@manyfold/cli': minor
---

Hand a chat session to herdr on your own computer. When an agent runs on a self-owned daemon that has herdr installed, the chat header's "Switch to TUI" becomes "Switch to herdr": the daemon opens the conversation's Claude Code or Codex TUI in a herdr pane (a workspace per agent, a tab named after the conversation), focuses it, and hands the conversation back to the web by itself when the TUI quits or the pane closes. While herdr holds the conversation the web offers "Show in herdr" and "Continue in web". Machines without herdr keep the browser terminal. `mf daemon status` and `mf daemon doctor` report herdr availability.
