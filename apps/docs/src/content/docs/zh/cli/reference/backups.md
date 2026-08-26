---
title: "mf backups"
description: "Manage agent backups and restores"
order: 7
---
**用法:** `mf backups [command]`

**Option**

| Option | 用途 |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommand**

| 命令 | 用途 |
| --- | --- |
| [`mf backups list`](#mf-backups-list) | List backups (optionally filter by agent) |
| [`mf backups create`](#mf-backups-create) | Snapshot an agent into a new backup |
| [`mf backups delete`](#mf-backups-delete) | Delete a backup (irreversible) |
| [`mf backups restore`](#mf-backups-restore) | Restore an agent from a backup (replaces current state) |
| [`mf backups get-restore`](#mf-backups-get-restore) | Show status of a restore operation |

## `mf backups list`

List backups (optionally filter by agent)

**用法:** `mf backups list [options]`

**Alias:** `ls`

**Option**

| Option | 用途 |
| --- | --- |
| `--agent-id <id>` | filter to this agent |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

## `mf backups create`

Snapshot an agent into a new backup

**用法:** `mf backups create [options] <agentId>`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<agentId>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--json` | emit raw JSON (default) |
| `-h, --help` | display help for command |

## `mf backups delete`

Delete a backup (irreversible)

**用法:** `mf backups delete [options] <backupId>`

**Alias:** `rm`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<backupId>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `-y, --yes` | confirm irreversible deletion |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

## `mf backups restore`

Restore an agent from a backup (replaces current state)

**用法:** `mf backups restore [options] <agentId>`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<agentId>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--backup-id <id>` | backup id to restore from 必填。 |
| `-y, --yes` | confirm replacement of current state |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

## `mf backups get-restore`

Show status of a restore operation

**用法:** `mf backups get-restore [options] <restoreId>`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<restoreId>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--json` | emit raw JSON (default) |
| `-h, --help` | display help for command |
