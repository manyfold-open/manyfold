---
'@manyfold/api': major
'@manyfold/cli': major
'@manyfold/web': major
'@manyfold/admin': major
---

Close retired runtime and configuration compatibility windows. Daemon registration,
heartbeats and WebSocket connections require CLI 0.34.0 or newer. Coding daemon
prompts use stdin transport; turn RPCs use split budgets; update channels use stable/dev.
Missing credential facts no longer establish readiness, and daemon MCP writes
always use restrictive file permissions.

Lark message ingress accepts only the current receive_v1 event contract. Retired
API environment aliases fail startup, Web/Admin stop reading old build aliases,
and startup no longer adopts A2A timeout or self-host plan settings. Upgrade older
self-hosted installations through API 4.0.0 and migrate configuration first.

Normal runtime provisioning, upgrades, skill activation and keep-alive operations
no longer perform the completed identity, shared-shell, home-clone or fused-task
migrations. Existing persisted workspace and lease state paths remain valid.
Every service wake gets an independent report generation; changing a keep-alive
lease preserves the current service's report fence and files.
