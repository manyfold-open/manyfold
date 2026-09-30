---
'@manyfold/api': minor
---

A2A messages can carry files. A `file` part (base64 `bytes`, or a public `https` `uri`) is written into the target agent's workspace the way a chat upload is, and the turn gets it as an attachment; a message may be files alone. The agent card lists the accepted types in `defaultInputModes` for agents that take files. A file of a type chat does not take, or a file sent to an agent that takes none, is refused with `-32005` before a task is created. Before, file parts were dropped and the agent saw only the text.
