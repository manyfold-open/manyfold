---
'@manyfold/api': minor
'@manyfold/admin': minor
---

Only a machine that fails to start puts a sandbox into maintenance. On staging, every sleeping sprite answered the provider's health check with `needs_repair` ("machine in suspended state"), and a stopped one answered `repaired` after the check restarted it. Counting anything but `healthy` as a problem therefore sent idle sandboxes into a maintenance they could not leave: nothing wakes a sandbox in maintenance, and a sleeping machine never answers `healthy`.

- Now only `unhealthy` ("failed to start machine") puts a sandbox in maintenance or keeps it there.
- `healthy`, `needs_repair` and `repaired` bring a sandbox out, and an unrecognised status changes nothing.
- Admin › Sandboxes shows `needs_repair` and `repaired` in neutral.
