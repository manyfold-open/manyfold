# mf automations — agent guide

## Purpose

Manage scheduled automations: recurring prompts that run against an agent
on an iCalendar RRULE schedule. Recent run history is included in `get`.

## Scope

{{CALLER_CONTEXT}}

- **Your own agent** (the default — `--agent-id $MF_AGENT_ID`): **no permission
  needed**. List/get/create/update/run/delete your own automations freely.
- **The whole account** (`--account`): acts across ALL your agents and needs a
  user grant — `automations:read` for `list`/`get`, `automations:edit` for
  `create`/`update`/`run`/`delete`. Missing it? the command prints a consent
  URL — post it to the user, they approve, then retry (`mf help auth --agent`).

## Common commands

```sh
mf automations list --json                      # your own agent (no scope)
mf automations list --account --json            # ALL your agents (needs grant)
mf automations get <automation-id>
mf automations create --agent-id $MF_AGENT_ID --title <title> \
  --prompt <prompt> --schedule-preset daily --at 09:00
mf automations create --agent-id $MF_AGENT_ID --title <title> \
  --prompt <prompt> --rrule 'FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=9'
mf automations update <automation-id> --status paused
mf automations update <automation-id> --schedule-preset weekly --day mon \
  --at 08:00 --timezone Europe/London
mf automations run <automation-id> --json
mf automations delete <automation-id> --yes
```

- Say when it runs once: `--schedule-preset hourly | daily | weekdays |
  weekly`, timed with `--at HH:MM` (default 09:00; hourly takes the
  minutes) and, weekly, `--day mon … sun`; or an iCalendar `--rrule` (NOT
  cron; the preset is then `custom`; `RRULE:` optional; single line; must
  yield a future occurrence). Both together are taken as given.
- `update --at` or `--day` alone re-times the automation's own preset.
- `--timezone` is an IANA name (e.g. `UTC`), defaulting to this machine's
  zone; `--dtstart <iso>` sets the first run start (ISO8601, defaults to
  now).
- `--model <model>` overrides the agent model; `--clear-model` (update
  only) removes it. `update` also takes `--title` and `--prompt`.

## Output

- `list`: one line per automation — `id title status preset agentId`;
  `--json` for raw data.
- `get`: always raw JSON — automation detail plus a `runs` array.
- `create` / `update`: `id title status schedule (timezone) · next <time>`,
  the next run on the automation's clock; `--json` for full detail.
- `run`: `id trigger status` — status starts `running`, later
  `succeeded` or `failed`; `--json` available.
- `delete`: prints `✓ deleted <id>`; `--json` emits `{ ok, id }`. No
  secrets appear in this output.

## Failure recovery

- "not authenticated" → `mf help auth --agent`
{{AUTH_RECOVERY}}
- `400` "invalid rrule: …" → fix RRULE syntax (iCalendar, single line)
- `400` "invalid timezone" → use an IANA timezone name
- `400` "schedule has no future occurrence" → rrule + dtstart never fire
  again; adjust the schedule
- "nothing to update" → pass at least one update flag
- "refusing to delete … without --yes" → re-run with `--yes` (or `-y`)
- run `failed` → `mf automations get <id>`, inspect `runs[].errorMessage`
