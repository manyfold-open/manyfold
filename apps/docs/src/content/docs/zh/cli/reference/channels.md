---
title: "mf channels"
description: "Manage agent channels (Telegram, Lark, Slack, etc.)"
order: 8
---
**用法:** `mf channels [command]`

**Option**

| Option | 用途 |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommand**

| 命令 | 用途 |
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

**用法:** `mf channels list [options]`

**Alias:** `ls`

**Option**

| Option | 用途 |
| --- | --- |
| `--agent-id <id>` | filter to channels owned by this agent (client-side filter) |
| `--json` | emit raw JSON array |
| `-h, --help` | display help for command |

## `mf channels create`

Create a channel

**用法:** `mf channels create [options]`

**Option**

| Option | 用途 |
| --- | --- |
| `--agent-id <id>` | agent id (defaults to $MF_AGENT_ID or --agent-id global) |
| `--provider <name>` | channel provider (fake\|lark\|telegram\|slack\|discord\|matrix) 必填。 |
| `--label <label>` | channel label (1-200 chars) 必填。 |
| `--config <json>` | channel config (@path for file, or inline JSON object) 必填。 |
| `--credentials <json>` | channel credentials (@path for file, or inline JSON object) |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

## `mf channels get`

Show a single channel

**用法:** `mf channels get [options] <channelId>`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<channelId>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

## `mf channels update`

Patch a channel

**用法:** `mf channels update [options] <channelId>`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<channelId>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--label <label>` | rename channel (1-200 chars) |
| `--status <status>` | set channel status (draft\|active\|paused\|error) |
| `--config <json>` | new channel config (@path or inline JSON) |
| `--credentials <json>` | new channel credentials (@path or inline JSON) |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

## `mf channels delete`

Delete a channel

**用法:** `mf channels delete [options] <channelId>`

**Alias:** `rm`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<channelId>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

## `mf channels test`

Run a connectivity test for a channel

**用法:** `mf channels test [options] <channelId>`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<channelId>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--json` | emit raw JSON (default) |
| `-h, --help` | display help for command |

## `mf channels register`

Run provider-side registration (e.g. webhook setup) for a channel

**用法:** `mf channels register [options] <channelId>`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<channelId>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--json` | emit raw JSON (default) |
| `-h, --help` | display help for command |

## `mf channels send`

Send a message through a channel as its bound agent (chat, DM, or native reply)

**用法:** `mf channels send [options] <channelId>`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<channelId>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--chat-id <chatId>` | target a chat/group by provider chat id |
| `--user-id <userId>` | DM a provider user id (e.g. Lark open_id) |
| `--reply-to <messageId>` | reply natively to a provider message id |
| `--text <text>` | message text |
| `--file <path>` | attach a workspace file (repeatable, max 4) 默认值: ``. |
| `--json` | emit raw JSON (default) |
| `-h, --help` | display help for command |

## `mf channels sessions`

Manage channel sessions (per scope, switch active)

**用法:** `mf channels sessions [command]`

**Option**

| Option | 用途 |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommand**

| 命令 | 用途 |
| --- | --- |
| [`mf channels sessions scopes`](#mf-channels-sessions-scopes) | List scopes in a channel with their active session |
| [`mf channels sessions list`](#mf-channels-sessions-list) | List channel sessions (optionally filtered by scope) |
| [`mf channels sessions new`](#mf-channels-sessions-new) | Create a new active session in a scope (archives the current active) |
| [`mf channels sessions switch`](#mf-channels-sessions-switch) | Make a session active (its scope swaps active to this session) |
| [`mf channels sessions rename`](#mf-channels-sessions-rename) | Rename a session (sets display_name) |
| [`mf channels sessions delete`](#mf-channels-sessions-delete) | Archive a session; with --activate-fallback, auto-activate newest remaining |

### `mf channels sessions scopes`

List scopes in a channel with their active session

**用法:** `mf channels sessions scopes [options] <channelId>`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<channelId>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

### `mf channels sessions list`

List channel sessions (optionally filtered by scope)

**用法:** `mf channels sessions list [options] <channelId>`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<channelId>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--scope-key <key>` | filter by scopeKey |
| `--include-archived` | include archived sessions |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

### `mf channels sessions new`

Create a new active session in a scope (archives the current active)

**用法:** `mf channels sessions new [options] <channelId>`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<channelId>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--scope-key <key>` | target scope key 必填。 |
| `--name <name>` | display name for the new session |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

### `mf channels sessions switch`

Make a session active (its scope swaps active to this session)

**用法:** `mf channels sessions switch [options] <channelId> <sessionId>`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<channelId>` |  |
| `<sessionId>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

### `mf channels sessions rename`

Rename a session (sets display_name)

**用法:** `mf channels sessions rename [options] <channelId> <sessionId> <name>`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<channelId>` |  |
| `<sessionId>` |  |
| `<name>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

### `mf channels sessions delete`

Archive a session; with --activate-fallback, auto-activate newest remaining

**用法:** `mf channels sessions delete [options] <channelId> <sessionId>`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<channelId>` |  |
| `<sessionId>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--activate-fallback` | if deleting the active session, auto-activate the newest remaining |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |
