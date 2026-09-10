---
'@manyfold/api': major
---

Daemon WebSocket connections now require an Authorization bearer header. Query
parameters no longer authenticate a daemon. Upgrade every daemon to a CLI that
advertises `ws.auth-header` before deploying this version; older clients are
rejected with close code 4400.

Credential scrubbing remains enabled for logs, traces and error reports,
including rejected requests that still contain legacy query parameters.
