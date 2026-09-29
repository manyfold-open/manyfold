---
title: "mf sandbox"
description: "List, delete and inspect your sandboxes"
order: 14
---
**Usage:** `mf sandbox [command]`

**Options**

| Options | Purpose |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommands**

| Command | Purpose |
| --- | --- |
| [`mf sandbox list`](#mf-sandbox-list) | List your sandboxes, the frameworks on each, and how many your plan includes |
| [`mf sandbox delete`](#mf-sandbox-delete) | Delete a sandbox (id or name) and its files (irreversible); refused while agents are on it |
| [`mf sandbox storage-usage`](#mf-sandbox-storage-usage) | Report cached current-sandbox storage; --account reports the whole account |

## `mf sandbox list`

List your sandboxes, the frameworks on each, and how many your plan includes

**Usage:** `mf sandbox list [options]`

**Aliases:** `ls`

**Options**

| Options | Purpose |
| --- | --- |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

## `mf sandbox delete`

Delete a sandbox (id or name) and its files (irreversible); refused while agents are on it

**Usage:** `mf sandbox delete [options] <sandbox>`

**Aliases:** `rm`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<sandbox>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `-y, --yes` | confirm irreversible deletion |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

## `mf sandbox storage-usage`

Report cached current-sandbox storage; --account reports the whole account

**Usage:** `mf sandbox storage-usage [options]`

**Options**

| Options | Purpose |
| --- | --- |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |
