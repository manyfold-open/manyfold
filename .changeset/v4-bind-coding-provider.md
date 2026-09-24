---
'@manyfold/web': patch
---

The four-step create flow now binds the provider picked at "Model cost" to a Claude Code, Codex or Gemini CLI agent. The agent joined its machine without one: on a sandbox it had no model credential at all, and on your own computer it silently ran on that computer's own sign-in instead of the key or managed billing you chose. The flow now binds the choice right after the agent joins, with the same model defaults the agent's settings would propose. A provider that was never tested, or that the CLI cannot talk to, stays listed with its reason and cannot be picked. On a machine that already runs agents, the step says that the ones billed to your account switch too, because that credential belongs to the machine.
