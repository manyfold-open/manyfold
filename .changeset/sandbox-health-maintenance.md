---
'@manyfold/api': minor
'@manyfold/web': minor
'@manyfold/admin': minor
---

Hosted sandboxes have a health check and a maintenance stage. When the sandbox provider's own health check reports a sandbox's machine broken, the sandbox goes into maintenance. Chat turns and A2A tasks on its agents end at once with `sandbox_maintenance`, and automation runs fail at once saying why, instead of spending minutes on wake retries. Nothing wakes the machine: requests that would take an active sandbox slot for it answer 409 `SANDBOX_MAINTENANCE`. It is checked again on a backoff — 2 minutes, 10, 30, then hourly — and returns to ready as soon as a check comes back healthy.

- Admin › Sandboxes shows each sandbox's last verdict with a Check now button (`POST /api/admin/sandboxes/:id/health-check`). A sandbox in maintenance shows how long it has been there and when it is checked next, and offers End maintenance (`POST /api/admin/sandboxes/:id/maintenance/end`). Both are audited.
- Three switches under Admin › Feature toggles, all off by default: a check after a sandbox fails to wake (`sandbox_health_checks`), automatic entry into maintenance (`sandbox_maintenance_auto`; while it is off, verdicts are only recorded), and a daily sweep of sandboxes no daemon has proven alive (`sandbox_health_sweep`). An admin's own check always applies its verdict, and automatic entries are capped per hour.
- The web shows the status wherever a sandbox's state appears, blocks the composer with the reason, and explains a refused turn.
- `runtime_hosts` gains the health-check columns (migration 0034). `SandboxSummary` gains `health` and `maintenanceSince`, and the host status and agent availability gain `maintenance`.
