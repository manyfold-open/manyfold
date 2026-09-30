---
'@manyfold/web': minor
---

Installing an MCP server into a Codex agent writes valid config whatever its values hold. The server's TOML block put its url, headers, command, arguments and env values between quotes as they were, so a quote or a backslash in one produced text the API refused to save, and a server name or header name that is not a bare key (one with a dot or a space) broke the table. Values are now escaped and such names quoted.
