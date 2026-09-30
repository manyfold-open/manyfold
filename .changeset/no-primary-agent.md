---
'@manyfold/api': major
'@manyfold/web': minor
'@manyfold/admin': minor
---

A runtime no longer has a primary agent. On a sandbox or a cloud computer, the agent a service framework always has — Hermes' `default` profile, OpenClaw's `main` agent — is stored under that name, so the runtime page shows the same name as the framework's own dashboard, and the reconcile knows that agent by its id like any other.

- **Deleting agents.** The framework's own agent stays while any other agent is on its runtime; delete those first, or delete the runtime (409 `BUILT_IN_AGENT_NOT_LAST`). On a sandbox or a cloud computer, deleting a runtime's last agent tears the runtime down, with the sandbox kept for reuse. No agent is promoted in place of a deleted one.
- **Joining a prepared runtime.** The first agent to join a service runtime prepared with no agent takes the framework's own profile on a sandbox too, as on a cloud computer.
- **Framework versions belong to the runtime.** `POST /agent-runtimes/:id/framework-version/refresh`, `/upgrade` and `/upgrade-stream` (and their `/admin/agent-runtimes` twins) replace the `/agents/:id/framework-version/*` routes, need the `agent-runtimes:edit` scope, and return the runtime; the stream's `complete` event carries `runtime`. A runtime with no agent on it can be upgraded.
- **API shape.** `primaryAgentId` is gone from the runtime summary, and the web and admin no longer show a primary agent or a Primary tag.
- **Migration.** Each sandbox and cloud computer runtime's existing primary for Hermes or OpenClaw is re-keyed to `default` or `main`; the `primary_agent_id` columns are dropped.
