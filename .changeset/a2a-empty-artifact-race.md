---
'@manyfold/api': patch
---

A2A tasks no longer complete with an empty result. When a turn finished at the moment the task's background check looked at it, the task could be closed with the reply missing, and the caller received an empty answer while the chat itself showed the full reply.
