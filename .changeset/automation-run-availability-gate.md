---
'@manyfold/api': minor
---

An automation run now checks the agent's machine before it starts. If the agent's computer is offline, or its runtime is not ready, the run fails straight away with `agent is offline` or `agent is unavailable`: no chat session is opened and no prompt is sent, and a run started by hand answers `400` with that reason. Before, this check never ran. The run opened a chat, sent the prompt and only then failed with `chat_runner_unavailable`. A sleeping sandbox is still admitted, and the run wakes it.
