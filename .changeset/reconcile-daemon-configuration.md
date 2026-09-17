---
'@manyfold/api': patch
'@manyfold/cli': patch
'@manyfold/shared': patch
'@manyfold/db': patch
'@manyfold/docs': patch
---

Automatically retry saved MCP and platform context configuration when a supported daemon reconnects. Serialize manual, on-change and reconnect delivery per computer, keep failed or superseded snapshots stale, and protect configuration files against delayed writes from retired connections or expired delivery attempts. Older daemons keep explicit push support and require a CLI update for automatic delivery.
