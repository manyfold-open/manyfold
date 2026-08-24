---
title: "mf runtime"
description: "Manage agent runtimes (the sprite/pod shell)"
order: 12
---
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

## `mf runtime list`

List your agent runtimes

**Usage:** `mf runtime list [options]`

**Aliases:** `ls`

**Options**

| Options | Purpose |
| --- | --- |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

## `mf runtime get`

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

## `mf runtime delete`

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

## `mf runtime control-ui`

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

### `mf runtime control-ui get-url`

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

### `mf runtime control-ui enable`

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

### `mf runtime control-ui disable`

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

## `mf runtime dashboard`

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

### `mf runtime dashboard enable`

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

### `mf runtime dashboard disable`

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

## `mf runtime agents`

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

### `mf runtime agents add`

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

### `mf runtime agents list`

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

### `mf runtime agents remove`

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
