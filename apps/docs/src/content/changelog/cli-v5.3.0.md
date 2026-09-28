---
version: '5.3.0'
date: '2026-09-28'
---

`mf agent storage-usage` reports the workspace and config sizes of an agent
on a sandbox from the sandbox's last storage measurement, with the time it
was taken in `measuredAt`, so the sizes are there while the sandbox sleeps
instead of unknown. The agent help for `mf agent` and `mf sandbox` says
where the sizes come from.
