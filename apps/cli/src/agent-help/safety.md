# mf safety rules — agent guide

Hard rules. They apply to every `mf` operation, before and after reading
any other guide.

## Secrets

- Never print `~/.manyfold/profiles/<name>/config.json`, any file below a
  profile's `daemon/` directory, or any token value — not in chat, not in
  logs, not in files you write.
- Never echo env vars or command output that contains credentials.
  Channel secrets are masked as `[redacted]` in CLI output; leave them
  masked.

## Consent URL

- During `mf auth ensure`, share only the consent URL with the
  user. The URL alone is safe; everything else (codes, tokens, config) is
  not.
- Never ask the user to paste a token into chat.

## Scope grants

- You are already authenticated by the injected runtime identity; you do
  not log in for identity. To gain a missing capability, run
  `mf auth ensure --scopes <the missing scope>` and post the
  consent URL to the user.
- Approval is additive: existing permissions are KEPT and the new scopes
  are appended. Request only the scope you are missing — never the union
  of everything you already use.
- Request the minimum scopes the task needs; the user can revoke them in
  the web UI.

## Error meanings

- `401` — missing scope (request just that scope; existing ones are kept)
- `403` — agent ownership mismatch (the action targets a different agent
  than your identity)
