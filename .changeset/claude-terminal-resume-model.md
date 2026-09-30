---
'@manyfold/api': minor
---

A Claude Code conversation opened in a sandbox's terminal (the browser terminal or herdr) runs the agent's model. The terminal resumed it with the platform's credentials but no `--model`, and on resume Claude Code falls back to the model the session last used, so after a switch (say from Sonnet to Haiku) the terminal kept running the old one. It now gets the agent's model and its model mapping, as a chat turn does. A terminal on the sandbox's own sign-in is unchanged, and when the agent's settings cannot be read the terminal resumes as before.
