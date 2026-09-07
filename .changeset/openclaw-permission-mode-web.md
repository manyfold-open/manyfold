---
'@manyfold/web': minor
---

Show the permission-mode selector for openclaw agents in the chat composer, with the two openclaw modes (`Ask for approval` / `Don't ask`, default `Don't ask`), and wire the interactive approval card so an openclaw agent's `session/request_permission` can be answered from the chat. Mirrors the hermes controls: the mode persists per agent in local storage and rides each message; `Ask for approval` turns exec approval on for the ACP turn. Strings added across all 11 locale catalogs. Behind `MF_OPENCLAW_ACP`.
