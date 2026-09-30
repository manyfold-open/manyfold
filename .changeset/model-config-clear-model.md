---
'@manyfold/api': minor
---

Clearing an agent's model on a model provider works. `PATCH /agents/:id/model-config` with `model: null` (what `mf model-config update --clear-model` sends) kept the saved model for Claude Code, Codex, Gemini CLI and pi, so the clear changed nothing. It now puts the agent back on the framework's default there: for Claude Code the alias a new agent on the provider gets (`sonnet` where the provider has a Sonnet), for Codex the first supported model the provider was tested with, for Gemini CLI `auto` (on a gateway, its default model), and for pi the credential's own default. Antigravity CLI and a subscription sign-in already cleared this way.
