---
'@manyfold/api': minor
---

A Manyfold API instance that shuts down, on a deploy or a restart, now lets go of the sandboxes it was holding awake. Before, each hold it left behind kept its sandbox running, and counting active hours, for up to 30 minutes after the work had ended.
