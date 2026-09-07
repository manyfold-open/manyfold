---
'@manyfold/api': patch
'@manyfold/cli': patch
---

Lift the framework-neutral ACP decoders (event mapping, permission-request decode, session-state decode, model matching, stderr classifiers, auto-approve / reject option pickers) into `@manyfold/shared` so the API-side and daemon-side ACP clients share one copy, and introduce an `AcpDialect` seam (error prefix, log tag, legacy auto-approve id, optional session/prompt `_meta`) so a second framework plugs into the same client. The API ACP client class is now `AcpTurn` (dialect-taking), with `HermesAcpTurn` kept as an alias. Pure internal refactor with no behaviour change: a live turn and a replayed turn decode through exactly one implementation, and hermes keeps its byte-identical error strings and defaults.
