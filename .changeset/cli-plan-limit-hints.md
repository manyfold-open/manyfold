---
'@manyfold/cli': minor
---

A plan limit or quota no longer tells you to check your token's scopes. `CHANNEL_LIMIT_REACHED` and the other limit and quota codes each get a hint with the numbers, `(2 of 2 on the Free plan)`, and what to free up, for example `mf channels delete <id>`. Any other `*_LIMIT_REACHED` / `*_QUOTA_REACHED` code gets a generic plan-limit hint. `--json` passes their `details` through. They still exit `3`, like every `403`.
