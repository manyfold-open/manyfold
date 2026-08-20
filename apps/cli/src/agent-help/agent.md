# mf agent — agent guide

## Purpose

CRUD, storage, and credential management for Manyfold agents
(alias: `mf agents`). Your own agent id is `$MF_AGENT_ID`. Model
settings are also reachable as `mf agent model-config …` but are
documented in `mf help model-config --agent`.

## Required scopes

> Required **only for `--account`** (account-wide) actions — e.g. `list`ing
> every agent, `create`, or acting on another agent. Operating your **own**
> agent (the default) needs no permission.

- `agents:read` — `list`, `get`, `storage-usage`
- `agents:edit` — `create`, `update`, `delete`
- `secrets:read` — `credentials get`, `credentials reveal`
- `secrets:edit` — `credentials update`

Missing a scope? `mf auth ensure --scopes <missing>` — see `mf help auth --agent`.

## Common commands

```sh
mf agent list
mf agent get <agent-id> --json
mf agent create <name> --framework codex --openai-api-key <key>
mf agent update <agent-id> --name <new-name> --json
mf agent delete <agent-id> --yes
mf agent storage-usage <agent-id>
mf agent credentials reveal <agent-id>
mf agent credentials update <agent-id> --body '<json-or-@file>'
```

- `create` frameworks: `claude-code` (default) | `codex` | `gemini-cli`.
  Each requires its provider key via flag or env:
  `--anthropic-auth-token` / `ANTHROPIC_AUTH_TOKEN`,
  `--openai-api-key` / `OPENAI_API_KEY`,
  `--google-api-key` / `GEMINI_API_KEY`.
- `update` needs at least one of `--name`, `--model`, `--clear-model`.
- `delete` (alias `rm`) is irreversible and refuses without `--yes`/`-y`.

## Output

- `list` / `get` / `create` / `update` print one line per agent:
  `id  name  framework/runtime  status`. All four accept `--json` (the
  array for `list`, the full record otherwise); `delete` emits `{ ok, id }`.
- `storage-usage` and `credentials get` always emit pretty-printed JSON
  (`--json` accepted but already the default).
- `credentials reveal` masks the apiKey (first 4 + last 4 chars) unless
  `--show` is passed; never paste a revealed value into chat. `--json`
  is available.

## Failure recovery

- "not authenticated" → `mf help auth --agent`
- `401` → missing scope; request just that scope (existing ones are
  kept): `mf auth ensure --scopes <missing scope>`, then retry
- `403` → the action targets a different agent than your identity; act on
  `$MF_AGENT_ID`
- `create` fails with "requires --…" → pass the provider key flag or
  set the matching env var for the chosen framework
- "nothing to update" → pass at least one update flag (see above)
- "refusing to delete … without --yes" → add `--yes` only after the
  user confirms the deletion
