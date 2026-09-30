---
title: "mf automations"
description: "Manage scheduled automations"
order: 6
---
**Usage:** `mf automations [command]`

**Options**

| Options | Purpose |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommands**

| Command | Purpose |
| --- | --- |
| [`mf automations list`](#mf-automations-list) | List automations (optionally filter by agent) |
| [`mf automations get`](#mf-automations-get) | Show a single automation (with recent runs) |
| [`mf automations create`](#mf-automations-create) | Create a new automation |
| [`mf automations update`](#mf-automations-update) | Update an existing automation |
| [`mf automations run`](#mf-automations-run) | Trigger an automation run now |
| [`mf automations delete`](#mf-automations-delete) | Delete an automation |

## `mf automations list`

List automations (optionally filter by agent)

**Usage:** `mf automations list [options]`

**Aliases:** `ls`

**Options**

| Options | Purpose |
| --- | --- |
| `--agent-id <id>` | filter to this agent |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

## `mf automations get`

Show a single automation (with recent runs)

**Usage:** `mf automations get [options] <id>`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<id>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--json` | emit raw JSON (default) |
| `-h, --help` | display help for command |

## `mf automations create`

Create a new automation

**Usage:** `mf automations create [options]`

**Options**

| Options | Purpose |
| --- | --- |
| `--agent-id <id>` | agent id to run as (defaults to $MF_AGENT_ID) |
| `--title <title>` | short title Required. |
| `--prompt <prompt>` | prompt body Required. |
| `--schedule-preset <preset>` | hourly \| daily \| weekdays \| weekly (timed with --at, and --day for weekly); custom goes with --rrule |
| `--at <time>` | time of day for a preset, HH:MM (default 09:00) |
| `--day <weekday>` | weekday for the weekly preset, mon … sun (default mon) |
| `--rrule <rrule>` | iCalendar RRULE for a custom schedule (the preset is then custom) |
| `--timezone <tz>` | IANA timezone the schedule keeps (default: this machine's) |
| `--dtstart <iso>` | first run start (ISO8601) |
| `--model <model>` | model override |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

## `mf automations update`

Update an existing automation

**Usage:** `mf automations update [options] <id>`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<id>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--title <title>` | new title |
| `--prompt <prompt>` | new prompt |
| `--status <status>` | active \| paused |
| `--schedule-preset <preset>` | hourly \| daily \| weekdays \| weekly (timed with --at, and --day for weekly); custom goes with --rrule |
| `--at <time>` | new time of day, HH:MM; alone it re-times the current preset |
| `--day <weekday>` | new weekday for the weekly preset |
| `--rrule <rrule>` | new RRULE (the preset is then custom) |
| `--timezone <tz>` | new IANA timezone |
| `--dtstart <iso>` | new dtstart |
| `--model <model>` | new model override |
| `--clear-model` | clear model override |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

## `mf automations run`

Trigger an automation run now

**Usage:** `mf automations run [options] <id>`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<id>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

## `mf automations delete`

Delete an automation

**Usage:** `mf automations delete [options] <id>`

**Aliases:** `rm`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<id>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `-y, --yes` | confirm deletion |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |
