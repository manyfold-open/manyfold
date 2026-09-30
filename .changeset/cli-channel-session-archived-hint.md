---
'@manyfold/cli': minor
---

`mf channels sessions switch` to a deleted session now fails and says how to start a new session in that scope (`mf channels sessions new <channelId> --scope-key <key>`). Before, it reported success and changed nothing.
