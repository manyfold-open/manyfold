---
'@manyfold/cli': minor
---

`mf automations create` takes its schedule the way you would say it. `--schedule-preset daily` alone builds the rule, the same one the web's schedule picker builds, timed with `--at 17:30` (09:00 by default) and, for `weekly`, `--day fri`; an `--rrule` alone is a custom schedule; `--timezone` defaults to this machine's zone. Only `--title` and `--prompt` are required, where the preset, the RRULE and the timezone all had to be given and kept in step. `mf automations update --at 07:30` re-times the automation's own preset. `create` and `update` print the schedule and the next run on the automation's clock.
