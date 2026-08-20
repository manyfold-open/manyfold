# mf auth — agent guide

## Purpose

This runtime is already authenticated: the platform injects your agent
identity token (`MF_API_TOKEN`), and `mf` reads it automatically. You do
**not** log in for identity. You never see or handle the token value
yourself. What you do manage is _capabilities_ — the scopes your identity
is allowed to use.

## Requesting a missing capability

When a command fails because your identity lacks a scope, ask the user to
grant just that scope:

```sh
mf auth ensure --scopes channels:read,channels:edit
```

- `--scopes` is required: comma-separated grant scopes. Request **only the
  scope you are missing**, not the union of everything you use.
- `--for-agent` defaults to `$MF_AGENT_ID`.
- Approval **APPENDS** to your permissions: existing permissions are KEPT,
  the new scopes are added. There is no need to re-request scopes you
  already hold.

The CLI prints a consent URL for the current Manyfold environment, for
example `https://manyfold.ai/grant-permission?token=…` in production or
`http://localhost:3002/grant-permission?token=…` in local development.
**Post exactly that URL to the user**, ask them to click approve, and end
your turn. No token is ever shown; the URL is the only thing you share.
`--json` emits `{ agentId, consentUrl, scopes }` for scripted callers.

`mf auth ensure` mints no token — once the user approves, the next
`mf` command sees the added scope automatically, because the platform
re-reads your permissions live on every call. Just retry the command that
failed.

Configuration lives in
`~/.manyfold/profiles/<name>/config.json`. **Never print this file, any
file below the profile's daemon directory, or any token value.**

## Checking identity

```sh
mf whoami
```

## Available grant scopes

{{GRANTABLE_SCOPES}}

## Failure recovery

- "not authenticated" → the runtime should already hold `MF_API_TOKEN`;
  if it is genuinely missing, tell the user rather than retrying
- `401` → missing scope: request only the missing scope with
  `mf auth ensure --scopes <missing scope>` and post the consent URL
- `403` → the action targets a different agent than your identity; act on
  `$MF_AGENT_ID` (drop or correct any `--agent-id`)
- auth ensure endpoint 404 → the API at `MF_API_URL` is older than
  this CLI; tell the user instead of retrying
