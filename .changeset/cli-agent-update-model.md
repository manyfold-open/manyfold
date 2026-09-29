---
'@manyfold/cli': minor
---

`mf agent update --model` and `--clear-model` set a coding agent's model. Claude Code, Codex, Gemini CLI, pi and Antigravity CLI keep the model in the agent's model settings, so the CLI now sends it there, the same change `mf model-config update --model` makes, instead of failing with `Use /agents/<id>/model-config to update claude-code models`. The output adds a `model` line, with the id an alias stands for (`haiku (claude-haiku-4-5-20251001)`).

Both commands now take the model names `mf agent create --model` takes: an alias such as `haiku`, the id an alias stands for (saved as the alias, which the agent's settings list it by), or a name as people write it (`Haiku 4.5`). Where the settings list every model the agent can run (all but Gemini CLI and pi on a provider, whose providers may serve more), a model they do not offer is a usage error (exit 5) that lists the ones they do, before anything changes.
