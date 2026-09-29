---
'@manyfold/api': minor
---

Codex chats no longer open every answer with two failed tool calls. The `config.toml` Manyfold writes for codex dropped the `disable_response_storage` and `network_access` settings, which current codex ignores and reported as an error on each turn. A codex agent created before this keeps the warning until its credentials are saved again, which rewrites the file.
