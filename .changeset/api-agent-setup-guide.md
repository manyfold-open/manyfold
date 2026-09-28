---
'@manyfold/api': minor
---

Serve `GET /api/agent-setup.md`, a public markdown runbook an AI coding agent follows to connect itself to this deployment: install `mf` (a private dev-channel copy on staging-style deployments), sign in under a profile of its own, verify, add the Claude Code or Codex plugin, and hand off with the exact command to use. Each deployment renders it from its own `PUBLIC_API_BASE_URL`, `MF_WEB_URL` and CLI channel; a request `Host` is used only when no public URL is configured, and only if it is a bare host and port.
