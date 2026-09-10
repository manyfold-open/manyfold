---
version: "0.34.0"
date: "2026-09-10"
---

Daemon WebSocket connections now send credentials in the Authorization header,
keeping bearer tokens out of connection URLs. Existing daemon registrations,
profiles and workspaces continue to work.

For self-hosted deployments, upgrade the server to Manyfold v0.5.0 (API 1.1.0)
or newer before updating the daemon. Reverse proxies must forward the
Authorization header when upgrading WebSocket connections.
