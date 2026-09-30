---
'@manyfold/api': minor
---

An OpenClaw agent's chat now runs as that agent. Every turn used to go to OpenClaw's `main` agent, so an agent added to an OpenClaw runtime answered with `main`'s workspace and settings; the session now names the agent's own OpenClaw id (`main` for the framework's own agent). A chat started earlier with such an agent continues in a fresh OpenClaw session of the right agent.

Rewriting the gateway's config (a credentials, environment or control UI change) also keeps the agents OpenClaw added: the rewrite used to drop them, and each one failed its next turn.
