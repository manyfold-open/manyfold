---
'@manyfold/api': minor
---

A sandbox's agents and the concurrent-sandboxes count now agree on whether it is running: a suspended or stopped sandbox reads as wakeable even while its daemon's last heartbeat is recent, a daemon that connects marks its sandbox running at once, and a sandbox whose daemon is heartbeating counts as running even when sprites.dev lags or misreports its status.
