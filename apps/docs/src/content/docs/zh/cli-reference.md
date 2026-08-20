---
title: CLI 命令参考
description: 搜索完整的 mf command tree、argument 和 option。
order: 12
---

# CLI 命令参考

本页由 mf binary 使用的同一份 Commander tree 生成，记录当前公开 command surface；command 和 option description 保留 binary 中的英文原文以避免漂移。已安装 binary 的自身版本始终是最终依据。

**生成自:** `mf 0.23.1`

运行 `mf <command> --help`，确认当前机器已安装版本的准确语法。

## Global option

**用法:** `mf [options] [command]`

**Option**

| Option | 用途 |
| --- | --- |
| `-V, --version` | output the version number |
| `--profile <name>` | CLI profile: separate credentials and daemon state per environment (env: MF_PROFILE) |
| `--api-url <url>` | API base URL |
| `--token <token>` | API token override ("-" reads stdin; direct values may appear in shell history and process lists) |
| `--agent-id <id>` | agent context: default agent for agent-scoped commands, accepted before or after the subcommand (env: MF_AGENT_ID) |
| `--account` | act at account scope: operate across the current account instead of only the current agent (default). Requires user-granted permission; without it the command stays scoped to the current agent. |
| `-h, --help` | display help for command |

<a id="mf-auth"></a>
## `mf auth`

Authenticate and manage capabilities for the current identity

**用法:** `mf auth [command]`

**Option**

| Option | 用途 |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommand**

