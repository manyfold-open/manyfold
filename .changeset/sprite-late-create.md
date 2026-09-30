---
'@manyfold/api': minor
---

A sandbox whose sprite sprites.dev made after the request for it timed out is no longer left running and billing with nothing pointing at it. The create request gives up after 15 s, and the rollback's delete could run before sprites.dev had finished making the sprite, so the sprite came up afterwards with no sandbox for it. After a timed-out or dropped create, the API now looks for the sprite under the sandbox's name for about half a minute and, when it appears, uses it, so the sandbox is created after all; only when it does not appear does the create fail and roll back as before.
