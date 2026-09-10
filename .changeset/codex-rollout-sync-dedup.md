---
'@manyfold/api': patch
---

Opening a Codex session right after a turn no longer appends the model's own preamble (`# AGENTS.md instructions for …` plus the environment context) to the chat as a user message, and no longer duplicates a reply whose turn ran a command. Each settled turn now records how far the runtime's transcript reached, and the runtime-session sync appends only what a terminal session added past that point, complete turns only, instead of diffing the transcript against the chat by content.
