import { and, eq, inArray } from 'drizzle-orm'
import { agentRuntimes, runtimeHosts, type Database } from '@manyfold/db'
import { runnerHostName } from '@manyfold/shared'

// A sprite-runner is the `mf daemon` we start inside a sandbox VM to dispatch
// coding-agent turns over the daemon protocol. It registers as its OWN managed
// daemon host (`runtime_hosts.kind='daemon'`, `managed=true`, name
// `sprite-runner:<spriteName>`), and its runtimes hang off `daemon_id` with
// `host_id` null. Every sandbox emptiness/teardown check is scoped to
// `agent_runtimes.host_id = <sandbox host>`, so the runner is invisible to them:
// deleting or reaping the sandbox VM would strand the runner host, its runtimes
// and any agent reconcile adopted onto them (`agent_runtimes.daemon_id ->
// runtime_hosts` is ON DELETE SET NULL, so even removing the host only orphans
// them further). Callers that remove a sandbox VM must remove its runner too.
//
// Deleting the runtimes cascades their agents (`agents.runtime_id` ON DELETE
// CASCADE) and deleting the host cascades its `daemon_tokens` — the same shape
// DaemonHostService.deleteRevoked relies on.
export const deleteSpriteRunnerHostForSprite = async (
    db: Database,
    userId: string,
    spriteName: string
): Promise<void> => {
    const runners = await db
        .select({ id: runtimeHosts.id })
        .from(runtimeHosts)
        .where(
            and(
                eq(runtimeHosts.userId, userId),
                eq(runtimeHosts.kind, 'daemon'),
                eq(runtimeHosts.managed, true),
                eq(runtimeHosts.name, runnerHostName(spriteName))
            )
        )
    if (runners.length === 0) return
    const runnerIds = runners.map((r) => r.id)
    await db
        .delete(agentRuntimes)
        .where(inArray(agentRuntimes.daemonId, runnerIds))
    await db.delete(runtimeHosts).where(inArray(runtimeHosts.id, runnerIds))
}
