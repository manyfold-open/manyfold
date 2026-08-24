---
title: "mf backups"
description: "Manage agent backups and restores"
order: 7
---
**Usage:** `mf backups [command]`

**Options**

| Options | Purpose |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommands**

| Command | Purpose |
| --- | --- |
| [`mf backups list`](#mf-backups-list) | List backups (optionally filter by agent) |
| [`mf backups create`](#mf-backups-create) | Snapshot an agent into a new backup |
| [`mf backups delete`](#mf-backups-delete) | Delete a backup (irreversible) |
| [`mf backups restore`](#mf-backups-restore) | Restore an agent from a backup (replaces current state) |
| [`mf backups get-restore`](#mf-backups-get-restore) | Show status of a restore operation |

## `mf backups list`

List backups (optionally filter by agent)

**Usage:** `mf backups list [options]`

**Aliases:** `ls`

**Options**

| Options | Purpose |
| --- | --- |
| `--agent-id <id>` | filter to this agent |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

## `mf backups create`

Snapshot an agent into a new backup

**Usage:** `mf backups create [options] <agentId>`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<agentId>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--json` | emit raw JSON (default) |
| `-h, --help` | display help for command |

## `mf backups delete`

Delete a backup (irreversible)

**Usage:** `mf backups delete [options] <backupId>`

**Aliases:** `rm`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<backupId>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `-y, --yes` | confirm irreversible deletion |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

## `mf backups restore`

Restore an agent from a backup (replaces current state)

**Usage:** `mf backups restore [options] <agentId>`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<agentId>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--backup-id <id>` | backup id to restore from Required. |
| `-y, --yes` | confirm replacement of current state |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

## `mf backups get-restore`

Show status of a restore operation

**Usage:** `mf backups get-restore [options] <restoreId>`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<restoreId>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--json` | emit raw JSON (default) |
| `-h, --help` | display help for command |
