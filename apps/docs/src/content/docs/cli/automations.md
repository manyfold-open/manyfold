---
title: Manage automations with the CLI
description: Create schedules, pause jobs, trigger runs, and inspect automation history.
order: 7
---
Automations run an agent prompt on a schedule or on demand. Select the agent
with `--agent-id` or `MF_AGENT_ID`.

## Create a schedule

```sh
mf automations create \
  --agent-id agt_xxx \
  --title "Weekday summary" \
  --prompt "Summarize open work and blockers." \
  --schedule-preset weekdays --at 09:00
```

Say when it runs with a preset: `hourly`, `daily`, `weekdays` or `weekly`,
timed with `--at HH:MM` (09:00 by default; `hourly` takes its minutes) and,
for `weekly`, `--day mon … sun`. For any other schedule, pass an iCalendar
`--rrule` instead; the preset is then `custom`, and `RRULE:` is an optional
prefix:

```sh
mf automations create \
  --agent-id agt_xxx \
  --title "Monthly review" \
  --prompt "Review last month's incidents." \
  --rrule 'FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=9;BYMINUTE=0'
```

The schedule keeps this machine's timezone unless `--timezone` names an IANA
zone such as `Europe/London`. Use optional ISO8601 `--dtstart` to control the
first occurrence. `create` prints the schedule and when it runs next.

Use `--model` only when this job should override the agent's normal model.

## Inspect and trigger

```sh
mf automations list --agent-id agt_xxx
mf automations get aut_xxx
mf automations run aut_xxx
```

`get` includes recent runs. `run` triggers one run immediately without changing
the saved schedule.

## Update, pause, or delete

```sh
mf automations update aut_xxx --status paused
mf automations update aut_xxx --status active
mf automations update aut_xxx --schedule-preset daily --at 18:00
mf automations update aut_xxx --at 07:30   # the same preset, another time
mf automations update aut_xxx --timezone UTC
mf automations update aut_xxx --clear-model
mf automations delete aut_xxx --yes
```

> **Warning:** Deletion is irreversible and the CLI refuses it without `--yes`;
> it does not open an interactive prompt. Use `--json` for scripts and verify
> the automation ID before mutation.

## See also

- [Scripting with mf](/docs/scripting/)
- [Query usage with the CLI](/docs/cli/usage/)
- [CLI command reference](/docs/cli/reference/)
