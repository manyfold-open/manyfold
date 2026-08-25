---
title: "mf usage"
description: "Read token + cost usage statistics"
order: 14
---
**Usage:** `mf usage [command]`

**Options**

| Options | Purpose |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommands**

| Command | Purpose |
| --- | --- |
| [`mf usage summary`](#mf-usage-summary) | Aggregate usage in a window |
| [`mf usage timeseries`](#mf-usage-timeseries) | Bucketed usage time series |
| [`mf usage events`](#mf-usage-events) | Paginated usage events |
| [`mf usage sessions`](#mf-usage-sessions) | Per-session usage summaries |
| [`mf usage top-agents`](#mf-usage-top-agents) | Rank agents by usage (cross-agent — denied for bound tokens) |

## `mf usage summary`

Aggregate usage in a window

**Usage:** `mf usage summary [options]`

**Options**

| Options | Purpose |
| --- | --- |
| `--from <iso>` | inclusive start (ISO8601) |
| `--to <iso>` | exclusive end (ISO8601) |
| `--framework <name>` | filter by framework |
| `--runtime-id <id>` | filter by runtime |
| `--agent-id <id>` | filter by agent |
| `--session-id <id>` | filter by chat session |
| `--json` | emit raw JSON (default) |
| `-h, --help` | display help for command |

## `mf usage timeseries`

Bucketed usage time series

**Usage:** `mf usage timeseries [options]`

**Options**

| Options | Purpose |
| --- | --- |
| `--from <iso>` | inclusive start (ISO8601) |
| `--to <iso>` | exclusive end (ISO8601) |
| `--framework <name>` | filter by framework |
| `--runtime-id <id>` | filter by runtime |
| `--agent-id <id>` | filter by agent |
| `--session-id <id>` | filter by chat session |
| `--json` | emit raw JSON (default) |
| `--bucket <bucket>` | hour \| day (default: day) |
| `-h, --help` | display help for command |

## `mf usage events`

Paginated usage events

**Usage:** `mf usage events [options]`

**Options**

| Options | Purpose |
| --- | --- |
| `--from <iso>` | inclusive start (ISO8601) |
| `--to <iso>` | exclusive end (ISO8601) |
| `--framework <name>` | filter by framework |
| `--runtime-id <id>` | filter by runtime |
| `--agent-id <id>` | filter by agent |
| `--session-id <id>` | filter by chat session |
| `--json` | emit raw JSON (default) |
| `--cursor <cursor>` | opaque cursor from previous page |
| `--limit <n>` | page size (1-200, default 50) |
| `-h, --help` | display help for command |

## `mf usage sessions`

Per-session usage summaries

**Usage:** `mf usage sessions [options]`

**Options**

| Options | Purpose |
| --- | --- |
| `--from <iso>` | inclusive start (ISO8601) |
| `--to <iso>` | exclusive end (ISO8601) |
| `--framework <name>` | filter by framework |
| `--runtime-id <id>` | filter by runtime |
| `--agent-id <id>` | filter by agent |
| `--session-id <id>` | filter by chat session |
| `--json` | emit raw JSON (default) |
| `-h, --help` | display help for command |

## `mf usage top-agents`

Rank agents by usage (cross-agent — denied for bound tokens)

**Usage:** `mf usage top-agents [options]`

**Options**

| Options | Purpose |
| --- | --- |
| `--from <iso>` | inclusive start |
| `--to <iso>` | exclusive end |
| `--limit <n>` | top N (default 10) |
| `--json` | emit raw JSON (default) |
| `-h, --help` | display help for command |
