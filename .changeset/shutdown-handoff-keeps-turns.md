---
'@manyfold/api': minor
---

A deploy no longer kills the chat turns it hands off. When the shutdown drain ran out of time, the API handed each live turn off for the next instance to adopt, but that turn's own lease renewal, refused by the handoff, read as losing the turn to someone else: the turn was aborted, its sandbox process killed, and the stop recorded as the user's cancel. A refused renewal now ends the renewal only, and a turn is aborted only when its execution row has really moved to another owner, so the next instance adopts the turn and finishes it.
