---
'@manyfold/api': minor
---

Browsing the web chat no longer deletes channel sessions. The chat page cleans up an empty conversation when you move on from it, and an empty conversation that a channel scope points at, for example one that `mf channels sessions new` just created, used to be deleted together with that scope's session. A non-forced delete of such a conversation is now a `409` `session_bound_to_channel`. Deleting it from the sidebar still works.
