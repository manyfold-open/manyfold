---
'@manyfold/cli': minor
---

Inside an agent runtime, `mf --account usage summary`, `timeseries`, `events` and `sessions` read the whole account, as `--account` says. Before, they kept the runtime's own agent (`$MF_AGENT_ID`) as a filter, so `--account` changed nothing. An `--agent-id` typed on the command line still filters.
