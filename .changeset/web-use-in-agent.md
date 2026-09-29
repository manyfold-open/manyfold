---
'@manyfold/web': minor
---

Add "Use it in your agent" to the account menu in the sidebar. It opens a dialog with a one-line prompt to paste into Claude Code, Codex or any agent that can run shell commands; the prompt points the agent at this deployment's `/api/agent-setup.md`. Outside production it adds a sentence naming the deployment (a local dev stack, or the API host) so the agent keeps it in a separate `mf` profile. The prompt follows the interface language. The CLI sign-in page now has a Copy button next to the one-time auth code.
