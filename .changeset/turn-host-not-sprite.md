---
'@manyfold/api': minor
'@manyfold/admin': minor
---

The admin chat session detail names the host that ran each turn instead of its sprite, so turns on a cloud computer are identified too. The turn record keeps the host id from the start of the turn; the sprite name and the exec session id it used to keep are gone, since nothing read the session id any more. Turns recorded before the update show only their placement.
