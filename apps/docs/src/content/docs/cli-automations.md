---
title: Manage automations with the CLI
description: Create schedules, pause jobs, trigger runs, and inspect automation history.
order: 7
---

# Manage automations with the CLI

Automations run an agent prompt on a schedule or on demand. Select the agent
with `--agent-id` or `MF_AGENT_ID`.

## Create a schedule

```sh
mf automations create \
  --agent-id agt_xxx \
  --title "Weekday summary" \
  --prompt "Summarize open work and blockers." \
  --schedule-preset weekdays \
  --rrule 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0' \
  --timezone Europe/London
```

Presets are `hourly`, `daily`, `weekdays`, `weekly`, and `custom`. Every
schedule requires an iCalendar RRULE and an IANA timezone; `RRULE:` is an
optional prefix. Use optional ISO8601 `--dtstart` to control the first
occurrence:

```sh
mf automations create \
  --agent-id agt_xxx \
  --title "Monday review" \
  --prompt "Review last week's incidents." \
  --schedule-preset custom \
  --rrule 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0' \
  --timezone Europe/London
```

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
mf automations update aut_xxx --schedule-preset daily --timezone UTC
mf automations update aut_xxx --clear-model
mf automations delete aut_xxx --yes
```

Deletion is irreversible and the CLI refuses it without `--yes`; it does not
open an interactive prompt. Use `--json` for scripts and verify the automation
ID before mutation.

## See also

- [Scripting with mf](../scripting/)
- [Query usage with the CLI](../cli-usage/)
- [CLI command reference](../cli-reference/)
