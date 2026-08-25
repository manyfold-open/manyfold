---
title: "mf automations"
description: "Manage scheduled automations"
order: 6
---
**用法:** `mf automations [command]`

**Option**

| Option | 用途 |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommand**

| 命令 | 用途 |
| --- | --- |
| [`mf automations list`](#mf-automations-list) | List automations (optionally filter by agent) |
| [`mf automations get`](#mf-automations-get) | Show a single automation (with recent runs) |
| [`mf automations create`](#mf-automations-create) | Create a new automation |
| [`mf automations update`](#mf-automations-update) | Update an existing automation |
| [`mf automations run`](#mf-automations-run) | Trigger an automation run now |
| [`mf automations delete`](#mf-automations-delete) | Delete an automation |

## `mf automations list`

List automations (optionally filter by agent)

**用法:** `mf automations list [options]`

**Alias:** `ls`

**Option**

| Option | 用途 |
| --- | --- |
| `--agent-id <id>` | filter to this agent |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

## `mf automations get`

Show a single automation (with recent runs)

**用法:** `mf automations get [options] <id>`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<id>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--json` | emit raw JSON (default) |
| `-h, --help` | display help for command |

## `mf automations create`

Create a new automation

**用法:** `mf automations create [options]`

**Option**

| Option | 用途 |
| --- | --- |
| `--agent-id <id>` | agent id to run as (defaults to $MF_AGENT_ID) |
| `--title <title>` | short title 必填。 |
| `--prompt <prompt>` | prompt body 必填。 |
| `--schedule-preset <preset>` | hourly \| daily \| weekdays \| weekly \| custom 必填。 |
| `--rrule <rrule>` | RRULE string (iCalendar) 必填。 |
| `--timezone <tz>` | IANA timezone (e.g. UTC) 必填。 |
| `--dtstart <iso>` | first run start (ISO8601) |
| `--model <model>` | model override |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

## `mf automations update`

Update an existing automation

**用法:** `mf automations update [options] <id>`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<id>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--title <title>` | new title |
| `--prompt <prompt>` | new prompt |
| `--status <status>` | active \| paused |
| `--schedule-preset <preset>` | hourly \| daily \| weekdays \| weekly \| custom |
| `--rrule <rrule>` | new RRULE |
| `--timezone <tz>` | new IANA timezone |
| `--dtstart <iso>` | new dtstart |
| `--model <model>` | new model override |
| `--clear-model` | clear model override |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

## `mf automations run`

Trigger an automation run now

**用法:** `mf automations run [options] <id>`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<id>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

## `mf automations delete`

Delete an automation

**用法:** `mf automations delete [options] <id>`

**Alias:** `rm`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<id>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `-y, --yes` | confirm deletion |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |
