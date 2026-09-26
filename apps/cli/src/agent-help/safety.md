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

- An authenticated managed runtime uses its injected identity. Do not
  replace it with a personal login. To gain a missing account capability, run
  `mf auth ensure --scopes <the missing scope>` and post the
  consent URL to the user.
- Approval is additive: existing permissions are KEPT and the new scopes
  are appended. Request only the scope you are missing — never the union
  of everything you already use.
- Request the minimum scopes the task needs; the user can revoke them in
  the web UI.
- External coding agents use the user's selected CLI profile and normal
  login flow. A profile does not restrict permissions, and an agent grant
  does not elevate a personal API token.

## Error meanings

- `401` can mean missing, expired, or rejected authentication, or a missing
  scope. Choose recovery from the structured error and verified identity.
- `403` can indicate an ownership or access-policy rejection. Check the
  requested resource and account scope before requesting any grant.
