---
'@manyfold/cli': minor
---

`mf usage` checks its options before it sends anything, and a bad one exits `5`. `--bucket` takes `hour` or `day`; before, `--bucket month` quietly gave days. `--limit` is a whole number from 1 to 200 for `events` and from 1 to 100 for `top-agents`; before, `--limit abc` returned an empty page, and a limit over the maximum was capped. `--from` and `--to` take a date or a date and time such as `2026-10-01` or `2026-10-01T09:00:00Z`, where a time without a zone is UTC; before, one the API could not read was dropped. `mf mcp catalog list` and `mf skills discover` take `--limit` 1 to 100 the same way.
