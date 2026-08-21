---
title: CLI command reference
description: Search the complete mf command tree, arguments, and options.
order: 12
---

# CLI command reference

This page is generated from the same Commander tree as the mf binary. It documents the current public command surface; the installed binary remains authoritative for its own version.

**Generated from:** `mf 0.23.3`

Run `mf <command> --help` to confirm syntax for the version installed on your machine.

## Global options

**Usage:** `mf [options] [command]`

**Options**

| Options | Purpose |
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

**Usage:** `mf auth [command]`

**Options**

| Options | Purpose |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommands**

| Command | Purpose |
| --- | --- |
| [`mf auth ensure`](#mf-auth-ensure) | Ensure the current identity has the requested capabilities |

<a id="mf-auth-ensure"></a>
### `mf auth ensure`

Ensure the current identity has the requested capabilities

**Usage:** `mf auth ensure [options]`

**Options**

| Options | Purpose |
| --- | --- |
| `--scopes <list>` | comma-separated grant scopes to ensure (e.g. channels:read,channels:edit) |
| `--for-agent <id>` | agent to ensure scopes for (defaults to --agent-id / $MF_AGENT_ID) |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

<a id="mf-setup"></a>
## `mf setup`

One-command onboarding: sign in, register this machine as a daemon, start it

**Usage:** `mf setup [options]`

**Options**

| Options | Purpose |
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

**Usage:** `mf login [options]`

**Options**

| Options | Purpose |
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

**Usage:** `mf whoami [options]`

**Options**

| Options | Purpose |
| --- | --- |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

<a id="mf-agent"></a>
## `mf agent`

Manage agents

**Usage:** `mf agent [command]`

**Aliases:** `agents`

**Options**

| Options | Purpose |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommands**

| Command | Purpose |
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

**Usage:** `mf agent list [options]`

**Aliases:** `ls`

**Options**

| Options | Purpose |
| --- | --- |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

<a id="mf-agent-get"></a>
### `mf agent get`

Show a single agent

**Usage:** `mf agent get [options] <agentId>`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<agentId>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

<a id="mf-agent-create"></a>
### `mf agent create`

Create a new agent on sprites.dev

**Usage:** `mf agent create [options] <name>`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<name>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--framework <framework>` | claude-code \| codex \| gemini-cli Default: `claude-code`. |
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

**Usage:** `mf agent update [options] <agentId>`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<agentId>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--name <name>` | rename the agent |
| `--model <model>` | set model id |
| `--clear-model` | clear the model override |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

<a id="mf-agent-delete"></a>
### `mf agent delete`

Delete an agent (irreversible)

**Usage:** `mf agent delete [options] <agentId>`

**Aliases:** `rm`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<agentId>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `-y, --yes` | confirm irreversible deletion |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

<a id="mf-agent-storage-usage"></a>
### `mf agent storage-usage`

Report storage usage for an agent

**Usage:** `mf agent storage-usage [options] <agentId>`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<agentId>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--json` | emit raw JSON (default) |
| `-h, --help` | display help for command |

<a id="mf-agent-model-config"></a>
### `mf agent model-config`

Manage agent model config

**Usage:** `mf agent model-config [command]`

**Options**

| Options | Purpose |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommands**

| Command | Purpose |
| --- | --- |
| [`mf agent model-config get`](#mf-agent-model-config-get) | Get the agent model config view |
| [`mf agent model-config update`](#mf-agent-model-config-update) | Update agent model config |
| [`mf agent model-config refresh-models`](#mf-agent-model-config-refresh-models) | Refresh the provider model list for an agent |

<a id="mf-agent-model-config-get"></a>
#### `mf agent model-config get`

Get the agent model config view

**Usage:** `mf agent model-config get [options] <agentId>`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<agentId>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--json` | emit raw JSON (default) |
| `-h, --help` | display help for command |

<a id="mf-agent-model-config-update"></a>
#### `mf agent model-config update`

Update agent model config

**Usage:** `mf agent model-config update [options] <agentId>`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<agentId>` |  |

**Options**

| Options | Purpose |
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

**Usage:** `mf agent model-config refresh-models [options] <agentId>`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<agentId>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--source <source>` | modelConfigSource value to refresh (optional) |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

<a id="mf-agent-credentials"></a>
### `mf agent credentials`

Manage agent credentials (provider keys, etc.)

**Usage:** `mf agent credentials [command]`

**Options**

| Options | Purpose |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommands**

| Command | Purpose |
| --- | --- |
| [`mf agent credentials get`](#mf-agent-credentials-get) | Show credential metadata (not secrets) |
| [`mf agent credentials reveal`](#mf-agent-credentials-reveal) | Reveal credentials. Output is masked unless --show is passed. |
| [`mf agent credentials update`](#mf-agent-credentials-update) | Update agent credentials |

<a id="mf-agent-credentials-get"></a>
#### `mf agent credentials get`

Show credential metadata (not secrets)

**Usage:** `mf agent credentials get [options] <agentId>`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<agentId>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--json` | emit raw JSON (default) |
| `-h, --help` | display help for command |

<a id="mf-agent-credentials-reveal"></a>
#### `mf agent credentials reveal`

Reveal credentials. Output is masked unless --show is passed.

**Usage:** `mf agent credentials reveal [options] <agentId>`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<agentId>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--json` | emit raw JSON |
| `--show` | print the secret in plaintext |
| `-h, --help` | display help for command |

<a id="mf-agent-credentials-update"></a>
#### `mf agent credentials update`

Update agent credentials

**Usage:** `mf agent credentials update [options] <agentId>`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<agentId>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--body <json>` | request body JSON (or @file). Shape: UpdateAgentCredentialsBody Required. |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

<a id="mf-automations"></a>
## `mf automations`

Manage scheduled automations

**Usage:** `mf automations [command]`

**Options**

| Options | Purpose |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommands**

| Command | Purpose |
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

**Usage:** `mf automations list [options]`

**Aliases:** `ls`

**Options**

| Options | Purpose |
| --- | --- |
| `--agent-id <id>` | filter to this agent |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

<a id="mf-automations-get"></a>
### `mf automations get`

Show a single automation (with recent runs)

**Usage:** `mf automations get [options] <id>`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<id>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--json` | emit raw JSON (default) |
| `-h, --help` | display help for command |

<a id="mf-automations-create"></a>
### `mf automations create`

Create a new automation

**Usage:** `mf automations create [options]`

**Options**

| Options | Purpose |
| --- | --- |
| `--agent-id <id>` | agent id to run as (defaults to $MF_AGENT_ID) |
| `--title <title>` | short title Required. |
| `--prompt <prompt>` | prompt body Required. |
| `--schedule-preset <preset>` | hourly \| daily \| weekdays \| weekly \| custom Required. |
| `--rrule <rrule>` | RRULE string (iCalendar) Required. |
| `--timezone <tz>` | IANA timezone (e.g. UTC) Required. |
| `--dtstart <iso>` | first run start (ISO8601) |
| `--model <model>` | model override |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

<a id="mf-automations-update"></a>
### `mf automations update`

Update an existing automation

**Usage:** `mf automations update [options] <id>`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<id>` |  |

**Options**

| Options | Purpose |
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

**Usage:** `mf automations run [options] <id>`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<id>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

<a id="mf-automations-delete"></a>
### `mf automations delete`

Delete an automation

**Usage:** `mf automations delete [options] <id>`

**Aliases:** `rm`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<id>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `-y, --yes` | confirm deletion |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

<a id="mf-backups"></a>
## `mf backups`

Manage agent backups and restores

**Usage:** `mf backups [command]`

**Options**

| Options | Purpose |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommands**

| Command | Purpose |
| --- | --- |
| [`mf backups list`](#mf-backups-list) | List backups (optionally filter by agent) |
| [`mf backups create`](#mf-backups-create) | Snapshot an agent into a new backup |
| [`mf backups delete`](#mf-backups-delete) | Delete a backup (irreversible) |
| [`mf backups restore`](#mf-backups-restore) | Restore an agent from a backup (replaces current state) |
| [`mf backups get-restore`](#mf-backups-get-restore) | Show status of a restore operation |

<a id="mf-backups-list"></a>
### `mf backups list`

List backups (optionally filter by agent)

**Usage:** `mf backups list [options]`

**Aliases:** `ls`

**Options**

| Options | Purpose |
| --- | --- |
| `--agent-id <id>` | filter to this agent |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

<a id="mf-backups-create"></a>
### `mf backups create`

Snapshot an agent into a new backup

**Usage:** `mf backups create [options] <agentId>`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<agentId>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--json` | emit raw JSON (default) |
| `-h, --help` | display help for command |

<a id="mf-backups-delete"></a>
### `mf backups delete`

Delete a backup (irreversible)

**Usage:** `mf backups delete [options] <backupId>`

**Aliases:** `rm`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<backupId>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `-y, --yes` | confirm irreversible deletion |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

<a id="mf-backups-restore"></a>
### `mf backups restore`

Restore an agent from a backup (replaces current state)

**Usage:** `mf backups restore [options] <agentId>`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<agentId>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--backup-id <id>` | backup id to restore from Required. |
| `-y, --yes` | confirm replacement of current state |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

<a id="mf-backups-get-restore"></a>
### `mf backups get-restore`

Show status of a restore operation

**Usage:** `mf backups get-restore [options] <restoreId>`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<restoreId>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--json` | emit raw JSON (default) |
| `-h, --help` | display help for command |

<a id="mf-channels"></a>
## `mf channels`

Manage agent channels (Telegram, Lark, Slack, etc.)

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

<a id="mf-channels-list"></a>
### `mf channels list`

List channels (optionally filter by agent)

**Usage:** `mf channels list [options]`

**Aliases:** `ls`

**Options**

| Options | Purpose |
| --- | --- |
| `--agent-id <id>` | filter to channels owned by this agent (client-side filter) |
| `--json` | emit raw JSON array |
| `-h, --help` | display help for command |

<a id="mf-channels-create"></a>
### `mf channels create`

Create a channel

**Usage:** `mf channels create [options]`

**Options**

| Options | Purpose |
| --- | --- |
| `--agent-id <id>` | agent id (defaults to $MF_AGENT_ID or --agent-id global) |
| `--provider <name>` | channel provider (fake\|lark\|telegram\|slack\|discord\|matrix) Required. |
| `--label <label>` | channel label (1-200 chars) Required. |
| `--config <json>` | channel config (@path for file, or inline JSON object) Required. |
| `--credentials <json>` | channel credentials (@path for file, or inline JSON object) |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

<a id="mf-channels-get"></a>
### `mf channels get`

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

<a id="mf-channels-update"></a>
### `mf channels update`

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

<a id="mf-channels-delete"></a>
### `mf channels delete`

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

<a id="mf-channels-test"></a>
### `mf channels test`

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

<a id="mf-channels-register"></a>
### `mf channels register`

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

<a id="mf-channels-send"></a>
### `mf channels send`

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

<a id="mf-channels-sessions"></a>
### `mf channels sessions`

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

<a id="mf-channels-sessions-scopes"></a>
#### `mf channels sessions scopes`

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

<a id="mf-channels-sessions-list"></a>
#### `mf channels sessions list`

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

<a id="mf-channels-sessions-new"></a>
#### `mf channels sessions new`

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

<a id="mf-channels-sessions-switch"></a>
#### `mf channels sessions switch`

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

<a id="mf-channels-sessions-rename"></a>
#### `mf channels sessions rename`

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

<a id="mf-channels-sessions-delete"></a>
#### `mf channels sessions delete`

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

<a id="mf-files"></a>
## `mf files`

Read/write files on an agent runtime

**Usage:** `mf files [command]`

**Options**

| Options | Purpose |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommands**

| Command | Purpose |
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

**Usage:** `mf files roots [options] [agentId]`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `[agentId]` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

<a id="mf-files-list"></a>
### `mf files list`

List directory entries on an agent

**Usage:** `mf files list [options] [agentIdOrPath] [path]`

**Aliases:** `ls`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `[agentIdOrPath]` |  |
| `[path]` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--root <rootId>` | root id (default: workspace) |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

<a id="mf-files-stat"></a>
### `mf files stat`

Show file metadata

**Usage:** `mf files stat [options] [agentIdOrPath] [path]`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `[agentIdOrPath]` |  |
| `[path]` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--root <rootId>` | root id |
| `--json` | emit raw JSON (default) |
| `-h, --help` | display help for command |

<a id="mf-files-read"></a>
### `mf files read`

Read file contents (to stdout or --output)

**Usage:** `mf files read [options] [agentIdOrPath] [path]`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `[agentIdOrPath]` |  |
| `[path]` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--root <rootId>` | root id |
| `--output <localPath>` | write to this local file instead of stdout |
| `-h, --help` | display help for command |

<a id="mf-files-write"></a>
### `mf files write`

Write file contents from --content or --file

**Usage:** `mf files write [options] [agentIdOrPath] [path]`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `[agentIdOrPath]` |  |
| `[path]` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--content <data>` | inline content (string) |
| `--file <localPath>` | read content from a local file |
| `--root <rootId>` | root id |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

<a id="mf-files-upload"></a>
### `mf files upload`

Upload a local file to an agent (remotePath defaults to the file name)

**Usage:** `mf files upload [options] <localPath> [remotePath]`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<localPath>` |  |
| `[remotePath]` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--root <rootId>` | root id (default: workspace) |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

<a id="mf-files-download"></a>
### `mf files download`

Download a file from an agent (localPath defaults to the file name, - for stdout)

**Usage:** `mf files download [options] <remotePath> [localPath]`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<remotePath>` |  |
| `[localPath]` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--root <rootId>` | root id (default: workspace) |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

<a id="mf-files-mkdir"></a>
### `mf files mkdir`

Create a directory on an agent

**Usage:** `mf files mkdir [options] [agentIdOrPath] [path]`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `[agentIdOrPath]` |  |
| `[path]` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--root <rootId>` | root id |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

<a id="mf-files-mv"></a>
### `mf files mv`

Move or rename a path on an agent

**Usage:** `mf files mv [options] [agentIdOrFrom] [from] [to]`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `[agentIdOrFrom]` |  |
| `[from]` |  |
| `[to]` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--root <rootId>` | root id |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

<a id="mf-files-rm"></a>
### `mf files rm`

Remove a file or directory on an agent

**Usage:** `mf files rm [options] [agentIdOrPath] [path]`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `[agentIdOrPath]` |  |
| `[path]` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--root <rootId>` | root id |
| `--recursive` | remove directories recursively |
| `-y, --yes` | confirm irreversible deletion |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

<a id="mf-connections"></a>
## `mf connections`

List the connections linked to this agent (or, for a user, your account)

**Usage:** `mf connections [options]`

**Options**

| Options | Purpose |
| --- | --- |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

<a id="mf-model-config"></a>
## `mf model-config`

Read/update agent model configuration

**Usage:** `mf model-config [command]`

**Options**

| Options | Purpose |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommands**

| Command | Purpose |
| --- | --- |
| [`mf model-config get`](#mf-model-config-get) | Get the agent model config view |
| [`mf model-config update`](#mf-model-config-update) | Update agent model config |
| [`mf model-config refresh-models`](#mf-model-config-refresh-models) | Refresh the provider model list for an agent |

<a id="mf-model-config-get"></a>
### `mf model-config get`

Get the agent model config view

**Usage:** `mf model-config get [options] <agentId>`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<agentId>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--json` | emit raw JSON (default) |
| `-h, --help` | display help for command |

<a id="mf-model-config-update"></a>
### `mf model-config update`

Update agent model config

**Usage:** `mf model-config update [options] <agentId>`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<agentId>` |  |

**Options**

| Options | Purpose |
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

**Usage:** `mf model-config refresh-models [options] <agentId>`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<agentId>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--source <source>` | modelConfigSource value to refresh (optional) |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

<a id="mf-runtime"></a>
## `mf runtime`

Manage agent runtimes (the sprite/pod shell)

**Usage:** `mf runtime [command]`

**Aliases:** `agent-runtimes`

**Options**

| Options | Purpose |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommands**

| Command | Purpose |
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

**Usage:** `mf runtime list [options]`

**Aliases:** `ls`

**Options**

| Options | Purpose |
| --- | --- |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

<a id="mf-runtime-get"></a>
### `mf runtime get`

Show detail for an agent runtime

**Usage:** `mf runtime get [options] <id>`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<id>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

<a id="mf-runtime-delete"></a>
### `mf runtime delete`

Delete an agent runtime (tears down sprite/pod and cascades to agents)

**Usage:** `mf runtime delete [options] <id>`

**Aliases:** `rm`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<id>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

<a id="mf-runtime-control-ui"></a>
### `mf runtime control-ui`

Manage the runtime control UI sidecar

**Usage:** `mf runtime control-ui [command]`

**Options**

| Options | Purpose |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommands**

| Command | Purpose |
| --- | --- |
| [`mf runtime control-ui get-url`](#mf-runtime-control-ui-get-url) | Get the control UI URL for a runtime |
| [`mf runtime control-ui enable`](#mf-runtime-control-ui-enable) | Enable the control UI sidecar |
| [`mf runtime control-ui disable`](#mf-runtime-control-ui-disable) | Disable the control UI sidecar |

<a id="mf-runtime-control-ui-get-url"></a>
#### `mf runtime control-ui get-url`

Get the control UI URL for a runtime

**Usage:** `mf runtime control-ui get-url [options] <runtimeId>`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<runtimeId>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

<a id="mf-runtime-control-ui-enable"></a>
#### `mf runtime control-ui enable`

Enable the control UI sidecar

**Usage:** `mf runtime control-ui enable [options] <runtimeId>`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<runtimeId>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

<a id="mf-runtime-control-ui-disable"></a>
#### `mf runtime control-ui disable`

Disable the control UI sidecar

**Usage:** `mf runtime control-ui disable [options] <runtimeId>`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<runtimeId>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

<a id="mf-runtime-dashboard"></a>
### `mf runtime dashboard`

Manage the runtime dashboard (Hermes only)

**Usage:** `mf runtime dashboard [command]`

**Options**

| Options | Purpose |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommands**

| Command | Purpose |
| --- | --- |
| [`mf runtime dashboard enable`](#mf-runtime-dashboard-enable) | Enable the Hermes dashboard |
| [`mf runtime dashboard disable`](#mf-runtime-dashboard-disable) | Disable the Hermes dashboard |

<a id="mf-runtime-dashboard-enable"></a>
#### `mf runtime dashboard enable`

Enable the Hermes dashboard

**Usage:** `mf runtime dashboard enable [options] <runtimeId>`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<runtimeId>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

<a id="mf-runtime-dashboard-disable"></a>
#### `mf runtime dashboard disable`

Disable the Hermes dashboard

**Usage:** `mf runtime dashboard disable [options] <runtimeId>`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<runtimeId>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

<a id="mf-runtime-agents"></a>
### `mf runtime agents`

Manage framework agents hosted on a runtime

**Usage:** `mf runtime agents [command]`

**Options**

| Options | Purpose |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommands**

| Command | Purpose |
| --- | --- |
| [`mf runtime agents add`](#mf-runtime-agents-add) | Add a framework agent to an existing runtime |
| [`mf runtime agents list`](#mf-runtime-agents-list) | List framework agents on a runtime |
| [`mf runtime agents remove`](#mf-runtime-agents-remove) | Remove a framework agent (by agent id) |

<a id="mf-runtime-agents-add"></a>
#### `mf runtime agents add`

Add a framework agent to an existing runtime

**Usage:** `mf runtime agents add [options] <runtimeId>`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<runtimeId>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--name <name>` | agent display name Required. |
| `--workspace <path>` | workspace path (coding agents only) |
| `--model <model>` | model override |
| `--clone-from <agentId>` | clone state from another agent |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

<a id="mf-runtime-agents-list"></a>
#### `mf runtime agents list`

List framework agents on a runtime

**Usage:** `mf runtime agents list [options] <runtimeId>`

**Aliases:** `ls`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<runtimeId>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

<a id="mf-runtime-agents-remove"></a>
#### `mf runtime agents remove`

Remove a framework agent (by agent id)

**Usage:** `mf runtime agents remove [options] <agentId>`

**Aliases:** `rm`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<agentId>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `-y, --yes` | confirm removal |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

<a id="mf-skills"></a>
## `mf skills`

Manage installed agent skills

**Usage:** `mf skills [command]`

**Options**

| Options | Purpose |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommands**

| Command | Purpose |
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

**Usage:** `mf skills installed [options]`

**Options**

| Options | Purpose |
| --- | --- |
| `--agent-id <id>` | filter to this agent |
| `--include-runtime` | include runtime-level skills |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

<a id="mf-skills-discover"></a>
### `mf skills discover`

Discover skills available to install

**Usage:** `mf skills discover [options]`

**Options**

| Options | Purpose |
| --- | --- |
| `--agent-id <id>` | filter to this agent context |
| `--q <query>` | search query |
| `--repo-id <id>` | filter to a specific repo |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

<a id="mf-skills-install"></a>
### `mf skills install`

Install a skill on one agent (or many via --agent-ids)

**Usage:** `mf skills install [options]`

**Options**

| Options | Purpose |
| --- | --- |
| `--skill-id <id>` | skill id from discover or library Required. |
| `--agent-id <id>` | agent id (defaults to the global --agent-id / $MF_AGENT_ID) |
| `--agent-ids <ids>` | comma-separated agent ids for a batch install |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

<a id="mf-skills-update"></a>
### `mf skills update`

Enable or disable an installed skill

**Usage:** `mf skills update [options] <userSkillId>`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<userSkillId>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--enabled` | enable the skill |
| `--disabled` | disable the skill |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

<a id="mf-skills-delete"></a>
### `mf skills delete`

Uninstall a skill

**Usage:** `mf skills delete [options] <userSkillId>`

**Aliases:** `rm`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<userSkillId>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `-y, --yes` | confirm uninstall |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

<a id="mf-skills-library"></a>
### `mf skills library`

Manage your personal skill library

**Usage:** `mf skills library [command]`

**Options**

| Options | Purpose |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommands**

| Command | Purpose |
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

**Usage:** `mf skills library list [options]`

**Aliases:** `ls`

**Options**

| Options | Purpose |
| --- | --- |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

<a id="mf-skills-library-get"></a>
#### `mf skills library get`

Show a library skill (metadata + SKILL.md)

**Usage:** `mf skills library get [options] <skillId>`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<skillId>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

<a id="mf-skills-library-create"></a>
#### `mf skills library create`

Create a library skill

**Usage:** `mf skills library create [options]`

**Options**

| Options | Purpose |
| --- | --- |
| `--name <name>` | skill name Required. |
| `--description <text>` | skill description |
| `--content <markdown>` | SKILL.md content inline |
| `--content-file <path>` | read SKILL.md content from a file |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

<a id="mf-skills-library-update"></a>
#### `mf skills library update`

Update a library skill (name / description / SKILL.md)

**Usage:** `mf skills library update [options] <skillId>`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<skillId>` |  |

**Options**

| Options | Purpose |
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

**Usage:** `mf skills library import [options]`

**Options**

| Options | Purpose |
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

**Usage:** `mf skills library share [options] <skill>`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<skill>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--revoke` | revoke the active share link |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

<a id="mf-skills-library-export"></a>
#### `mf skills library export`

Download a library skill as a .skill archive

**Usage:** `mf skills library export [options] <skillId>`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<skillId>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `-o, --output <path>` | output file path |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

<a id="mf-skills-library-delete"></a>
#### `mf skills library delete`

Delete a library skill

**Usage:** `mf skills library delete [options] <skillId>`

**Aliases:** `rm`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<skillId>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `-y, --yes` | confirm deletion |
| `--force` | uninstall from all agents before deleting |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

<a id="mf-skills-library-push"></a>
#### `mf skills library push`

Push the current skill content to installed agents (all by default)

**Usage:** `mf skills library push [options] <skillId>`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<skillId>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--agent-ids <ids>` | comma-separated agent ids to push to |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

<a id="mf-skills-library-files"></a>
#### `mf skills library files`

Manage a library skill’s supporting files

**Usage:** `mf skills library files [command]`

**Options**

| Options | Purpose |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommands**

| Command | Purpose |
| --- | --- |
| [`mf skills library files set`](#mf-skills-library-files-set) | Create or update a supporting file |
| [`mf skills library files delete`](#mf-skills-library-files-delete) | Delete a supporting file |

<a id="mf-skills-library-files-set"></a>
##### `mf skills library files set`

Create or update a supporting file

**Usage:** `mf skills library files set [options] <skillId>`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<skillId>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--path <path>` | file path inside the skill Required. |
| `--content <text>` | file content inline |
| `--content-file <path>` | read file content from a local file |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

<a id="mf-skills-library-files-delete"></a>
##### `mf skills library files delete`

Delete a supporting file

**Usage:** `mf skills library files delete [options] <skillId> <fileId>`

**Aliases:** `rm`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<skillId>` |  |
| `<fileId>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

<a id="mf-skills-repos"></a>
### `mf skills repos`

Manage skill repositories (admin / api.full)

**Usage:** `mf skills repos [command]`

**Options**

| Options | Purpose |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommands**

| Command | Purpose |
| --- | --- |
| [`mf skills repos list`](#mf-skills-repos-list) | List skill repos |
| [`mf skills repos create`](#mf-skills-repos-create) | Register a new skill repo |
| [`mf skills repos update`](#mf-skills-repos-update) | Update a skill repo (branch / enabled) |
| [`mf skills repos delete`](#mf-skills-repos-delete) | Remove a skill repo |

<a id="mf-skills-repos-list"></a>
#### `mf skills repos list`

List skill repos

**Usage:** `mf skills repos list [options]`

**Aliases:** `ls`

**Options**

| Options | Purpose |
| --- | --- |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

<a id="mf-skills-repos-create"></a>
#### `mf skills repos create`

Register a new skill repo

**Usage:** `mf skills repos create [options]`

**Options**

| Options | Purpose |
| --- | --- |
| `--owner <owner>` | github owner Required. |
| `--name <name>` | repo name Required. |
| `--branch <branch>` | branch (default: main) |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

<a id="mf-skills-repos-update"></a>
#### `mf skills repos update`

Update a skill repo (branch / enabled)

**Usage:** `mf skills repos update [options] <repoId>`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<repoId>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--branch <branch>` | new branch |
| `--enabled` | enable the repo |
| `--disabled` | disable the repo |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

<a id="mf-skills-repos-delete"></a>
#### `mf skills repos delete`

Remove a skill repo

**Usage:** `mf skills repos delete [options] <repoId>`

**Aliases:** `rm`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<repoId>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `-y, --yes` | confirm deletion |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

<a id="mf-usage"></a>
## `mf usage`

Read token + cost usage statistics

**Usage:** `mf usage [command]`

**Options**

| Options | Purpose |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommands**

| Command | Purpose |
| --- | --- |
| [`mf usage summary`](#mf-usage-summary) | Aggregate usage in a window |
| [`mf usage timeseries`](#mf-usage-timeseries) | Bucketed usage time series |
| [`mf usage events`](#mf-usage-events) | Paginated usage events |
| [`mf usage sessions`](#mf-usage-sessions) | Per-session usage summaries |
| [`mf usage top-agents`](#mf-usage-top-agents) | Rank agents by usage (cross-agent — denied for bound tokens) |

<a id="mf-usage-summary"></a>
### `mf usage summary`

Aggregate usage in a window

**Usage:** `mf usage summary [options]`

**Options**

| Options | Purpose |
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

**Usage:** `mf usage timeseries [options]`

**Options**

| Options | Purpose |
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

**Usage:** `mf usage events [options]`

**Options**

| Options | Purpose |
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

**Usage:** `mf usage sessions [options]`

**Options**

| Options | Purpose |
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

**Usage:** `mf usage top-agents [options]`

**Options**

| Options | Purpose |
| --- | --- |
| `--from <iso>` | inclusive start |
| `--to <iso>` | exclusive end |
| `--limit <n>` | top N (default 10) |
| `--json` | emit raw JSON (default) |
| `-h, --help` | display help for command |

<a id="mf-a2a"></a>
## `mf a2a`

Talk to A2A servers and manage this agent exposure and callers

**Usage:** `mf a2a [command]`

**Options**

| Options | Purpose |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommands**

| Command | Purpose |
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

**Usage:** `mf a2a exposure [command]`

**Options**

| Options | Purpose |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommands**

| Command | Purpose |
| --- | --- |
| [`mf a2a exposure get`](#mf-a2a-exposure-get) | Show hosted A2A exposure and public endpoints |
| [`mf a2a exposure enable`](#mf-a2a-exposure-enable) | Expose this agent as an A2A server |
| [`mf a2a exposure disable`](#mf-a2a-exposure-disable) | Stop exposing this agent as an A2A server |

<a id="mf-a2a-exposure-get"></a>
#### `mf a2a exposure get`

Show hosted A2A exposure and public endpoints

**Usage:** `mf a2a exposure get [options]`

**Options**

| Options | Purpose |
| --- | --- |
| `--json` | emit JSON |
| `-h, --help` | display help for command |

<a id="mf-a2a-exposure-enable"></a>
#### `mf a2a exposure enable`

Expose this agent as an A2A server

**Usage:** `mf a2a exposure enable [options]`

**Options**

| Options | Purpose |
| --- | --- |
| `--json` | emit JSON |
| `-h, --help` | display help for command |

<a id="mf-a2a-exposure-disable"></a>
#### `mf a2a exposure disable`

Stop exposing this agent as an A2A server

**Usage:** `mf a2a exposure disable [options]`

**Options**

| Options | Purpose |
| --- | --- |
| `--json` | emit JSON |
| `-h, --help` | display help for command |

<a id="mf-a2a-callers"></a>
### `mf a2a callers`

Manage callers authorized to invoke this agent

**Usage:** `mf a2a callers [command]`

**Options**

| Options | Purpose |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommands**

| Command | Purpose |
| --- | --- |
| [`mf a2a callers list`](#mf-a2a-callers-list) | List peer and external callers |
| [`mf a2a callers add`](#mf-a2a-callers-add) | Add an external client or peer agent caller |
| [`mf a2a callers revoke`](#mf-a2a-callers-revoke) | Revoke an A2A caller grant |

<a id="mf-a2a-callers-list"></a>
#### `mf a2a callers list`

List peer and external callers

**Usage:** `mf a2a callers list [options]`

**Options**

| Options | Purpose |
| --- | --- |
| `--json` | emit JSON |
| `-h, --help` | display help for command |

<a id="mf-a2a-callers-add"></a>
#### `mf a2a callers add`

Add an external client or peer agent caller

**Usage:** `mf a2a callers add [options]`

**Options**

| Options | Purpose |
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

**Usage:** `mf a2a callers revoke [options] <tokenId>`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<tokenId>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `-y, --yes` | confirm revocation |
| `--json` | emit JSON |
| `-h, --help` | display help for command |

<a id="mf-a2a-card"></a>
### `mf a2a card`

Fetch and print an Agent Card

**Usage:** `mf a2a card [options] <url>`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<url>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--bearer <token>` | bearer token for a raw url target ("-" reads stdin; falls back to $MF_A2A_BEARER) |
| `--json` | emit raw A2A JSON instead of a human summary |
| `--allow-http-localhost` | allow http:// and localhost/private targets (local dev only) |
| `-h, --help` | display help for command |

<a id="mf-a2a-status"></a>
### `mf a2a status`

Show callable peers and in-flight outbound calls

**Usage:** `mf a2a status [options]`

**Options**

| Options | Purpose |
| --- | --- |
| `--json` | emit JSON |
| `-h, --help` | display help for command |

<a id="mf-a2a-send"></a>
### `mf a2a send`

Send a message to a granted peer (name/id from `mf a2a status`) or a raw A2A url

**Usage:** `mf a2a send [options] <target> <prompt>`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<target>` |  |
| `<prompt>` |  |

**Options**

| Options | Purpose |
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

**Usage:** `mf a2a tasks [command]`

**Options**

| Options | Purpose |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommands**

| Command | Purpose |
| --- | --- |
| [`mf a2a tasks list`](#mf-a2a-tasks-list) | List this agent's outbound A2A calls |
| [`mf a2a tasks get`](#mf-a2a-tasks-get) | Fetch a task by id (target = peer name/id or url) |
| [`mf a2a tasks cancel`](#mf-a2a-tasks-cancel) | Cancel a task by id |
| [`mf a2a tasks subscribe`](#mf-a2a-tasks-subscribe) | Resubscribe to a task SSE stream (reconnect) |

<a id="mf-a2a-tasks-list"></a>
#### `mf a2a tasks list`

List this agent's outbound A2A calls

**Usage:** `mf a2a tasks list [options]`

**Options**

| Options | Purpose |
| --- | --- |
| `--state <state>` | filter by state (e.g. working) |
| `--peer <agentId>` | filter by peer (target agent id) |
| `--json` | emit JSON |
| `-h, --help` | display help for command |

<a id="mf-a2a-tasks-get"></a>
#### `mf a2a tasks get`

Fetch a task by id (target = peer name/id or url)

**Usage:** `mf a2a tasks get [options] <target> <taskId>`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<target>` |  |
| `<taskId>` |  |

**Options**

| Options | Purpose |
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

**Usage:** `mf a2a tasks cancel [options] <target> <taskId>`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<target>` |  |
| `<taskId>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--bearer <token>` | bearer token for a raw url target ("-" reads stdin; falls back to $MF_A2A_BEARER) |
| `--json` | emit raw A2A JSON instead of a human summary |
| `--allow-http-localhost` | allow http:// and localhost/private targets (local dev only) |
| `-h, --help` | display help for command |

<a id="mf-a2a-tasks-subscribe"></a>
#### `mf a2a tasks subscribe`

Resubscribe to a task SSE stream (reconnect)

**Usage:** `mf a2a tasks subscribe [options] <target> <taskId>`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<target>` |  |
| `<taskId>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--bearer <token>` | bearer token for a raw url target ("-" reads stdin; falls back to $MF_A2A_BEARER) |
| `--json` | emit raw A2A JSON instead of a human summary |
| `--allow-http-localhost` | allow http:// and localhost/private targets (local dev only) |
| `-h, --help` | display help for command |

<a id="mf-daemon"></a>
## `mf daemon`

Local daemon for Manyfold agents (claude-code / codex / gemini-cli)

**Usage:** `mf daemon [command]`

**Options**

| Options | Purpose |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommands**

| Command | Purpose |
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

**Usage:** `mf daemon register [options]`

**Options**

| Options | Purpose |
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

**Usage:** `mf daemon start [options]`

**Options**

| Options | Purpose |
| --- | --- |
| `--foreground` | run inline without touching the init unit (debug / used by the unit itself) |
| `--system` | install at system scope (boot-time; needs root/sudo; default as root) |
| `--user` | install at user scope (per-login; default as non-root) |
| `-h, --help` | display help for command |

<a id="mf-daemon-status"></a>
### `mf daemon status`

Show local daemon status

**Usage:** `mf daemon status [options]`

**Options**

| Options | Purpose |
| --- | --- |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

<a id="mf-daemon-stop"></a>
### `mf daemon stop`

Stop the Manyfold daemon and remove its autostart unit

**Usage:** `mf daemon stop [options]`

**Options**

| Options | Purpose |
| --- | --- |
| `--system` | target system scope (boot-time unit; needs root/sudo; default as root) |
| `--user` | target user scope (per-login unit; default as non-root) |
| `-h, --help` | display help for command |

<a id="mf-daemon-logs"></a>
### `mf daemon logs`

Tail the daemon log

**Usage:** `mf daemon logs [options]`

**Options**

| Options | Purpose |
| --- | --- |
| `-f, --follow` | follow log output |
| `-n, --lines <count>` | number of lines to show Default: `50`. |
| `-h, --help` | display help for command |

<a id="mf-daemon-doctor"></a>
### `mf daemon doctor`

Probe local frameworks and daemon terminal support

**Usage:** `mf daemon doctor [options]`

**Options**

| Options | Purpose |
| --- | --- |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

<a id="mf-profile"></a>
## `mf profile`

Inspect and manage CLI profiles (ADR-0014)

**Usage:** `mf profile [command]`

**Options**

| Options | Purpose |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommands**

| Command | Purpose |
| --- | --- |
| [`mf profile show`](#mf-profile-show) | Show a profile: source, paths, login and daemon state |
| [`mf profile list`](#mf-profile-list) | List profiles on this machine |
| [`mf profile delete`](#mf-profile-delete) | Delete a profile: credentials, pending login, daemon state and init units. Agent data lives in the machine-shared ~/.manyfold/workspaces and is never touched. |

<a id="mf-profile-show"></a>
### `mf profile show`

Show a profile: source, paths, login and daemon state

**Usage:** `mf profile show [options] [name]`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `[name]` | profile to inspect (default: the current one) |

**Options**

| Options | Purpose |
| --- | --- |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

<a id="mf-profile-list"></a>
### `mf profile list`

List profiles on this machine

**Usage:** `mf profile list [options]`

**Options**

| Options | Purpose |
| --- | --- |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

<a id="mf-profile-delete"></a>
### `mf profile delete`

Delete a profile: credentials, pending login, daemon state and init units. Agent data lives in the machine-shared ~/.manyfold/workspaces and is never touched.

**Usage:** `mf profile delete [options] <name>`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<name>` | profile to delete |

**Options**

| Options | Purpose |
| --- | --- |
| `--force` | allow deleting the default profile |
| `-y, --yes` | skip the confirmation prompt |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

<a id="mf-update"></a>
## `mf update`

Update the mf CLI to the latest version

**Usage:** `mf update [options]`

**Options**

| Options | Purpose |
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

**Usage:** `mf help [options] [topic...]`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `[topic...]` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--agent` | print agent-oriented guidance (auth, scopes, safety, recovery) |
| `--json` | with --agent: emit a machine-readable JSON envelope |
| `-h, --help` | display help for command |
