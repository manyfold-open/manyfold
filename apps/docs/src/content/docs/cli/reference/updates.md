---
title: "mf updates"
description: "Pending updates on your computers, sandboxes, frameworks and skills, as in the web's Update Center"
order: 22
---
**Usage:** `mf updates [command]`

**Options**

| Options | Purpose |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommands**

| Command | Purpose |
| --- | --- |
| [`mf updates list`](#mf-updates-list) | List pending updates and what each one needs |
| [`mf updates apply`](#mf-updates-apply) | Run pending updates: the ids given, or every one that can run from here |
| [`mf updates versions`](#mf-updates-versions) | Versions you can install, newest first: cli for the mf CLI or a framework name; without one, the latest of each |

## `mf updates list`

List pending updates and what each one needs

**Usage:** `mf updates list [options]`

**Aliases:** `ls`

**Options**

| Options | Purpose |
| --- | --- |
| `--kind <kind>` | only this kind of update One of: `cli`, `herdr`, `framework`, `cli-usage`, `skill`. |
| `--where <name\|id>` | only updates on this computer, sandbox, cloud computer, runtime or agent |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

## `mf updates apply`

Run pending updates: the ids given, or every one that can run from here

**Usage:** `mf updates apply [options] [ids...]`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `[ids...]` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--kind <kind>` | only this kind of update One of: `cli`, `herdr`, `framework`, `cli-usage`, `skill`. |
| `--where <name\|id>` | only updates on this computer, sandbox, cloud computer, runtime or agent |
| `--to <version>` | the version to go to, for one update |
| `-y, --yes` | skip the confirmation prompt |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

## `mf updates versions`

Versions you can install, newest first: cli for the mf CLI or a framework name; without one, the latest of each

**Usage:** `mf updates versions [options] [name]`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `[name]` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |
