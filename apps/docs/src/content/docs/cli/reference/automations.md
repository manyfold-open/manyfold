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
| `--schedule-preset <preset>` | hourly \| daily \| weekdays \| weekly \| custom Required. |
| `--rrule <rrule>` | RRULE string (iCalendar) Required. |
| `--timezone <tz>` | IANA timezone (e.g. UTC) Required. |
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
