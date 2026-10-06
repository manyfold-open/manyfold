---
'@manyfold/web': patch
'@manyfold/api': patch
---

Approving a CLI sign-in from your phone no longer stalls it. When an agent runs `mf login` on a computer and you approve from your phone (steering a Codex or Claude Code session remotely), the consent page used to redirect the phone to `127.0.0.1`, which reaches nothing, and the agent waited out the full 15 minutes before asking you to approve a second time. On a phone the page now shows the one-time `mf_auth_` code to send back instead. On a computer it still finishes on its own, and a "Not on the computer running mf?" link gets you the code when you approve from another machine. The agent setup guide (`GET /api/agent-setup.md`) tells the agent to stop waiting and redeem a code you send back with `mf login --auth-code`, which every installed `mf` already supports.
