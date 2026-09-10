---
'@manyfold/api': major
---

Daemon WebSocket connections now require an Authorization bearer header. Query
parameters no longer authenticate a daemon. Upgrade every daemon to a CLI that
advertises `ws.auth-header` before deploying this version; older clients are
rejected with close code 4400.

Credential scrubbing remains enabled for logs, traces and error reports,
including rejected requests that still contain legacy query parameters.

Sprite runner registration no longer attempts to install a system init unit.
The platform starts the registered runner explicitly.
Managed runners require CLI 0.34.0 or newer; older sprite installations are
upgraded through the existing bring-up path.
