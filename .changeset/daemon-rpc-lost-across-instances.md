---
'@manyfold/api': patch
---

A turn no longer hangs for half an hour when its sandbox reconnects to a different API instance mid-dispatch. The instance the daemon reconnects to now hands the turn straight to the existing recovery (re-dispatch or resume on the new connection) instead of waiting for word from the instance that held the old connection, and an instance whose internal message channel goes quiet after a database failover rebuilds it within about a minute and a half.
