---
'@manyfold/api': major
'@manyfold/web': minor
---

Remove the retired k8s dashboard's `dashboardUrl` field from runtime summaries
and the exported `AgentRuntimeSummary` type. The field always returned null;
sprite dashboards continue to use the existing control-ui URL endpoint.

All web sign-in methods now accept only internal redirect paths. Remove
`VITE_DASHBOARD_ORIGIN_SUFFIXES` and `MF_SELFHOST_DASHBOARD_SUFFIXES` from build
configuration; the retired dashboard redirect flow no longer uses them.
