# mf usage — agent guide

## Purpose

Read token and cost usage statistics for the user's agents: window
aggregates, hour/day time series, raw paginated events, per-session
summaries, and a cross-agent ranking. Everything here is read-only.

## Required scopes

{{CALLER_CONTEXT}}

> Required **only for `--account`** (account-wide) usage (e.g. `top-agents`,
> or any subcommand with `--account`). Your **own** agent's usage (the
> default) needs no permission.

- `usage:read` — account-wide usage (`--account`); own-agent usage is free.

For a scope denial, follow `mf help auth --agent` for the current identity.

## Common commands

`summary`, `timeseries`, `events`, and `sessions` share the filters
`--from <iso>` (inclusive), `--to <iso>` (exclusive),
`--framework <name>`, `--runtime-id <id>`, `--agent-id <id>`,
`--session-id <id>`.

```sh
mf usage summary --from <iso8601> --to <iso8601>
mf usage summary --agent-id <agent-id>
mf usage timeseries --bucket hour --from <iso8601>
mf usage events --limit 200 --framework claude-code
mf usage events --cursor <next-cursor-from-previous-page>
mf usage sessions --session-id <session-id>
mf usage top-agents --limit 10
```

- `--bucket` (timeseries only) is `hour` or `day`; default `day`.
- `--framework` takes a framework id such as `openclaw`, `hermes`,
  `claude-code`, `codex`, `gemini-cli` or `pi`.
- `events --limit` is 1-200 (default 50); follow the returned
  `nextCursor` until it is `null`.
- `top-agents` ranks across all the user's agents (`--from`, `--to`,
  `--limit`, default 10); it is denied for agent-bound tokens.
- With an agent-bound token the other subcommands default to the bound
  agent when `--agent-id` is omitted; passing a different `--agent-id`
  fails with `403` (`token bound to …, request targets …`).

## Output

Every subcommand prints pretty-printed JSON to stdout; `--json` is
accepted but already the default — there is no table mode. `summary`
returns token totals (`totalInputTokens`, `totalOutputTokens`, cache
tokens), `totalCostUsd` (may be `null`), `eventCount`, and a `byModel`
breakdown. `events` returns `items` plus `nextCursor`. Usage output
contains no secrets. Errors print to stderr as `cli Error: …` and exit 1.

## Failure recovery

- "not authenticated" → `mf help auth --agent`
{{AUTH_RECOVERY}}
- `400 unknown framework: <name>` → use a framework value listed above
- empty results → widen or drop `--from`/`--to`; an unparseable ISO
  date is silently ignored (treated as no bound), not rejected
