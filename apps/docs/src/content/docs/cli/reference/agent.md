---
title: "mf agent"
description: "Manage agents"
order: 5
---
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

## `mf agent list`

List agents owned by the current user

**Usage:** `mf agent list [options]`

**Aliases:** `ls`

**Options**

| Options | Purpose |
| --- | --- |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

## `mf agent get`

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

## `mf agent create`

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

## `mf agent update`

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

## `mf agent delete`

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

## `mf agent storage-usage`

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

## `mf agent model-config`

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

### `mf agent model-config get`

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

### `mf agent model-config update`

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

### `mf agent model-config refresh-models`

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

## `mf agent credentials`

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

### `mf agent credentials get`

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

### `mf agent credentials reveal`

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

### `mf agent credentials update`

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
