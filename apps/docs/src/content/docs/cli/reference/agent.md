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
| [`mf agent list`](#mf-agent-list) | List visible agents: runtime identity defaults to self; --account requires consent |
| [`mf agent get`](#mf-agent-get) | Show a single agent |
| [`mf agent create`](#mf-agent-create) | Create a coding agent on a new sandbox, or add one to a sandbox you have |
| [`mf agent update`](#mf-agent-update) | Update agent name or model |
| [`mf agent delete`](#mf-agent-delete) | Delete an agent (irreversible) |
| [`mf agent storage-usage`](#mf-agent-storage-usage) | Report agent-owned path usage, separate from sandbox and account storage |
| [`mf agent model-config`](#mf-agent-model-config) | Manage agent model config |
| [`mf agent credentials`](#mf-agent-credentials) | Manage agent credentials (provider keys, etc.) |

## `mf agent list`

List visible agents: runtime identity defaults to self; --account requires consent

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

Create a coding agent on a new sandbox, or add one to a sandbox you have

**Usage:** `mf agent create [options] <name>`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<name>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--framework <framework>` | coding framework One of: `claude-code`, `codex`, `gemini-cli`, `pi`, `antigravity-cli`. Default: `claude-code`. |
| `--model-provider <source>` | who serves the model: managed \| subscription \| a saved provider id or name (mf model-providers list) |
| `--model <model>` | model to run, from the provider's tested models; with a pasted key only for gemini-cli, pi and antigravity-cli |
| `--sandbox <sandbox>` | add the agent to this sandbox (id or name, mf sandbox list) instead of creating one |
| `--anthropic-auth-token <token>` | Anthropic key for claude-code; "-" reads it from stdin |
| `--anthropic-base-url <url>` | Anthropic base URL override (claude-code) |
| `--openai-api-key <key>` | OpenAI key for codex; "-" reads it from stdin |
| `--openai-base-url <url>` | OpenAI base URL override (codex) |
| `--google-api-key <key>` | Gemini key for gemini-cli and antigravity-cli; "-" reads it from stdin |
| `--google-gemini-base-url <url>` | Gemini base URL override (gemini-cli, antigravity-cli) |
| `--pi-api-key <key>` | vendor key for pi, with --pi-provider; "-" reads it from stdin |
| `--pi-provider <provider>` | the vendor the pi key belongs to: anthropic \| openai \| google |
| `--pi-base-url <url>` | vendor base URL override for pi |
| `--runtime-provider <id>` | admin only: the runtime provider a new sandbox is placed on |
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
| `--model <model>` | the model to run: an alias such as sonnet, an id, or a name such as "Sonnet 5" |
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

Report agent-owned path usage, separate from sandbox and account storage

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
| `--model <model>` | the model to run: an alias such as sonnet, an id, or a name such as "Sonnet 5" |
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
