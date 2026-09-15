---
'@manyfold/api': patch
---

Allow interrupted backup and restore cleanup to finish when only exited, unreaped processes remain in a runtime container. Continue blocking retry while any member of the operation's process group is still alive or its state cannot be determined, and retain the operation timeout when descendants outlive their group leader.
