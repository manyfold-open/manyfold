---
'@manyfold/shared': patch
'@manyfold/api': patch
'@manyfold/cli': patch
---

Lift the framework-neutral ACP decoders (event mapping, permission-request decode, session-state decode, model matching, stderr classifiers, auto-approve / reject option pickers) into `@manyfold/shared` so the API-side and daemon-side ACP clients share one copy. Pure internal refactor with no behaviour change: a live turn and a replayed turn now decode through exactly one implementation, closing the drift risk between the two hand-maintained copies.
