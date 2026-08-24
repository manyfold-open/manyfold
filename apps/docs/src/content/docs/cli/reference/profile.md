---
title: "mf profile"
description: "Inspect and manage CLI profiles (ADR-0014)"
order: 17
---
**Usage:** `mf profile [command]`

**Options**

| Options | Purpose |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommands**

| Command | Purpose |
| --- | --- |
| [`mf profile show`](#mf-profile-show) | Show a profile: source, paths, login and daemon state |
| [`mf profile list`](#mf-profile-list) | List profiles on this machine |
| [`mf profile delete`](#mf-profile-delete) | Delete a profile: credentials, pending login, daemon state and init units. Agent data lives in the machine-shared ~/.manyfold/workspaces and is never touched. |

## `mf profile show`

Show a profile: source, paths, login and daemon state

**Usage:** `mf profile show [options] [name]`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `[name]` | profile to inspect (default: the current one) |

**Options**

| Options | Purpose |
| --- | --- |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

## `mf profile list`

List profiles on this machine

**Usage:** `mf profile list [options]`

**Options**

| Options | Purpose |
| --- | --- |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

## `mf profile delete`

Delete a profile: credentials, pending login, daemon state and init units. Agent data lives in the machine-shared ~/.manyfold/workspaces and is never touched.

**Usage:** `mf profile delete [options] <name>`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<name>` | profile to delete |

**Options**

| Options | Purpose |
| --- | --- |
| `--force` | allow deleting the default profile |
| `-y, --yes` | skip the confirmation prompt |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |
