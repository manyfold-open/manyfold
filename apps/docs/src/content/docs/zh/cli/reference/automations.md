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
| [`mf automations result`](#mf-automations-result) | Print a run's reply, or why it failed: the latest run's, or --run's (a run still going is followed to its end) |
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

**用法:** `mf automations run [options] <id>`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<id>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--wait` | follow the run's reply as it streams, then say how the run ended (Ctrl-C stops following; the run goes on) |
| `--show-thinking` | with --wait, print the agent's thinking, dim on stderr (with --json: a thinking field) |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

## `mf automations result`

Print a run's reply, or why it failed: the latest run's, or --run's (a run still going is followed to its end)

**用法:** `mf automations result [options] <id>`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<id>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--run <runId>` | this run instead of the latest; one of the 20 latest, which mf automations get lists |
| `--show-thinking` | print the agent's thinking, dim on stderr (with --json: a thinking field) |
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
