# mf usage — agent guide

## Purpose

Read token and cost usage statistics for the user's agents: window
aggregates, hour/day time series, raw paginated events, per-session
summaries, and a cross-agent ranking. Everything here is read-only.

## Required scopes

{{CALLER_CONTEXT}}

> Your **own** agent's usage needs no permission. In an agent runtime,
> `summary`, `timeseries`, `events` and `sessions` read the agent's own
> usage. `mf --account usage …` reads the whole account instead, or the
> agent `--agent-id` names, and needs `usage:read`. `top-agents` always
> ranks the whole account: in a runtime it is
> `mf --account usage top-agents`, with `usage:read`.

- `usage:read` — the account's usage and other agents' (`--account`); the
  agent's own usage is free.

For a scope denial, follow `mf help auth --agent` for the current identity.

## Common commands

`summary`, `timeseries`, `events`, and `sessions` share the filters
`--from <iso>` (inclusive), `--to <iso>` (exclusive),
`--framework <name>`, `--runtime-id <id>`, `--agent-id <id>`,
`--session-id <id>`.

```sh
mf usage summary --from <iso8601> --to <iso8601> --json
mf usage summary --agent-id <agent-id> --json
mf usage timeseries --bucket hour --from <iso8601> --json
mf usage events --limit 200 --framework claude-code --json
mf usage events --cursor <next-cursor-from-previous-page> --json
mf usage sessions --session-id <session-id> --json
mf usage top-agents --limit 10 --json
```

- `--from` and `--to` take a date (`2026-10-01`) or a date and time
  (`2026-10-01T09:00:00Z`, or with an offset such as `+01:00`); a time
  without a zone is UTC.
- `--bucket` (timeseries only) is `hour` or `day`; default `day`.
- `--framework` takes a framework id such as `openclaw`, `hermes`,
  `claude-code`, `codex`, `gemini-cli`, `pi` or `antigravity-cli`.
- `events --limit` is 1-200 (default 50); follow the returned
  `nextCursor` until it is `null`.
- `top-agents` ranks across all the user's agents (`--from`, `--to`,
  `--limit` 1-100, default 10); it is denied for agent-bound tokens.
- A value none of these take (`--bucket month`, `--limit 0`,
  `--from yesterday`) is refused with exit `5` before anything is sent. A
  `--cursor` the API did not give answers `400`, also exit `5`.
- Without `--account`, an agent's token reads only that agent: the other
  subcommands default to it when `--agent-id` is omitted, and a different
  `--agent-id` fails with `403` (`token bound to …, request targets …`).

## Output

Agents and scripts pass `--json`, which prints the API's payload unchanged.
`summary` returns token totals (`totalInputTokens`, `totalOutputTokens`,
cache tokens), `totalCostUsd` (may be `null`), `eventCount`, and a
`byModel` breakdown. `events` returns `items` plus `nextCursor`. Usage
output contains no secrets.

Without `--json` each subcommand prints a table for a person: `summary` a
totals line and a row per model, framework and runtime; `timeseries` a row
per UTC day or hour; `events` a row per call, with
`(more — continue with --cursor …)` on stderr when there is a next page;
`sessions` and `top-agents` a row each. An empty result is a note on
stderr, exit `0`. `mf usage` alone runs `summary`.

A failure goes to stderr and exits with the code for its kind: `5` for a
bad option or a `400`, `3` for a missing permission.

## Failure recovery

- "not authenticated" → `mf help auth --agent`
{{AUTH_RECOVERY}}
- `400 unknown framework: <name>` → use a framework value listed above
- empty results → widen or drop `--from`/`--to`
