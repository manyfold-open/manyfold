---
'@manyfold/api': minor
'@manyfold/web': minor
'@manyfold/admin': minor
'@manyfold/cli': minor
---

The open-source build now ships only the core frameworks: Claude Code, Codex, Gemini CLI, Pi, OpenClaw, Hermes, Dify, Langflow and A2A. Any other framework is added by an edition through the framework registry, together with its API module, its web and admin presentation, and any sign-in hand-off it brings. An agent whose framework the running build does not register fails with `framework_unavailable`. The landing page, the create flows, the admin's runtime hint and the CLI's usage help describe the core set.
