---
'@manyfold/api': minor
'@manyfold/web': minor
'@manyfold/cli': minor
---

Hand a chat session to herdr. When an agent's runtime has herdr installed — your own computer running the daemon, or a sandbox — the chat header's "Switch to TUI" becomes "Switch to herdr": the conversation's Claude Code or Codex TUI opens in a herdr pane (a workspace per agent, a tab named after the conversation), and the web's terminal view shows that herdr with the pane focused. Views follow the conversation on their own: a session held by herdr shows herdr, quitting the TUI there brings the chat back with what was said imported, and "Switch to Chat UI" takes the conversation back. The banner's Show in herdr / Continue in web / Back to web buttons are gone; the header switch is the only control. Sandboxes get herdr installed when their runner is set up, and the Update Center lists herdr next to the mf CLI for every machine and sandbox, with upgrade (and install) actions; the runtime detail page shows the herdr version. `mf daemon status` and `mf daemon doctor` report herdr availability and version.
