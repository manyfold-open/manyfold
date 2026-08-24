---
title: "mf model-config"
description: "Read/update agent model configuration"
order: 11
---
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

## `mf model-config get`

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

## `mf model-config update`

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

## `mf model-config refresh-models`

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
