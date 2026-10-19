---
'@manyfold/api': minor
---

Admins can list every machine in a runtime provider's account, not only the ones a sandbox here points at. `GET /admin/runtime-providers/:id/machines` lists them, with the sandbox and owner for each one that is tracked. Each machine can be restarted, upgraded or deleted by name: `POST …/machines/:name/restart`, `POST …/machines/:name/upgrade` (progress streamed as NDJSON) and `DELETE …/machines/:name`. `GET …/machines/:name/actions` returns the admin actions recently taken on it. Deleting a machine that backs a sandbox deletes the sandbox, and is refused while agents remain on it. Every action is audited. An upgrade's audit row records the version it started from, which sprites.dev does not keep and a rollback needs. Runtime provider summaries now say which of these a provider supports, in `capabilities`.
