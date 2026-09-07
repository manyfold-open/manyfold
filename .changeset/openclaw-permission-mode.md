---
'@manyfold/api': minor
---

Add an openclaw permission mode (`default` / `dontAsk`, default `dontAsk`) to the chat API. `dontAsk` is exactly today's behaviour — the gateway ships `tools.exec.ask` off, so a turn that sends no mode sets nothing and never prompts. `default` turns exec approval on for the ACP turn: the adapter pre-patches the session's `execAsk` over the loopback gateway (`openclaw gateway call sessions.patch`, verified to upsert the deterministic session key and apply from the first turn), sets the ACP client to interactive, and registers with the shared permission coordinator, so `session/request_permission` relays to the chat as an interactive card answerable through the existing endpoint. Wired through the create-message DTO, ChatService, and the adapter; the openclaw ACP path is still behind `MF_OPENCLAW_ACP`.
