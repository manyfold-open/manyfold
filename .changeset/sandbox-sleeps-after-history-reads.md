---
'@manyfold/api': patch
---

Sandboxes fall asleep again after gemini and codex turns, after a turn picked back up following an API restart, and after a session is imported from a terminal. Each of those read the agent's session history from the sandbox and left it held awake, and billed as active, until the API restarted; a history read now keeps the sandbox awake only while it runs.
