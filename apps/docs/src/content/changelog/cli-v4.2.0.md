---
version: '4.2.0'
date: '2026-09-23'
---

The daemon can hand a chat session to herdr. When `herdr` is on the
machine (on `PATH` or in `~/.local/bin`), "Switch to herdr" in the web opens
the conversation's Claude Code or Codex TUI in a herdr pane, with a workspace
per agent and a tab named after the conversation. The conversation comes back
to the web by itself when the TUI quits or the pane closes. Handing the same
conversation over again reuses its tab, and a daemon that restarts adopts the
panes it opened, so their conversations stay handed off. A platform runner
starts `herdr server` itself inside its sandbox. The daemon reports herdr's
version so the Update Center can show and upgrade it, `mf daemon status`
counts the terminals running in herdr, and `mf daemon doctor` says whether
herdr is available. A plain terminal closed from the web now hangs up its
shell instead of leaving it running.
