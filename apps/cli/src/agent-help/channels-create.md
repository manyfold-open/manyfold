# mf channels create — agent guide

## Purpose

Connect an agent to a messaging provider (`fake`, `lark`, `telegram`,
`slack`, `discord`, `matrix`). The created channel's `inboundUrl` (in
the output) is what the provider-side webhook must point at.

## Required scopes

- `channels:edit` — create, update, delete, test, or register channels.
- `channels:read` — list and inspect channels after creation.

Missing a scope? `mf auth ensure --scopes <missing>` — see `mf help auth --agent`.

## Common commands

```sh
mf channels create --provider telegram --label "<label>" \
  --config '{"mentionOnly":true,"shareSessionInChannel":false,"threadIsolation":true,"progressMode":"final"}' \
  --credentials '{"botToken":"<bot-token>"}'
mf channels create --provider lark --label "<label>" \
  --config @<config.json> --credentials @<credentials.json>
mf channels get <channelId>
mf channels test <channelId>
mf channels update <channelId> --status active
```

- `--agent-id <id>` defaults to `$MF_AGENT_ID`. `--config` is
  required, `--credentials` optional; both take inline JSON objects
  or `@path/to/file.json`.
- Credentials keys per provider: lark `appSecret`; telegram `botToken`
  (optional `webhookSecret`); slack `botToken` + `signingSecret`;
  discord `botToken`; matrix `accessToken`; fake optional `secret`.
- Config: all real providers take `mentionOnly`, `shareSessionInChannel`,
  `threadIsolation`, `progressMode` (`preview`|`final`), optional
  `resetOnIdleMins`. Lark adds `appId` + `subscriptionMode`
  (`webhook`|`websocket`); webhook mode (the default) additionally
  requires `verificationToken` and/or `encryptKey`. Discord adds
  `allowedGuildIds`; matrix adds `homeserver`, `allowedRoomIds`,
  `allowedUserIds`, `freeResponseRoomIds`, `autoJoin`, `autoThread`.

Secret values (`botToken`, `appSecret`, and Lark's
`verificationToken`/`encryptKey`, which travel via `--config`) must come
from the user. Ask for them, pass them straight into the flag (prefer
`@file`), and never echo them back in chat, files, or logs.

## Output

- stdout: the created channel as pretty-printed JSON (`--json` accepted —
  output is already JSON). The `✓ Created channel <id>` confirmation goes
  to stderr.
- Secret-bearing fields (`credentials`, `token`, `secret`, `apiKey`, and
  nested values such as Lark `verificationToken`/`encryptKey`) are masked
  as `[redacted]` at every nesting level in channel output.
- `mf channels test` prints a JSON object: `ok` (boolean) + `message`.

## Failure recovery

- "not authenticated" → `mf help auth --agent`
- `401` → missing scope; request just that scope (existing ones are
  kept): `mf auth ensure --scopes <missing scope>`, then retry
- `403` → the action targets a different agent than your identity; act on
  `$MF_AGENT_ID`
- "agent id is required" → pass `--agent-id` or set `$MF_AGENT_ID`
- `--config: invalid JSON` / `expected a JSON object` → fix the JSON;
  prefer `@file` to avoid shell-quoting damage
- `test` returns `ok: false` → fix via `mf channels update <channelId>`
  (`--config`/`--credentials`), then re-run `mf channels test`
