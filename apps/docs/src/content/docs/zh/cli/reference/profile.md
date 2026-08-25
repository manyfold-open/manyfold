---
title: "mf profile"
description: "Inspect and manage CLI profiles (ADR-0014)"
order: 17
---
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

## `mf profile show`

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

## `mf profile list`

List profiles on this machine

**用法:** `mf profile list [options]`

**Option**

| Option | 用途 |
| --- | --- |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

## `mf profile delete`

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
