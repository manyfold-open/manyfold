# mf auth — agent guide

## Purpose

Use `mf whoami --json` to identify the current principal before choosing
an authentication or scope-recovery path. Credentials stay inside the CLI.

## External coding agents and user profiles

An external agent uses the user's selected CLI profile. Inspect saved
configuration with `mf profile show --json`, and keep `--profile <name>`
and any explicit API endpoint consistent on subsequent commands.

If authentication is missing, run `mf --profile <name> login`. This starts
a loopback callback server and opens the user's browser; keep the process
alive until it finishes. It works in a non-interactive shell when the
browser and CLI share a machine. When they do not, follow the current
`mf login --help` headless flow; do not ask for a long-lived token in chat.

Login currently grants `api.full`. An externally supplied narrow token may
have less access. `mf auth ensure` changes a managed agent's grants; it does
not elevate a personal API token. Browser workbench login is independent.
Do not use `mf setup` just to sign in: it also registers a local daemon.

## Managed runtime identity

For `kind: "agent-runtime"`, the platform injects `MF_API_TOKEN` and `mf`
reads it automatically. Do not run login, switch profiles, or replace the
token to bypass a scope denial. The injected `MF_AGENT_ID` identifies the
agent; capabilities are granted separately by its owner.

## Requesting a missing capability

When an authenticated managed identity reports a missing account-scope
capability, ask the user to grant just that scope:

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
**Post exactly that URL to the user** and wait for approval before retrying
the dependent action. No token is shown; the URL is the only thing you share.
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
mf whoami --json
```

## Available grant scopes

{{GRANTABLE_SCOPES}}

## Failure recovery

- Missing/expired user authentication: repeat the selected profile's login.
- Missing/rejected runtime authentication: report the runtime problem.
- A scope denial from a verified runtime identity: request only that scope
  with `mf auth ensure` and post the consent URL.
- A scope denial from a personal API token: use the user's appropriately
  authorized token/profile; do not attempt an agent grant as a substitute.
- `403`: check the structured error, target ownership, and account-scope
  intent. Do not treat every 401/403 as a missing grant.
- auth ensure endpoint 404 → the API at `MF_API_URL` is older than
  this CLI; tell the user instead of retrying
