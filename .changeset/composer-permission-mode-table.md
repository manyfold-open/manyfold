---
'@manyfold/web': patch
---

Collapse the chat composer's four per-framework permission-mode option arrays and the parallel `canChoose`/options/active/dispatch ternary chains — plus AgentChat's four permission-mode states, storage helpers and handlers — into one framework-keyed table (`lib/permissionModes.ts`), pinned by `test/permissionModes.test.ts`. Adding a framework's selector is now one table entry instead of a fifth branch in each chain, and there is no silent wrong-dispatch arm to forget. Also routes the after-grant continue send through the same table, so a hermes/openclaw agent's chosen permission mode rides that resend as it already does the first send (previously only claude-code/codex did).
