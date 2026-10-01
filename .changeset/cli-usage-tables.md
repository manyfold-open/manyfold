---
'@manyfold/cli': minor
---

`mf usage` prints tables. `summary` shows a totals line and a row per model, framework and runtime, `timeseries` a row per UTC day or hour, `events` a row per call with the cursor for the next page, and `sessions` and `top-agents` a row each. A cost the platform could not price shows as unknown, and an empty window is a note, not an empty array. `mf usage` on its own runs `summary`, and a mistyped subcommand such as `mf usage sumary` is refused instead of running it. The JSON is unchanged, but it is no longer the default: a script or agent that reads `mf usage` output must pass `--json`.
