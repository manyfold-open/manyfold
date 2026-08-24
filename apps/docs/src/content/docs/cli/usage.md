---
title: Query usage with the CLI
description: Read token and cost summaries, time series, events, sessions, and top agents.
order: 10
---
`mf usage` reads token and cost records. Its data commands emit JSON by
default, making them suitable for reporting and monitoring.

## Summary and time series

```sh
mf usage summary --from 2026-07-01T00:00:00Z --to 2026-08-01T00:00:00Z
mf usage summary --agent-id agt_xxx
mf usage timeseries --bucket day --from 2026-07-01T00:00:00Z
```

`--from` is inclusive and `--to` is exclusive. Filter by framework, runtime,
agent, or chat session with `--framework`, `--runtime-id`, `--agent-id`, and
`--session-id`.

## Events and pagination

```sh
mf usage events --limit 200 --framework claude-code
mf usage events --cursor '<next-cursor>'
```

The cursor is opaque. Pass it back unchanged; do not parse or derive it.

## Session and agent rankings

```sh
mf usage sessions --session-id ses_xxx
mf usage top-agents --limit 10
```

`top-agents` is account-wide and is denied for an agent-bound token. Use a
human/account credential with the required permission. Missing or unknown cost
data should remain unknown rather than being treated as zero.

## See also

- [Scripting with mf](/docs/scripting/)
- [Manage automations with the CLI](/docs/cli/automations/)
- [CLI command reference](/docs/cli/reference/)
