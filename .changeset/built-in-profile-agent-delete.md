---
'@manyfold/api': minor
---

Deleting an agent that stands for its runtime's built-in profile (a Hermes `default` or OpenClaw `main` row on a sandbox or cloud computer) now removes the agent without asking the framework to delete that profile. The framework refused ("Cannot delete the default profile"), so neither that agent nor its runtime and sandbox could be deleted. The profile stays, because the runtime's primary agent runs as it.
