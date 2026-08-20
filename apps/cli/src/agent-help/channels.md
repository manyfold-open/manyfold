# mf channels — agent guide

## Purpose

Manage the messaging channels (Telegram, Lark, Slack, Discord, Matrix)
that connect your agent to users: list, inspect, update, test, register,
delete, and control per-scope chat sessions. For creating a channel see
`mf help channels create --agent`. To proactively send a message through
a bound channel (`mf channels send`) see `mf help channels send --agent`.

## Required scopes

> Required **only for `--account`** (account-wide) actions. Operating your
> **own** agent (the default) needs no permission.

- `channels:read` — list/get channels, view session scopes and sessions.
- `channels:edit` — create, update, delete, test, or register channels;
  mutate sessions (new/switch/rename/delete).

Missing a scope? `mf auth ensure --scopes <missing>` — see `mf help auth --agent`.

## Common commands

```sh
mf channels list --agent-id $MF_AGENT_ID --json
mf channels get <channelId>
mf channels update <channelId> --label <label> --status <draft|active|paused|error>
mf channels update <channelId> --config @<path.json> --credentials @<path.json>
mf channels test <channelId>
mf channels register <channelId>   # provider-side setup, e.g. Telegram webhook
mf channels delete <channelId>
```

Sessions — each scope (one chat/thread) has at most one active session;
`new` archives the current active one:

```sh
mf channels sessions scopes <channelId> --json
mf channels sessions list <channelId> --scope-key <key> --include-archived --json
mf channels sessions new <channelId> --scope-key <key> --name <name>
mf channels sessions switch <channelId> <sessionId>
mf channels sessions rename <channelId> <sessionId> <name>
mf channels sessions delete <channelId> <sessionId> --activate-fallback
```

## Output

- `list` prints one line per channel (`id label provider status agentId`);
  `--json` emits the JSON array. Every `sessions` subcommand accepts `--json`.
- `get`/`create`/`update` print the channel as pretty JSON and accept
  `--json`; `delete` emits `{ ok, id }`; `test` and `register` always
  print the raw JSON result (`--json` accepted, already the default).
- Secret-bearing fields (`credentials`, `apiKey`, `token`, `secret`, and
  nested values such as Lark `verificationToken`/`encryptKey`) are masked
  as `[redacted]` at every nesting level, including in `list --json`.
- `create`/`update`/`delete` confirmations (`✓ …`) go to stderr so
  stdout stays pure JSON; non-`--json` `sessions` confirmations print
  to stdout.

## Failure recovery

- "not authenticated" → `mf help auth --agent`.
- `401` → missing scope; request just that scope (existing ones are
  kept): `mf auth ensure --scopes <missing scope>`, then retry.
- `403` → the action targets a different agent than your identity; act on
  `$MF_AGENT_ID`.
- "invalid JSON" / "expected a JSON object" on `--config`/`--credentials`
  → pass an inline JSON object or `@path/to/file.json` (note the `@`).
- "pass at least one of --label, --status, --config, --credentials" →
  `update` requires at least one field.
- "agent id is required" → pass `--agent-id` or rely on `$MF_AGENT_ID`.
