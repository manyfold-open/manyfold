---
'@manyfold/cli': minor
---

New `mf channels sessions get <channelId> <sessionId>` shows one channel session, archived ones included, as a table row followed by its chat session id. `--json` prints the session record. An unknown session exits `4`, like any other not-found error.
