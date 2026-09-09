---
'@manyfold/api': minor
'@manyfold/cli': minor
---

Runtime auth profiles (P2, execution contract): an agent can be bound to one of its runtime's auth profiles (`PATCH /agents/:id/runtime-auth`, compare-and-set on a binding version; also at create/attach via `runtimeAuthProfileId`), and every execution for that agent — chat turns over the daemon or the sprite runner, the agent terminal, and the model-capability probe — then runs inside that profile's credential context. The daemon (capability `auth-context.v1`) composes the context itself from an opaque `authSelection`: the profile's own credential files, every ambient vendor variable stripped from both the machine environment and the agent's extras, codex's state databases pinned to the native home, and the profile lock held for the process's lifetime so same-profile work runs serially. A host that cannot honour the selection (a bare sandbox without its runner, a pod, or an older mf CLI) refuses the execution rather than answering with the machine's native sign-in. Switching takes effect for the next execution; a turn already running keeps the context it started with.
