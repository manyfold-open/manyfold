---
title: "mf model-config"
description: "Read/update agent model configuration"
order: 11
---
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

## `mf model-config get`

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

## `mf model-config update`

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

## `mf model-config refresh-models`

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
