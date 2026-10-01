---
title: "mf updates"
description: "Pending updates on your computers, sandboxes, frameworks and skills, as in the web's Update Center"
order: 22
---
**用法:** `mf updates [command]`

**Option**

| Option | 用途 |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommand**

| 命令 | 用途 |
| --- | --- |
| [`mf updates list`](#mf-updates-list) | List pending updates and what each one needs |
| [`mf updates apply`](#mf-updates-apply) | Run pending updates: the ids given, or every one that can run from here |
| [`mf updates versions`](#mf-updates-versions) | Versions you can install, newest first: cli for the mf CLI or a framework name; without one, the latest of each |

## `mf updates list`

List pending updates and what each one needs

**用法:** `mf updates list [options]`

**Alias:** `ls`

**Option**

| Option | 用途 |
| --- | --- |
| `--kind <kind>` | only this kind of update 可选值: `cli`, `herdr`, `framework`, `cli-usage`, `skill`. |
| `--where <name\|id>` | only updates on this computer, sandbox, cloud computer, runtime or agent |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

## `mf updates apply`

Run pending updates: the ids given, or every one that can run from here

**用法:** `mf updates apply [options] [ids...]`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `[ids...]` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--kind <kind>` | only this kind of update 可选值: `cli`, `herdr`, `framework`, `cli-usage`, `skill`. |
| `--where <name\|id>` | only updates on this computer, sandbox, cloud computer, runtime or agent |
| `--to <version>` | the version to go to, for one update |
| `-y, --yes` | skip the confirmation prompt |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

## `mf updates versions`

Versions you can install, newest first: cli for the mf CLI or a framework name; without one, the latest of each

**用法:** `mf updates versions [options] [name]`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `[name]` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |
