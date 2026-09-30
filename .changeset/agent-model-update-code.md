---
'@manyfold/api': minor
---

`PATCH /agents/:id` with a `model` for a framework that keeps its model in the agent's model settings (Claude Code, Codex, Gemini CLI, pi, Antigravity CLI) is still refused, now with the code `AGENT_MODEL_IN_MODEL_CONFIG` and `details: { agentId, framework }`, so a client can send the model to `/agents/:id/model-config` instead. Nothing in the request is written, a new name included.
