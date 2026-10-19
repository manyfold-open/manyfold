---
'@manyfold/api': patch
---

Deleting a sandbox whose creation timed out now also deletes its sprite. sprites.dev can finish creating a sprite after the request has given up, and that sprite was left behind, still billed, with nothing in Manyfold pointing at it.
