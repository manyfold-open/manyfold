---
'@manyfold/api': minor
---

Deleting a Hermes agent whose profile Hermes no longer has now succeeds. The check for an already-deleted profile looked for wording Hermes never prints, so such an agent could not be deleted at all, and a shell's "command not found" would have counted as a successful delete.
