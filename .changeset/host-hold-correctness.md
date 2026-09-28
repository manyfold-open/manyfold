---
'@manyfold/api': minor
---

Holding a sandbox awake is now checked instead of assumed. The platform's awake hold is created or renewed and then confirmed in the sandbox's task list, and a release is confirmed the same way. The hold is named as the platform's own: the sandbox's Tasks list shows it as a keep-awake lease, it cannot be deleted there, and stopping a sandbox leaves it in place so a turn in progress finishes first (the stop says so). The active-hours enforcer's stop still removes everything. Reads that must not wake a sandbox no longer wake it to take a hold, and switching keep-awake off on a sleeping sandbox no longer wakes it. Restoring a backup to a self-owned computer works for archives up to the daemon's single-write limit instead of failing above about 96 KB, and the terminal's workspace preparation runs in the workspace it names.