| 命令 | 用途 |
| --- | --- |
| [`mf auth ensure`](#mf-auth-ensure) | Ensure the current identity has the requested capabilities |

<a id="mf-auth-ensure"></a>
### `mf auth ensure`

Ensure the current identity has the requested capabilities

**用法:** `mf auth ensure [options]`

**Option**

| Option | 用途 |
| --- | --- |
| `--scopes <list>` | comma-separated grant scopes to ensure (e.g. channels:read,channels:edit) |
| `--for-agent <id>` | agent to ensure scopes for (defaults to --agent-id / $MF_AGENT_ID) |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

<a id="mf-setup"></a>
## `mf setup`

One-command onboarding: sign in, register this machine as a daemon, start it

**用法:** `mf setup [options]`

**Option**

| Option | 用途 |
| --- | --- |
| `--api-url <url>` | API base URL |
| `--token <token>` | sign in with an existing user token instead of the browser ("-" reads stdin) |
| `--name <name>` | machine name shown in the dashboard (default: hostname) |
| `--system` | install the daemon at system scope (boot-time; needs root/sudo; default as root) |
| `--user` | install the daemon at user scope (per-login; default as non-root) |
| `--no-launch-browser` | print the auth URL and prompt for the auth code instead of launching a browser (use over SSH) |
| `-h, --help` | display help for command |

<a id="mf-login"></a>
## `mf login`

Authenticate this machine with Manyfold

**用法:** `mf login [options]`

**Option**

| Option | 用途 |
| --- | --- |
| `--api-url <url>` | API base URL |
| `--token <token>` | API token ("-" reads stdin; direct values may appear in shell history and process lists) |
| `--no-launch-browser` | print the auth URL instead of launching a browser |
| `--auth-code <code>` | auth code copied from the browser |
| `--poll` | use the legacy device-code grant flow (requires --scopes) |
| `--wait` | with --poll, wait for approval before exiting |
| `--resume` | complete a pending poll-mode login whose process exited before approval |
| `--scopes <list>` | legacy --poll grant scopes (e.g. channels:read,channels:edit) |
| `--for-agent <id>` | legacy --poll grant target (defaults to --agent-id / $MF_AGENT_ID) |
| `--limit-to-agent` | request that the user limit the token to a single agent (sets the consent-page toggle default) |
| `--json` | output the result as JSON (token is never echoed) |
| `-h, --help` | display help for command |

<a id="mf-whoami"></a>
## `mf whoami`

Print the currently authenticated user

**用法:** `mf whoami [options]`

**Option**

| Option | 用途 |
| --- | --- |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

<a id="mf-agent"></a>
## `mf agent`

Manage agents

**用法:** `mf agent [command]`

**Alias:** `agents`

**Option**

| Option | 用途 |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommand**

| 命令 | 用途 |
| --- | --- |
| [`mf agent list`](#mf-agent-list) | List agents owned by the current user |
| [`mf agent get`](#mf-agent-get) | Show a single agent |
| [`mf agent create`](#mf-agent-create) | Create a new agent on sprites.dev |
| [`mf agent update`](#mf-agent-update) | Update agent name or model |
| [`mf agent delete`](#mf-agent-delete) | Delete an agent (irreversible) |
| [`mf agent storage-usage`](#mf-agent-storage-usage) | Report storage usage for an agent |
| [`mf agent model-config`](#mf-agent-model-config) | Manage agent model config |
| [`mf agent credentials`](#mf-agent-credentials) | Manage agent credentials (provider keys, etc.) |

<a id="mf-agent-list"></a>
### `mf agent list`

List agents owned by the current user

**用法:** `mf agent list [options]`

**Alias:** `ls`

**Option**

| Option | 用途 |
| --- | --- |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

<a id="mf-agent-get"></a>
### `mf agent get`

Show a single agent

**用法:** `mf agent get [options] <agentId>`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<agentId>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

<a id="mf-agent-create"></a>
### `mf agent create`

Create a new agent on sprites.dev

**用法:** `mf agent create [options] <name>`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<name>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--framework <framework>` | claude-code \| codex \| gemini-cli 默认值: `claude-code`. |
| `--anthropic-auth-token <token>` | Anthropic auth token (claude-code only; or env ANTHROPIC_AUTH_TOKEN) |
| `--anthropic-base-url <url>` | Anthropic base URL override (claude-code only) |
| `--openai-api-key <key>` | OpenAI API key (codex only; or env OPENAI_API_KEY) |
| `--openai-base-url <url>` | OpenAI base URL override (codex only) |
| `--google-api-key <key>` | Gemini API key (gemini-cli only; or env GEMINI_API_KEY / GOOGLE_API_KEY) |
| `--google-gemini-base-url <url>` | Gemini base URL override (gemini-cli only; or env GOOGLE_GEMINI_BASE_URL) |
| `--gemini-model <model>` | Gemini model override (gemini-cli only) |
| `--account-id <id>` | Admin only: pin to a specific sprites.dev account id |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

<a id="mf-agent-update"></a>
### `mf agent update`

Update agent name or model

**用法:** `mf agent update [options] <agentId>`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<agentId>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--name <name>` | rename the agent |
| `--model <model>` | set model id |
| `--clear-model` | clear the model override |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

<a id="mf-agent-delete"></a>
### `mf agent delete`

Delete an agent (irreversible)

**用法:** `mf agent delete [options] <agentId>`

**Alias:** `rm`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<agentId>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `-y, --yes` | confirm irreversible deletion |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

<a id="mf-agent-storage-usage"></a>
### `mf agent storage-usage`

Report storage usage for an agent

**用法:** `mf agent storage-usage [options] <agentId>`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<agentId>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--json` | emit raw JSON (default) |
| `-h, --help` | display help for command |

<a id="mf-agent-model-config"></a>
### `mf agent model-config`

Manage agent model config

**用法:** `mf agent model-config [command]`

**Option**

| Option | 用途 |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommand**

| 命令 | 用途 |
| --- | --- |
| [`mf agent model-config get`](#mf-agent-model-config-get) | Get the agent model config view |
| [`mf agent model-config update`](#mf-agent-model-config-update) | Update agent model config |
| [`mf agent model-config refresh-models`](#mf-agent-model-config-refresh-models) | Refresh the provider model list for an agent |

<a id="mf-agent-model-config-get"></a>
#### `mf agent model-config get`

Get the agent model config view

**用法:** `mf agent model-config get [options] <agentId>`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<agentId>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--json` | emit raw JSON (default) |
| `-h, --help` | display help for command |

<a id="mf-agent-model-config-update"></a>
#### `mf agent model-config update`

Update agent model config

**用法:** `mf agent model-config update [options] <agentId>`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<agentId>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--source <source>` | modelConfigSource value (platform\|runtime-local) |
| `--model <model>` | set model id |
| `--clear-model` | clear model |
| `--config <json>` | modelConfig JSON object (or @file) |
| `--clear-config` | clear modelConfig override |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

<a id="mf-agent-model-config-refresh-models"></a>
#### `mf agent model-config refresh-models`

Refresh the provider model list for an agent

**用法:** `mf agent model-config refresh-models [options] <agentId>`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<agentId>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--source <source>` | modelConfigSource value to refresh (optional) |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

<a id="mf-agent-credentials"></a>
### `mf agent credentials`

Manage agent credentials (provider keys, etc.)

**用法:** `mf agent credentials [command]`

**Option**

| Option | 用途 |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommand**

| 命令 | 用途 |
| --- | --- |
| [`mf agent credentials get`](#mf-agent-credentials-get) | Show credential metadata (not secrets) |
| [`mf agent credentials reveal`](#mf-agent-credentials-reveal) | Reveal credentials. Output is masked unless --show is passed. |
| [`mf agent credentials update`](#mf-agent-credentials-update) | Update agent credentials |

<a id="mf-agent-credentials-get"></a>
#### `mf agent credentials get`

Show credential metadata (not secrets)

**用法:** `mf agent credentials get [options] <agentId>`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<agentId>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--json` | emit raw JSON (default) |
| `-h, --help` | display help for command |

<a id="mf-agent-credentials-reveal"></a>
#### `mf agent credentials reveal`

Reveal credentials. Output is masked unless --show is passed.

**用法:** `mf agent credentials reveal [options] <agentId>`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<agentId>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--json` | emit raw JSON |
| `--show` | print the secret in plaintext |
| `-h, --help` | display help for command |

<a id="mf-agent-credentials-update"></a>
#### `mf agent credentials update`

Update agent credentials

**用法:** `mf agent credentials update [options] <agentId>`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<agentId>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--body <json>` | request body JSON (or @file). Shape: UpdateAgentCredentialsBody 必填。 |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

<a id="mf-automations"></a>
## `mf automations`

Manage scheduled automations

**用法:** `mf automations [command]`

**Option**

| Option | 用途 |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommand**

| 命令 | 用途 |
| --- | --- |
| [`mf automations list`](#mf-automations-list) | List automations (optionally filter by agent) |
| [`mf automations get`](#mf-automations-get) | Show a single automation (with recent runs) |
| [`mf automations create`](#mf-automations-create) | Create a new automation |
| [`mf automations update`](#mf-automations-update) | Update an existing automation |
| [`mf automations run`](#mf-automations-run) | Trigger an automation run now |
| [`mf automations delete`](#mf-automations-delete) | Delete an automation |

<a id="mf-automations-list"></a>
### `mf automations list`

List automations (optionally filter by agent)

**用法:** `mf automations list [options]`

**Alias:** `ls`

**Option**

| Option | 用途 |
| --- | --- |
| `--agent-id <id>` | filter to this agent |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

<a id="mf-automations-get"></a>
### `mf automations get`

Show a single automation (with recent runs)

**用法:** `mf automations get [options] <id>`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<id>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--json` | emit raw JSON (default) |
| `-h, --help` | display help for command |

<a id="mf-automations-create"></a>
### `mf automations create`

Create a new automation

**用法:** `mf automations create [options]`

**Option**

| Option | 用途 |
| --- | --- |
| `--agent-id <id>` | agent id to run as (defaults to $MF_AGENT_ID) |
| `--title <title>` | short title 必填。 |
| `--prompt <prompt>` | prompt body 必填。 |
| `--schedule-preset <preset>` | hourly \| daily \| weekdays \| weekly \| custom 必填。 |
| `--rrule <rrule>` | RRULE string (iCalendar) 必填。 |
| `--timezone <tz>` | IANA timezone (e.g. UTC) 必填。 |
| `--dtstart <iso>` | first run start (ISO8601) |
| `--model <model>` | model override |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

<a id="mf-automations-update"></a>
### `mf automations update`

Update an existing automation

**用法:** `mf automations update [options] <id>`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<id>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--title <title>` | new title |
| `--prompt <prompt>` | new prompt |
| `--status <status>` | active \| paused |
| `--schedule-preset <preset>` | hourly \| daily \| weekdays \| weekly \| custom |
| `--rrule <rrule>` | new RRULE |
| `--timezone <tz>` | new IANA timezone |
| `--dtstart <iso>` | new dtstart |
| `--model <model>` | new model override |
| `--clear-model` | clear model override |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

<a id="mf-automations-run"></a>
### `mf automations run`

Trigger an automation run now

**用法:** `mf automations run [options] <id>`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<id>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

<a id="mf-automations-delete"></a>
### `mf automations delete`

Delete an automation

**用法:** `mf automations delete [options] <id>`

**Alias:** `rm`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<id>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `-y, --yes` | confirm deletion |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

<a id="mf-backups"></a>
## `mf backups`

Manage agent backups and restores

**用法:** `mf backups [command]`

**Option**

| Option | 用途 |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommand**

| 命令 | 用途 |
| --- | --- |
| [`mf backups list`](#mf-backups-list) | List backups (optionally filter by agent) |
| [`mf backups create`](#mf-backups-create) | Snapshot an agent into a new backup |
| [`mf backups delete`](#mf-backups-delete) | Delete a backup (irreversible) |
| [`mf backups restore`](#mf-backups-restore) | Restore an agent from a backup (replaces current state) |
| [`mf backups get-restore`](#mf-backups-get-restore) | Show status of a restore operation |

<a id="mf-backups-list"></a>
### `mf backups list`

List backups (optionally filter by agent)

**用法:** `mf backups list [options]`

**Alias:** `ls`

**Option**

| Option | 用途 |
| --- | --- |
| `--agent-id <id>` | filter to this agent |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

<a id="mf-backups-create"></a>
### `mf backups create`

Snapshot an agent into a new backup

**用法:** `mf backups create [options] <agentId>`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<agentId>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--json` | emit raw JSON (default) |
| `-h, --help` | display help for command |

<a id="mf-backups-delete"></a>
### `mf backups delete`

Delete a backup (irreversible)

**用法:** `mf backups delete [options] <backupId>`

**Alias:** `rm`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<backupId>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `-y, --yes` | confirm irreversible deletion |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

<a id="mf-backups-restore"></a>
### `mf backups restore`

Restore an agent from a backup (replaces current state)

**用法:** `mf backups restore [options] <agentId>`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<agentId>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--backup-id <id>` | backup id to restore from 必填。 |
| `-y, --yes` | confirm replacement of current state |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

<a id="mf-backups-get-restore"></a>
### `mf backups get-restore`

Show status of a restore operation

**用法:** `mf backups get-restore [options] <restoreId>`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<restoreId>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--json` | emit raw JSON (default) |
| `-h, --help` | display help for command |

<a id="mf-channels"></a>
## `mf channels`

Manage agent channels (Telegram, Lark, Slack, etc.)

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

<a id="mf-channels-list"></a>
### `mf channels list`

List channels (optionally filter by agent)

**用法:** `mf channels list [options]`

**Alias:** `ls`

**Option**

| Option | 用途 |
| --- | --- |
| `--agent-id <id>` | filter to channels owned by this agent (client-side filter) |
| `--json` | emit raw JSON array |
| `-h, --help` | display help for command |

<a id="mf-channels-create"></a>
### `mf channels create`

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

<a id="mf-channels-get"></a>
### `mf channels get`

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

<a id="mf-channels-update"></a>
### `mf channels update`

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

<a id="mf-channels-delete"></a>
### `mf channels delete`

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

<a id="mf-channels-test"></a>
### `mf channels test`

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

<a id="mf-channels-register"></a>
### `mf channels register`

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

<a id="mf-channels-send"></a>
### `mf channels send`

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

<a id="mf-channels-sessions"></a>
### `mf channels sessions`

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

<a id="mf-channels-sessions-scopes"></a>
#### `mf channels sessions scopes`

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

<a id="mf-channels-sessions-list"></a>
#### `mf channels sessions list`

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

<a id="mf-channels-sessions-new"></a>
#### `mf channels sessions new`

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

<a id="mf-channels-sessions-switch"></a>
#### `mf channels sessions switch`

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

<a id="mf-channels-sessions-rename"></a>
#### `mf channels sessions rename`

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

<a id="mf-channels-sessions-delete"></a>
#### `mf channels sessions delete`

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

<a id="mf-files"></a>
## `mf files`

Read/write files on an agent runtime

**用法:** `mf files [command]`

**Option**

| Option | 用途 |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommand**

| 命令 | 用途 |
| --- | --- |
| [`mf files roots`](#mf-files-roots) | List available file roots for an agent |
| [`mf files list`](#mf-files-list) | List directory entries on an agent |
| [`mf files stat`](#mf-files-stat) | Show file metadata |
| [`mf files read`](#mf-files-read) | Read file contents (to stdout or --output) |
| [`mf files write`](#mf-files-write) | Write file contents from --content or --file |
| [`mf files upload`](#mf-files-upload) | Upload a local file to an agent (remotePath defaults to the file name) |
| [`mf files download`](#mf-files-download) | Download a file from an agent (localPath defaults to the file name, - for stdout) |
| [`mf files mkdir`](#mf-files-mkdir) | Create a directory on an agent |
| [`mf files mv`](#mf-files-mv) | Move or rename a path on an agent |
| [`mf files rm`](#mf-files-rm) | Remove a file or directory on an agent |

<a id="mf-files-roots"></a>
### `mf files roots`

List available file roots for an agent

**用法:** `mf files roots [options] [agentId]`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `[agentId]` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

<a id="mf-files-list"></a>
### `mf files list`

List directory entries on an agent

**用法:** `mf files list [options] [agentIdOrPath] [path]`

**Alias:** `ls`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `[agentIdOrPath]` |  |
| `[path]` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--root <rootId>` | root id (default: workspace) |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

<a id="mf-files-stat"></a>
### `mf files stat`

Show file metadata

**用法:** `mf files stat [options] [agentIdOrPath] [path]`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `[agentIdOrPath]` |  |
| `[path]` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--root <rootId>` | root id |
| `--json` | emit raw JSON (default) |
| `-h, --help` | display help for command |

<a id="mf-files-read"></a>
### `mf files read`

Read file contents (to stdout or --output)

**用法:** `mf files read [options] [agentIdOrPath] [path]`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `[agentIdOrPath]` |  |
| `[path]` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--root <rootId>` | root id |
| `--output <localPath>` | write to this local file instead of stdout |
| `-h, --help` | display help for command |

<a id="mf-files-write"></a>
### `mf files write`

Write file contents from --content or --file

**用法:** `mf files write [options] [agentIdOrPath] [path]`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `[agentIdOrPath]` |  |
| `[path]` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--content <data>` | inline content (string) |
| `--file <localPath>` | read content from a local file |
| `--root <rootId>` | root id |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

<a id="mf-files-upload"></a>
### `mf files upload`

Upload a local file to an agent (remotePath defaults to the file name)

**用法:** `mf files upload [options] <localPath> [remotePath]`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<localPath>` |  |
| `[remotePath]` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--root <rootId>` | root id (default: workspace) |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

<a id="mf-files-download"></a>
### `mf files download`

Download a file from an agent (localPath defaults to the file name, - for stdout)

**用法:** `mf files download [options] <remotePath> [localPath]`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<remotePath>` |  |
| `[localPath]` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--root <rootId>` | root id (default: workspace) |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

<a id="mf-files-mkdir"></a>
### `mf files mkdir`

Create a directory on an agent

**用法:** `mf files mkdir [options] [agentIdOrPath] [path]`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `[agentIdOrPath]` |  |
| `[path]` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--root <rootId>` | root id |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

<a id="mf-files-mv"></a>
### `mf files mv`

Move or rename a path on an agent

**用法:** `mf files mv [options] [agentIdOrFrom] [from] [to]`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `[agentIdOrFrom]` |  |
| `[from]` |  |
| `[to]` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--root <rootId>` | root id |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

<a id="mf-files-rm"></a>
### `mf files rm`

Remove a file or directory on an agent

**用法:** `mf files rm [options] [agentIdOrPath] [path]`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `[agentIdOrPath]` |  |
| `[path]` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--root <rootId>` | root id |
| `--recursive` | remove directories recursively |
| `-y, --yes` | confirm irreversible deletion |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

<a id="mf-connections"></a>
## `mf connections`

List the connections linked to this agent (or, for a user, your account)

**用法:** `mf connections [options]`

**Option**

| Option | 用途 |
| --- | --- |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

<a id="mf-model-config"></a>
## `mf model-config`

Read/update agent model configuration

**用法:** `mf model-config [command]`

**Option**

| Option | 用途 |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommand**

| 命令 | 用途 |
| --- | --- |
| [`mf model-config get`](#mf-model-config-get) | Get the agent model config view |
| [`mf model-config update`](#mf-model-config-update) | Update agent model config |
| [`mf model-config refresh-models`](#mf-model-config-refresh-models) | Refresh the provider model list for an agent |

<a id="mf-model-config-get"></a>
### `mf model-config get`

Get the agent model config view

**用法:** `mf model-config get [options] <agentId>`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<agentId>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--json` | emit raw JSON (default) |
| `-h, --help` | display help for command |

<a id="mf-model-config-update"></a>
### `mf model-config update`

Update agent model config

**用法:** `mf model-config update [options] <agentId>`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<agentId>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--source <source>` | modelConfigSource value (platform\|runtime-local) |
| `--model <model>` | set model id |
| `--clear-model` | clear model |
| `--config <json>` | modelConfig JSON object (or @file) |
| `--clear-config` | clear modelConfig override |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

<a id="mf-model-config-refresh-models"></a>
### `mf model-config refresh-models`

Refresh the provider model list for an agent

**用法:** `mf model-config refresh-models [options] <agentId>`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<agentId>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--source <source>` | modelConfigSource value to refresh (optional) |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

<a id="mf-runtime"></a>
## `mf runtime`

Manage agent runtimes (the sprite/pod shell)

**用法:** `mf runtime [command]`

**Alias:** `agent-runtimes`

**Option**

| Option | 用途 |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommand**

| 命令 | 用途 |
| --- | --- |
| [`mf runtime list`](#mf-runtime-list) | List your agent runtimes |
| [`mf runtime get`](#mf-runtime-get) | Show detail for an agent runtime |
| [`mf runtime delete`](#mf-runtime-delete) | Delete an agent runtime (tears down sprite/pod and cascades to agents) |
| [`mf runtime control-ui`](#mf-runtime-control-ui) | Manage the runtime control UI sidecar |
| [`mf runtime dashboard`](#mf-runtime-dashboard) | Manage the runtime dashboard (Hermes only) |
| [`mf runtime agents`](#mf-runtime-agents) | Manage framework agents hosted on a runtime |

<a id="mf-runtime-list"></a>
### `mf runtime list`

List your agent runtimes

**用法:** `mf runtime list [options]`

**Alias:** `ls`

**Option**

| Option | 用途 |
| --- | --- |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

<a id="mf-runtime-get"></a>
### `mf runtime get`

Show detail for an agent runtime

**用法:** `mf runtime get [options] <id>`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<id>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

<a id="mf-runtime-delete"></a>
### `mf runtime delete`

Delete an agent runtime (tears down sprite/pod and cascades to agents)

**用法:** `mf runtime delete [options] <id>`

**Alias:** `rm`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<id>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

<a id="mf-runtime-control-ui"></a>
### `mf runtime control-ui`

Manage the runtime control UI sidecar

**用法:** `mf runtime control-ui [command]`

**Option**

| Option | 用途 |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommand**

| 命令 | 用途 |
| --- | --- |
| [`mf runtime control-ui get-url`](#mf-runtime-control-ui-get-url) | Get the control UI URL for a runtime |
| [`mf runtime control-ui enable`](#mf-runtime-control-ui-enable) | Enable the control UI sidecar |
| [`mf runtime control-ui disable`](#mf-runtime-control-ui-disable) | Disable the control UI sidecar |

<a id="mf-runtime-control-ui-get-url"></a>
#### `mf runtime control-ui get-url`

Get the control UI URL for a runtime

**用法:** `mf runtime control-ui get-url [options] <runtimeId>`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<runtimeId>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

<a id="mf-runtime-control-ui-enable"></a>
#### `mf runtime control-ui enable`

Enable the control UI sidecar

**用法:** `mf runtime control-ui enable [options] <runtimeId>`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<runtimeId>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

<a id="mf-runtime-control-ui-disable"></a>
#### `mf runtime control-ui disable`

Disable the control UI sidecar

**用法:** `mf runtime control-ui disable [options] <runtimeId>`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<runtimeId>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

<a id="mf-runtime-dashboard"></a>
### `mf runtime dashboard`

Manage the runtime dashboard (Hermes only)

**用法:** `mf runtime dashboard [command]`

**Option**

| Option | 用途 |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommand**

| 命令 | 用途 |
| --- | --- |
| [`mf runtime dashboard enable`](#mf-runtime-dashboard-enable) | Enable the Hermes dashboard |
| [`mf runtime dashboard disable`](#mf-runtime-dashboard-disable) | Disable the Hermes dashboard |

<a id="mf-runtime-dashboard-enable"></a>
#### `mf runtime dashboard enable`

Enable the Hermes dashboard

**用法:** `mf runtime dashboard enable [options] <runtimeId>`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<runtimeId>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

<a id="mf-runtime-dashboard-disable"></a>
#### `mf runtime dashboard disable`

Disable the Hermes dashboard

**用法:** `mf runtime dashboard disable [options] <runtimeId>`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<runtimeId>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

<a id="mf-runtime-agents"></a>
### `mf runtime agents`

Manage framework agents hosted on a runtime

**用法:** `mf runtime agents [command]`

**Option**

| Option | 用途 |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommand**

| 命令 | 用途 |
| --- | --- |
| [`mf runtime agents add`](#mf-runtime-agents-add) | Add a framework agent to an existing runtime |
| [`mf runtime agents list`](#mf-runtime-agents-list) | List framework agents on a runtime |
| [`mf runtime agents remove`](#mf-runtime-agents-remove) | Remove a framework agent (by agent id) |

<a id="mf-runtime-agents-add"></a>
#### `mf runtime agents add`

Add a framework agent to an existing runtime

**用法:** `mf runtime agents add [options] <runtimeId>`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<runtimeId>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--name <name>` | agent display name 必填。 |
| `--workspace <path>` | workspace path (coding agents only) |
| `--model <model>` | model override |
| `--clone-from <agentId>` | clone state from another agent |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

<a id="mf-runtime-agents-list"></a>
#### `mf runtime agents list`

List framework agents on a runtime

**用法:** `mf runtime agents list [options] <runtimeId>`

**Alias:** `ls`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<runtimeId>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

<a id="mf-runtime-agents-remove"></a>
#### `mf runtime agents remove`

Remove a framework agent (by agent id)

**用法:** `mf runtime agents remove [options] <agentId>`

**Alias:** `rm`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<agentId>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `-y, --yes` | confirm removal |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

<a id="mf-skills"></a>
## `mf skills`

Manage installed agent skills

**用法:** `mf skills [command]`

**Option**

| Option | 用途 |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommand**

| 命令 | 用途 |
| --- | --- |
| [`mf skills installed`](#mf-skills-installed) | List installed skills (optionally filter by agent) |
| [`mf skills discover`](#mf-skills-discover) | Discover skills available to install |
| [`mf skills install`](#mf-skills-install) | Install a skill on one agent (or many via --agent-ids) |
| [`mf skills update`](#mf-skills-update) | Enable or disable an installed skill |
| [`mf skills delete`](#mf-skills-delete) | Uninstall a skill |
| [`mf skills library`](#mf-skills-library) | Manage your personal skill library |
| [`mf skills repos`](#mf-skills-repos) | Manage skill repositories (admin / api.full) |

<a id="mf-skills-installed"></a>
### `mf skills installed`

List installed skills (optionally filter by agent)

**用法:** `mf skills installed [options]`

**Option**

| Option | 用途 |
| --- | --- |
| `--agent-id <id>` | filter to this agent |
| `--include-runtime` | include runtime-level skills |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

<a id="mf-skills-discover"></a>
### `mf skills discover`

Discover skills available to install

**用法:** `mf skills discover [options]`

**Option**

| Option | 用途 |
| --- | --- |
| `--agent-id <id>` | filter to this agent context |
| `--q <query>` | search query |
| `--repo-id <id>` | filter to a specific repo |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

<a id="mf-skills-install"></a>
### `mf skills install`

Install a skill on one agent (or many via --agent-ids)

**用法:** `mf skills install [options]`

**Option**

| Option | 用途 |
| --- | --- |
| `--skill-id <id>` | skill id from discover or library 必填。 |
| `--agent-id <id>` | agent id (defaults to the global --agent-id / $MF_AGENT_ID) |
| `--agent-ids <ids>` | comma-separated agent ids for a batch install |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

<a id="mf-skills-update"></a>
### `mf skills update`

Enable or disable an installed skill

**用法:** `mf skills update [options] <userSkillId>`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<userSkillId>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--enabled` | enable the skill |
| `--disabled` | disable the skill |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

<a id="mf-skills-delete"></a>
### `mf skills delete`

Uninstall a skill

**用法:** `mf skills delete [options] <userSkillId>`

**Alias:** `rm`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<userSkillId>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `-y, --yes` | confirm uninstall |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

<a id="mf-skills-library"></a>
### `mf skills library`

Manage your personal skill library

**用法:** `mf skills library [command]`

**Option**

| Option | 用途 |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommand**

| 命令 | 用途 |
| --- | --- |
| [`mf skills library list`](#mf-skills-library-list) | List library skills |
| [`mf skills library get`](#mf-skills-library-get) | Show a library skill (metadata + SKILL.md) |
| [`mf skills library create`](#mf-skills-library-create) | Create a library skill |
| [`mf skills library update`](#mf-skills-library-update) | Update a library skill (name / description / SKILL.md) |
| [`mf skills library import`](#mf-skills-library-import) | Import a skill from a GitHub URL, catalog entry, share link, or .skill/.zip archive |
| [`mf skills library share`](#mf-skills-library-share) | Create or show the share link for a library skill (id or name) |
| [`mf skills library export`](#mf-skills-library-export) | Download a library skill as a .skill archive |
| [`mf skills library delete`](#mf-skills-library-delete) | Delete a library skill |
| [`mf skills library push`](#mf-skills-library-push) | Push the current skill content to installed agents (all by default) |
| [`mf skills library files`](#mf-skills-library-files) | Manage a library skill’s supporting files |

<a id="mf-skills-library-list"></a>
#### `mf skills library list`

List library skills

**用法:** `mf skills library list [options]`

**Alias:** `ls`

**Option**

| Option | 用途 |
| --- | --- |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

<a id="mf-skills-library-get"></a>
#### `mf skills library get`

Show a library skill (metadata + SKILL.md)

**用法:** `mf skills library get [options] <skillId>`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<skillId>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

<a id="mf-skills-library-create"></a>
#### `mf skills library create`

Create a library skill

**用法:** `mf skills library create [options]`

**Option**

| Option | 用途 |
| --- | --- |
| `--name <name>` | skill name 必填。 |
| `--description <text>` | skill description |
| `--content <markdown>` | SKILL.md content inline |
| `--content-file <path>` | read SKILL.md content from a file |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

<a id="mf-skills-library-update"></a>
#### `mf skills library update`

Update a library skill (name / description / SKILL.md)

**用法:** `mf skills library update [options] <skillId>`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<skillId>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--name <name>` | new skill name |
| `--description <text>` | new description |
| `--content <markdown>` | new SKILL.md content inline |
| `--content-file <path>` | read new SKILL.md from a file |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

<a id="mf-skills-library-import"></a>
#### `mf skills library import`

Import a skill from a GitHub URL, catalog entry, share link, or .skill/.zip archive

**用法:** `mf skills library import [options]`

**Option**

| Option | 用途 |
| --- | --- |
| `--url <url>` | github.com repo / tree / SKILL.md blob URL |
| `--file <path>` | local .skill or .zip archive |
| `--catalog-skill-id <id>` | copy a catalog skill to the library |
| `--share <url-or-id>` | copy a shared skill via its link or lss_… id |
| `--on-conflict <mode>` | fail \| overwrite \| rename |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

<a id="mf-skills-library-share"></a>
#### `mf skills library share`

Create or show the share link for a library skill (id or name)

**用法:** `mf skills library share [options] <skill>`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<skill>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--revoke` | revoke the active share link |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

<a id="mf-skills-library-export"></a>
#### `mf skills library export`

Download a library skill as a .skill archive

**用法:** `mf skills library export [options] <skillId>`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<skillId>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `-o, --output <path>` | output file path |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

<a id="mf-skills-library-delete"></a>
#### `mf skills library delete`

Delete a library skill

**用法:** `mf skills library delete [options] <skillId>`

**Alias:** `rm`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<skillId>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `-y, --yes` | confirm deletion |
| `--force` | uninstall from all agents before deleting |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

<a id="mf-skills-library-push"></a>
#### `mf skills library push`

Push the current skill content to installed agents (all by default)

**用法:** `mf skills library push [options] <skillId>`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<skillId>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--agent-ids <ids>` | comma-separated agent ids to push to |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

<a id="mf-skills-library-files"></a>
#### `mf skills library files`

Manage a library skill’s supporting files

**用法:** `mf skills library files [command]`

**Option**

| Option | 用途 |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommand**

| 命令 | 用途 |
| --- | --- |
| [`mf skills library files set`](#mf-skills-library-files-set) | Create or update a supporting file |
| [`mf skills library files delete`](#mf-skills-library-files-delete) | Delete a supporting file |

<a id="mf-skills-library-files-set"></a>
##### `mf skills library files set`

Create or update a supporting file

**用法:** `mf skills library files set [options] <skillId>`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<skillId>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--path <path>` | file path inside the skill 必填。 |
| `--content <text>` | file content inline |
| `--content-file <path>` | read file content from a local file |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

<a id="mf-skills-library-files-delete"></a>
##### `mf skills library files delete`

Delete a supporting file

**用法:** `mf skills library files delete [options] <skillId> <fileId>`

**Alias:** `rm`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<skillId>` |  |
| `<fileId>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

<a id="mf-skills-repos"></a>
### `mf skills repos`

Manage skill repositories (admin / api.full)

**用法:** `mf skills repos [command]`

**Option**

| Option | 用途 |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommand**

| 命令 | 用途 |
| --- | --- |
| [`mf skills repos list`](#mf-skills-repos-list) | List skill repos |
| [`mf skills repos create`](#mf-skills-repos-create) | Register a new skill repo |
| [`mf skills repos update`](#mf-skills-repos-update) | Update a skill repo (branch / enabled) |
| [`mf skills repos delete`](#mf-skills-repos-delete) | Remove a skill repo |

<a id="mf-skills-repos-list"></a>
#### `mf skills repos list`

List skill repos

**用法:** `mf skills repos list [options]`

**Alias:** `ls`

**Option**

| Option | 用途 |
| --- | --- |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

<a id="mf-skills-repos-create"></a>
#### `mf skills repos create`

Register a new skill repo

**用法:** `mf skills repos create [options]`

**Option**

| Option | 用途 |
| --- | --- |
| `--owner <owner>` | github owner 必填。 |
| `--name <name>` | repo name 必填。 |
| `--branch <branch>` | branch (default: main) |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

<a id="mf-skills-repos-update"></a>
#### `mf skills repos update`

Update a skill repo (branch / enabled)

**用法:** `mf skills repos update [options] <repoId>`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<repoId>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--branch <branch>` | new branch |
| `--enabled` | enable the repo |
| `--disabled` | disable the repo |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

<a id="mf-skills-repos-delete"></a>
#### `mf skills repos delete`

Remove a skill repo

**用法:** `mf skills repos delete [options] <repoId>`

**Alias:** `rm`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<repoId>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `-y, --yes` | confirm deletion |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

<a id="mf-usage"></a>
## `mf usage`

Read token + cost usage statistics

**用法:** `mf usage [command]`

**Option**

| Option | 用途 |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommand**

| 命令 | 用途 |
| --- | --- |
| [`mf usage summary`](#mf-usage-summary) | Aggregate usage in a window |
| [`mf usage timeseries`](#mf-usage-timeseries) | Bucketed usage time series |
| [`mf usage events`](#mf-usage-events) | Paginated usage events |
| [`mf usage sessions`](#mf-usage-sessions) | Per-session usage summaries |
| [`mf usage top-agents`](#mf-usage-top-agents) | Rank agents by usage (cross-agent — denied for bound tokens) |

<a id="mf-usage-summary"></a>
### `mf usage summary`

Aggregate usage in a window

**用法:** `mf usage summary [options]`

**Option**

| Option | 用途 |
| --- | --- |
| `--from <iso>` | inclusive start (ISO8601) |
| `--to <iso>` | exclusive end (ISO8601) |
| `--framework <name>` | filter by framework |
| `--runtime-id <id>` | filter by runtime |
| `--agent-id <id>` | filter by agent |
| `--session-id <id>` | filter by chat session |
| `--json` | emit raw JSON (default) |
| `-h, --help` | display help for command |

<a id="mf-usage-timeseries"></a>
### `mf usage timeseries`

Bucketed usage time series

**用法:** `mf usage timeseries [options]`

**Option**

| Option | 用途 |
| --- | --- |
| `--from <iso>` | inclusive start (ISO8601) |
| `--to <iso>` | exclusive end (ISO8601) |
| `--framework <name>` | filter by framework |
| `--runtime-id <id>` | filter by runtime |
| `--agent-id <id>` | filter by agent |
| `--session-id <id>` | filter by chat session |
| `--json` | emit raw JSON (default) |
| `--bucket <bucket>` | hour \| day (default: day) |
| `-h, --help` | display help for command |

<a id="mf-usage-events"></a>
### `mf usage events`

Paginated usage events

**用法:** `mf usage events [options]`

**Option**

| Option | 用途 |
| --- | --- |
| `--from <iso>` | inclusive start (ISO8601) |
| `--to <iso>` | exclusive end (ISO8601) |
| `--framework <name>` | filter by framework |
| `--runtime-id <id>` | filter by runtime |
| `--agent-id <id>` | filter by agent |
| `--session-id <id>` | filter by chat session |
| `--json` | emit raw JSON (default) |
| `--cursor <cursor>` | opaque cursor from previous page |
| `--limit <n>` | page size (1-200, default 50) |
| `-h, --help` | display help for command |

<a id="mf-usage-sessions"></a>
### `mf usage sessions`

Per-session usage summaries

**用法:** `mf usage sessions [options]`

**Option**

| Option | 用途 |
| --- | --- |
| `--from <iso>` | inclusive start (ISO8601) |
| `--to <iso>` | exclusive end (ISO8601) |
| `--framework <name>` | filter by framework |
| `--runtime-id <id>` | filter by runtime |
| `--agent-id <id>` | filter by agent |
| `--session-id <id>` | filter by chat session |
| `--json` | emit raw JSON (default) |
| `-h, --help` | display help for command |

<a id="mf-usage-top-agents"></a>
### `mf usage top-agents`

Rank agents by usage (cross-agent — denied for bound tokens)

**用法:** `mf usage top-agents [options]`

**Option**

| Option | 用途 |
| --- | --- |
| `--from <iso>` | inclusive start |
| `--to <iso>` | exclusive end |
| `--limit <n>` | top N (default 10) |
| `--json` | emit raw JSON (default) |
| `-h, --help` | display help for command |

<a id="mf-a2a"></a>
## `mf a2a`

Talk to A2A servers and manage this agent exposure and callers

**用法:** `mf a2a [command]`

**Option**

| Option | 用途 |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommand**

| 命令 | 用途 |
| --- | --- |
| [`mf a2a exposure`](#mf-a2a-exposure) | Manage this agent's hosted A2A exposure |
| [`mf a2a callers`](#mf-a2a-callers) | Manage callers authorized to invoke this agent |
| [`mf a2a card`](#mf-a2a-card) | Fetch and print an Agent Card |
| [`mf a2a status`](#mf-a2a-status) | Show callable peers and in-flight outbound calls |
| [`mf a2a send`](#mf-a2a-send) | Send a message to a granted peer (name/id from `mf a2a status`) or a raw A2A url |
| [`mf a2a tasks`](#mf-a2a-tasks) | Track A2A tasks |

<a id="mf-a2a-exposure"></a>
### `mf a2a exposure`

Manage this agent's hosted A2A exposure

**用法:** `mf a2a exposure [command]`

**Option**

| Option | 用途 |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommand**

| 命令 | 用途 |
| --- | --- |
| [`mf a2a exposure get`](#mf-a2a-exposure-get) | Show hosted A2A exposure and public endpoints |
| [`mf a2a exposure enable`](#mf-a2a-exposure-enable) | Expose this agent as an A2A server |
| [`mf a2a exposure disable`](#mf-a2a-exposure-disable) | Stop exposing this agent as an A2A server |

<a id="mf-a2a-exposure-get"></a>
#### `mf a2a exposure get`

Show hosted A2A exposure and public endpoints

**用法:** `mf a2a exposure get [options]`

**Option**

| Option | 用途 |
| --- | --- |
| `--json` | emit JSON |
| `-h, --help` | display help for command |

<a id="mf-a2a-exposure-enable"></a>
#### `mf a2a exposure enable`

Expose this agent as an A2A server

**用法:** `mf a2a exposure enable [options]`

**Option**

| Option | 用途 |
| --- | --- |
| `--json` | emit JSON |
| `-h, --help` | display help for command |

<a id="mf-a2a-exposure-disable"></a>
#### `mf a2a exposure disable`

Stop exposing this agent as an A2A server

**用法:** `mf a2a exposure disable [options]`

**Option**

| Option | 用途 |
| --- | --- |
| `--json` | emit JSON |
| `-h, --help` | display help for command |

<a id="mf-a2a-callers"></a>
### `mf a2a callers`

Manage callers authorized to invoke this agent

**用法:** `mf a2a callers [command]`

**Option**

| Option | 用途 |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommand**

| 命令 | 用途 |
| --- | --- |
| [`mf a2a callers list`](#mf-a2a-callers-list) | List peer and external callers |
| [`mf a2a callers add`](#mf-a2a-callers-add) | Add an external client or peer agent caller |
| [`mf a2a callers revoke`](#mf-a2a-callers-revoke) | Revoke an A2A caller grant |

<a id="mf-a2a-callers-list"></a>
#### `mf a2a callers list`

List peer and external callers

**用法:** `mf a2a callers list [options]`

**Option**

| Option | 用途 |
| --- | --- |
| `--json` | emit JSON |
| `-h, --help` | display help for command |

<a id="mf-a2a-callers-add"></a>
#### `mf a2a callers add`

Add an external client or peer agent caller

**用法:** `mf a2a callers add [options]`

**Option**

| Option | 用途 |
| --- | --- |
| `--external` | create an External client bearer |
| `--caller-agent-id <id>` | authorize a Manyfold peer agent |
| `--name <name>` | External client label |
| `--expires-in-days <days>` | positive integer; omit for no expiry |
| `--replace-existing` | replace an existing grant for the peer agent |
| `--json` | emit JSON (includes a new External client token) |
| `-h, --help` | display help for command |

<a id="mf-a2a-callers-revoke"></a>
#### `mf a2a callers revoke`

Revoke an A2A caller grant

**用法:** `mf a2a callers revoke [options] <tokenId>`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<tokenId>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `-y, --yes` | confirm revocation |
| `--json` | emit JSON |
| `-h, --help` | display help for command |

<a id="mf-a2a-card"></a>
### `mf a2a card`

Fetch and print an Agent Card

**用法:** `mf a2a card [options] <url>`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<url>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--bearer <token>` | bearer token for a raw url target ("-" reads stdin; falls back to $MF_A2A_BEARER) |
| `--json` | emit raw A2A JSON instead of a human summary |
| `--allow-http-localhost` | allow http:// and localhost/private targets (local dev only) |
| `-h, --help` | display help for command |

<a id="mf-a2a-status"></a>
### `mf a2a status`

Show callable peers and in-flight outbound calls

**用法:** `mf a2a status [options]`

**Option**

| Option | 用途 |
| --- | --- |
| `--json` | emit JSON |
| `-h, --help` | display help for command |

<a id="mf-a2a-send"></a>
### `mf a2a send`

Send a message to a granted peer (name/id from `mf a2a status`) or a raw A2A url

**用法:** `mf a2a send [options] <target> <prompt>`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<target>` |  |
| `<prompt>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--bearer <token>` | bearer token for a raw url target ("-" reads stdin; falls back to $MF_A2A_BEARER) |
| `--json` | emit raw A2A JSON instead of a human summary |
| `--allow-http-localhost` | allow http:// and localhost/private targets (local dev only) |
| `--context-id <id>` | reuse an A2A context (conversation) |
| `--task-id <id>` | continue an existing task |
| `--skill <id>` | select a remote skill by id |
| `--input-file <path>` | attach a file as an A2A file part |
| `--stream` | stream status + artifact chunks (SSE) |
| `--async` | submit and return a task id immediately (poll with `mf a2a tasks get`) |
| `--timeout <seconds>` | client deadline in seconds (0 disables; default 900) |
| `-h, --help` | display help for command |

<a id="mf-a2a-tasks"></a>
### `mf a2a tasks`

Track A2A tasks

**用法:** `mf a2a tasks [command]`

**Option**

| Option | 用途 |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommand**

| 命令 | 用途 |
| --- | --- |
| [`mf a2a tasks list`](#mf-a2a-tasks-list) | List this agent's outbound A2A calls |
| [`mf a2a tasks get`](#mf-a2a-tasks-get) | Fetch a task by id (target = peer name/id or url) |
| [`mf a2a tasks cancel`](#mf-a2a-tasks-cancel) | Cancel a task by id |
| [`mf a2a tasks subscribe`](#mf-a2a-tasks-subscribe) | Resubscribe to a task SSE stream (reconnect) |

<a id="mf-a2a-tasks-list"></a>
#### `mf a2a tasks list`

List this agent's outbound A2A calls

**用法:** `mf a2a tasks list [options]`

**Option**

| Option | 用途 |
| --- | --- |
| `--state <state>` | filter by state (e.g. working) |
| `--peer <agentId>` | filter by peer (target agent id) |
| `--json` | emit JSON |
| `-h, --help` | display help for command |

<a id="mf-a2a-tasks-get"></a>
#### `mf a2a tasks get`

Fetch a task by id (target = peer name/id or url)

**用法:** `mf a2a tasks get [options] <target> <taskId>`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<target>` |  |
| `<taskId>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--wait` | poll until the task reaches a terminal state |
| `--timeout <seconds>` | deadline for --wait (0 disables; default 900) |
| `--bearer <token>` | bearer token for a raw url target ("-" reads stdin; falls back to $MF_A2A_BEARER) |
| `--json` | emit raw A2A JSON instead of a human summary |
| `--allow-http-localhost` | allow http:// and localhost/private targets (local dev only) |
| `-h, --help` | display help for command |

<a id="mf-a2a-tasks-cancel"></a>
#### `mf a2a tasks cancel`

Cancel a task by id

**用法:** `mf a2a tasks cancel [options] <target> <taskId>`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<target>` |  |
| `<taskId>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--bearer <token>` | bearer token for a raw url target ("-" reads stdin; falls back to $MF_A2A_BEARER) |
| `--json` | emit raw A2A JSON instead of a human summary |
| `--allow-http-localhost` | allow http:// and localhost/private targets (local dev only) |
| `-h, --help` | display help for command |

<a id="mf-a2a-tasks-subscribe"></a>
#### `mf a2a tasks subscribe`

Resubscribe to a task SSE stream (reconnect)

**用法:** `mf a2a tasks subscribe [options] <target> <taskId>`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<target>` |  |
| `<taskId>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--bearer <token>` | bearer token for a raw url target ("-" reads stdin; falls back to $MF_A2A_BEARER) |
| `--json` | emit raw A2A JSON instead of a human summary |
| `--allow-http-localhost` | allow http:// and localhost/private targets (local dev only) |
| `-h, --help` | display help for command |

<a id="mf-daemon"></a>
## `mf daemon`

Local daemon for Manyfold agents (claude-code / codex / gemini-cli)

**用法:** `mf daemon [command]`

**Option**

| Option | 用途 |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommand**

| 命令 | 用途 |
| --- | --- |
| [`mf daemon register`](#mf-daemon-register) | Register this machine as a Manyfold local daemon |
| [`mf daemon start`](#mf-daemon-start) | Start the Manyfold daemon (installs init unit so it auto-starts on login) |
| [`mf daemon status`](#mf-daemon-status) | Show local daemon status |
| [`mf daemon stop`](#mf-daemon-stop) | Stop the Manyfold daemon and remove its autostart unit |
| [`mf daemon logs`](#mf-daemon-logs) | Tail the daemon log |
| [`mf daemon doctor`](#mf-daemon-doctor) | Probe local frameworks and daemon terminal support |

<a id="mf-daemon-register"></a>
### `mf daemon register`

Register this machine as a Manyfold local daemon

**用法:** `mf daemon register [options]`

**Option**

| Option | 用途 |
| --- | --- |
| `--token <token>` | PAT issued from the web UI ("-" reads stdin; direct values may appear in shell history and process lists) |
| `--name <name>` | human-readable machine name |
| `--workspace-root <path>` | workspace base dir this daemon manages (default: the shared ~/.manyfold/workspaces) |
| `--skills-dir <path>` | skill store dir this daemon manages (default: the shared ~/.manyfold/skills) |
| `-y, --yes` | skip confirmation and start the daemon after registering |
| `-h, --help` | display help for command |

<a id="mf-daemon-start"></a>
### `mf daemon start`

Start the Manyfold daemon (installs init unit so it auto-starts on login)

**用法:** `mf daemon start [options]`

**Option**

| Option | 用途 |
| --- | --- |
| `--foreground` | run inline without touching the init unit (debug / used by the unit itself) |
| `--system` | install at system scope (boot-time; needs root/sudo; default as root) |
| `--user` | install at user scope (per-login; default as non-root) |
| `-h, --help` | display help for command |

<a id="mf-daemon-status"></a>
### `mf daemon status`

Show local daemon status

**用法:** `mf daemon status [options]`

**Option**

| Option | 用途 |
| --- | --- |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

<a id="mf-daemon-stop"></a>
### `mf daemon stop`

Stop the Manyfold daemon and remove its autostart unit

**用法:** `mf daemon stop [options]`

**Option**

| Option | 用途 |
| --- | --- |
| `--system` | target system scope (boot-time unit; needs root/sudo; default as root) |
| `--user` | target user scope (per-login unit; default as non-root) |
| `-h, --help` | display help for command |

<a id="mf-daemon-logs"></a>
### `mf daemon logs`

Tail the daemon log

**用法:** `mf daemon logs [options]`

**Option**

| Option | 用途 |
| --- | --- |
| `-f, --follow` | follow log output |
| `-n, --lines <count>` | number of lines to show 默认值: `50`. |
| `-h, --help` | display help for command |

<a id="mf-daemon-doctor"></a>
### `mf daemon doctor`

Probe local frameworks and daemon terminal support

**用法:** `mf daemon doctor [options]`

**Option**

| Option | 用途 |
| --- | --- |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

<a id="mf-profile"></a>
## `mf profile`

Inspect and manage CLI profiles (ADR-0014)

**用法:** `mf profile [command]`

**Option**

| Option | 用途 |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommand**

| 命令 | 用途 |
| --- | --- |
| [`mf profile show`](#mf-profile-show) | Show a profile: source, paths, login and daemon state |
| [`mf profile list`](#mf-profile-list) | List profiles on this machine |
| [`mf profile delete`](#mf-profile-delete) | Delete a profile: credentials, pending login, daemon state and init units. Agent data lives in the machine-shared ~/.manyfold/workspaces and is never touched. |

<a id="mf-profile-show"></a>
### `mf profile show`

Show a profile: source, paths, login and daemon state

**用法:** `mf profile show [options] [name]`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `[name]` | profile to inspect (default: the current one) |

**Option**

| Option | 用途 |
| --- | --- |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

<a id="mf-profile-list"></a>
### `mf profile list`

List profiles on this machine

**用法:** `mf profile list [options]`

**Option**

| Option | 用途 |
| --- | --- |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

<a id="mf-profile-delete"></a>
### `mf profile delete`

Delete a profile: credentials, pending login, daemon state and init units. Agent data lives in the machine-shared ~/.manyfold/workspaces and is never touched.

**用法:** `mf profile delete [options] <name>`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<name>` | profile to delete |

**Option**

| Option | 用途 |
| --- | --- |
| `--force` | allow deleting the default profile |
| `-y, --yes` | skip the confirmation prompt |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

<a id="mf-update"></a>
## `mf update`

Update the mf CLI to the latest version

**用法:** `mf update [options]`

**Option**

| Option | 用途 |
| --- | --- |
| `--to <version>` | install a specific version (e.g. 0.1.0) |
| `--channel <channel>` | update channel: dev or stable (remembers your choice) |
| `--force` | reinstall even when already on the target version |
| `--check` | show available update without installing |
| `--yes` | skip the confirmation prompt |
| `-h, --help` | display help for command |

<a id="mf-help"></a>
## `mf help`

display help for a command; --agent prints the agent operations guide

**用法:** `mf help [options] [topic...]`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `[topic...]` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--agent` | print agent-oriented guidance (auth, scopes, safety, recovery) |
| `--json` | with --agent: emit a machine-readable JSON envelope |
| `-h, --help` | display help for command |
