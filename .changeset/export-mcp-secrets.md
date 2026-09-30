---
'@manyfold/api': minor
---

A user's export no longer carries the secrets in their agents' MCP server config. Each scope of an agent's MCP servers is stored as the framework's own config text (JSON for Claude Code and Gemini CLI, TOML for Codex), and the export's redaction only walked JSON keys, so the `env` values, `headers`, `http_headers` and tokens inside that text reached the bundle as written. The export now reads each scope in its format and withholds what can carry a secret: `env`, headers, tokens and client secrets, a server's `args` (where connection strings go), and the credentials and query of its URL. The rest of the config keeps its shape, and text that cannot be read is withheld whole.
