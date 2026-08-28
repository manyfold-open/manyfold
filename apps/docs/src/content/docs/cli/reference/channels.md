---
title: "mf channels"
description: "Manage agent channels (Telegram, Lark, Slack, etc.)"
order: 8
---
**Usage:** `mf channels [command]`

**Options**

| Options | Purpose |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommands**

| Command | Purpose |
| --- | --- |
| [`mf channels list`](#mf-channels-list) | List channels (optionally filter by agent) |
| [`mf channels create`](#mf-channels-create) | Create a channel |
| [`mf channels get`](#mf-channels-get) | Show a single channel |
| [`mf channels update`](#mf-channels-update) | Patch a channel |
| [`mf channels delete`](#mf-channels-delete) | Delete a channel |
| [`mf channels test`](#mf-channels-test) | Run a connectivity test for a channel |
| [`mf channels register`](#mf-channels-register) | Run provider-side registration (e.g. webhook setup) for a channel |
| [`mf channels send`](#mf-channels-send) | Send a message through a channel as its bound agent (chat, DM, or native reply) |
| [`mf channels sessions`](#mf-channels-sessions) | Manage channel sessions (per scope, switch active) |

## `mf channels list`

List channels (optionally filter by agent)

**Usage:** `mf channels list [options]`

**Aliases:** `ls`

**Options**

| Options | Purpose |
| --- | --- |
| `--agent-id <id>` | filter to channels owned by this agent (client-side filter) |
| `--json` | emit raw JSON array |
| `-h, --help` | display help for command |

## `mf channels create`

Create a channel

**Usage:** `mf channels create [options]`

**Options**

| Options | Purpose |
| --- | --- |
| `--agent-id <id>` | agent id (defaults to $MF_AGENT_ID or --agent-id global) |
| `--provider <name>` | channel provider (fake\|lark\|telegram\|slack\|discord\|matrix\|weixin\|whatsapp\|linear\|github\|line) Required. |
| `--label <label>` | channel label (1-200 chars) Required. |
| `--config <json>` | channel config (@path for file, or inline JSON object) Required. |
| `--credentials <json>` | channel credentials (@path for file, or inline JSON object) |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

## `mf channels get`

Show a single channel

**Usage:** `mf channels get [options] <channelId>`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<channelId>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

## `mf channels update`

Patch a channel

**Usage:** `mf channels update [options] <channelId>`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<channelId>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--label <label>` | rename channel (1-200 chars) |
| `--status <status>` | set channel status (draft\|active\|paused\|error) |
| `--config <json>` | new channel config (@path or inline JSON) |
| `--credentials <json>` | new channel credentials (@path or inline JSON) |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

## `mf channels delete`

Delete a channel

**Usage:** `mf channels delete [options] <channelId>`

**Aliases:** `rm`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<channelId>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

## `mf channels test`

Run a connectivity test for a channel

**Usage:** `mf channels test [options] <channelId>`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<channelId>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--json` | emit raw JSON (default) |
| `-h, --help` | display help for command |

## `mf channels register`

Run provider-side registration (e.g. webhook setup) for a channel

**Usage:** `mf channels register [options] <channelId>`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<channelId>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--json` | emit raw JSON (default) |
| `-h, --help` | display help for command |

## `mf channels send`

Send a message through a channel as its bound agent (chat, DM, or native reply)

**Usage:** `mf channels send [options] <channelId>`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<channelId>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--chat-id <chatId>` | target a chat/group by provider chat id |
| `--user-id <userId>` | DM a provider user id (e.g. Lark open_id) |
| `--reply-to <messageId>` | reply natively to a provider message id |
| `--text <text>` | message text |
| `--file <path>` | attach a workspace file (repeatable, max 4) Default: ``. |
| `--json` | emit raw JSON (default) |
| `-h, --help` | display help for command |

## `mf channels sessions`

Manage channel sessions (per scope, switch active)

**Usage:** `mf channels sessions [command]`

**Options**

| Options | Purpose |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommands**

| Command | Purpose |
| --- | --- |
| [`mf channels sessions scopes`](#mf-channels-sessions-scopes) | List scopes in a channel with their active session |
| [`mf channels sessions list`](#mf-channels-sessions-list) | List channel sessions (optionally filtered by scope) |
| [`mf channels sessions new`](#mf-channels-sessions-new) | Create a new active session in a scope (archives the current active) |
| [`mf channels sessions switch`](#mf-channels-sessions-switch) | Make a session active (its scope swaps active to this session) |
| [`mf channels sessions rename`](#mf-channels-sessions-rename) | Rename a session (sets display_name) |
| [`mf channels sessions delete`](#mf-channels-sessions-delete) | Archive a session; with --activate-fallback, auto-activate newest remaining |

### `mf channels sessions scopes`

List scopes in a channel with their active session

**Usage:** `mf channels sessions scopes [options] <channelId>`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<channelId>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

### `mf channels sessions list`

List channel sessions (optionally filtered by scope)

**Usage:** `mf channels sessions list [options] <channelId>`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<channelId>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--scope-key <key>` | filter by scopeKey |
| `--include-archived` | include archived sessions |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

### `mf channels sessions new`

Create a new active session in a scope (archives the current active)

**Usage:** `mf channels sessions new [options] <channelId>`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<channelId>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--scope-key <key>` | target scope key Required. |
| `--name <name>` | display name for the new session |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

### `mf channels sessions switch`

Make a session active (its scope swaps active to this session)

**Usage:** `mf channels sessions switch [options] <channelId> <sessionId>`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<channelId>` |  |
| `<sessionId>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

### `mf channels sessions rename`

Rename a session (sets display_name)

**Usage:** `mf channels sessions rename [options] <channelId> <sessionId> <name>`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<channelId>` |  |
| `<sessionId>` |  |
| `<name>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

### `mf channels sessions delete`

Archive a session; with --activate-fallback, auto-activate newest remaining

**Usage:** `mf channels sessions delete [options] <channelId> <sessionId>`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<channelId>` |  |
| `<sessionId>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--activate-fallback` | if deleting the active session, auto-activate the newest remaining |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |
