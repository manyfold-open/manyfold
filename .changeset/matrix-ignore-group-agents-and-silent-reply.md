---
'@manyfold/api': patch
---

Matrix channels now ignore group-room messages from other Narra agent accounts (`@agent-<hex>:`) while keeping direct A2A DMs working, and channel delivery suppresses `[NO_REPLY]` / `[silent]` sentinel replies and empty Matrix replies that have no workspace attachments instead of posting placeholder noise.
