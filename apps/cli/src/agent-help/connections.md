# mf connections — agent guide

## Purpose

List the external accounts linked to the calling identity: as an agent
(bound runtime token) your own linked connections, or as a user your
account's connections. Providers are GitHub, Cloudflare, and Composio.
Read-only — this lists connections, it does not create or remove them.

## Required scopes

{{CALLER_CONTEXT}}

> Required **only** when listing a **user account's** connections. An agent
> reading its **own** linked connections (the default under a runtime token)
> needs no permission.

- `connections:read` — list a user account's connections.

For a scope denial, follow `mf help auth --agent` for the current identity.

## Common commands

```sh
mf connections
mf connections --json
```

- No subcommands and no arguments — it always lists the caller's connections.
- The identity is resolved automatically: a runtime token lists the agent's
  own connections; a user token lists the account's connections.

## Output

- Agent identity: one block per connection — `<Provider> <displayName> · <account>`
  with the connection's usage note on the next line; prints
  `No connections are linked to this agent.` when empty.
- User identity: one line per connection — `<Provider> <displayName> · <externalId>`;
  prints `No connections yet.` when empty.
- `--json` emits the raw connection data instead of the formatted text.
- Output is connection metadata only (provider, display name, account label,
  usage) — no tokens or secrets.

## Failure recovery

- "not authenticated" → `mf help auth --agent`
{{AUTH_RECOVERY}}
- empty list → nothing is linked yet; link accounts from the web app
  (Settings → Connections), then re-run
