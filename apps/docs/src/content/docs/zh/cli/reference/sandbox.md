---
title: "mf sandbox"
description: "List, delete and inspect your sandboxes"
order: 14
---
**用法:** `mf sandbox [command]`

**Option**

| Option | 用途 |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommand**

| 命令 | 用途 |
| --- | --- |
| [`mf sandbox list`](#mf-sandbox-list) | List your sandboxes, the frameworks on each, and how many your plan includes |
| [`mf sandbox delete`](#mf-sandbox-delete) | Delete a sandbox (id or name) and its files (irreversible); refused while agents are on it |
| [`mf sandbox storage-usage`](#mf-sandbox-storage-usage) | Report cached current-sandbox storage; --account reports the whole account |

## `mf sandbox list`

List your sandboxes, the frameworks on each, and how many your plan includes

**用法:** `mf sandbox list [options]`

**Alias:** `ls`

**Option**

| Option | 用途 |
| --- | --- |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

## `mf sandbox delete`

Delete a sandbox (id or name) and its files (irreversible); refused while agents are on it

**用法:** `mf sandbox delete [options] <sandbox>`

**Alias:** `rm`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<sandbox>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `-y, --yes` | confirm irreversible deletion |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

## `mf sandbox storage-usage`

Report cached current-sandbox storage; --account reports the whole account

**用法:** `mf sandbox storage-usage [options]`

**Option**

| Option | 用途 |
| --- | --- |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |
