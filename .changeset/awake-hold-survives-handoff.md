---
'@manyfold/api': minor
---

A sandbox stays awake while a turn handed to another API instance finishes. When an instance handed a live turn on and then held the same sandbox again (the daemon reconnecting to it while it drained), letting go of that later hold deleted the handed-off turn's keep-awake task and the sandbox could go to sleep under the turn. A handed-off task now lapses only by its TTL, and later holds on that machine use their own task.
