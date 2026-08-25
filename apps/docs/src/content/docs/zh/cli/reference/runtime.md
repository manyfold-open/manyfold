---
title: "mf runtime"
description: "Manage agent runtimes (the sprite/pod shell)"
order: 12
---
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

## `mf runtime list`

List your agent runtimes

**用法:** `mf runtime list [options]`

**Alias:** `ls`

**Option**

| Option | 用途 |
| --- | --- |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

## `mf runtime get`

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

## `mf runtime delete`

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

## `mf runtime control-ui`

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

### `mf runtime control-ui get-url`

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

### `mf runtime control-ui enable`

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

### `mf runtime control-ui disable`

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

## `mf runtime dashboard`

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

### `mf runtime dashboard enable`

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

### `mf runtime dashboard disable`

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

## `mf runtime agents`

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

### `mf runtime agents add`

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

### `mf runtime agents list`

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

### `mf runtime agents remove`

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
