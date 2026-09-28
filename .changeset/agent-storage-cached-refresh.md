---
'@manyfold/api': minor
'@manyfold/web': minor
'@manyfold/cli': minor
---

An agent's Storage page (titled Storage) shows its workspace and config sizes for a sandbox from the sandbox's last storage measurement, so they are there while the sandbox sleeps, with when they were measured. Refresh measures the sandbox now: admitted like any other wake, it wakes a sleeping sandbox and updates the paths and the sandbox filesystem size together, even within minutes of the last measurement. An agent on a sandbox shows that filesystem size as Storage in its Overview's Details. `POST /agents/:id/storage-usage/refresh` (`agents:edit`) is the new measuring call, `POST /agents/:id/storage-usage` never execs for a sandbox, and its report carries `measuredAt`; `mf agent storage-usage` reports a sleeping sandbox's cached paths instead of unknowns.
