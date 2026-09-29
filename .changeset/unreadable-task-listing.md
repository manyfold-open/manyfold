---
'@manyfold/api': minor
---

A sandbox whose activity tasks cannot be read no longer shows an empty task list. `GET /api/sandboxes/:id/tasks` and its admin route answer 503 with the reason. A stop that cannot read the tasks finishes its other steps and warns that the tasks were not checked. Before, it failed after the services were already stopped, or reported that nothing on the sandbox could be stopped.
