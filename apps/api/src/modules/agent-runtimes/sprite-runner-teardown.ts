import { and, eq, inArray } from 'drizzle-orm'
import { agentRuntimes, runtimeHosts, type Database } from '@manyfold/db'
import { podRunnerHostName, runnerHostName } from '@manyfold/shared'

// A managed runner is an `mf daemon` the platform puts inside execution capacity
// it owns, so a turn can ride the daemon protocol instead of that capacity's own
// exec transport. There are two: the sprite-runner we install into a sandbox VM,
// and the pod-runner that ships in a k8s agent image.
//
// Both register as their OWN managed daemon host (`runtime_hosts.kind='daemon'`,
// `managed=true`) under a platform-set name, and both hang their runtimes off
// `daemon_id` with `host_id` null. Every emptiness/teardown check for the
// underlying capacity is scoped to the capacity's own row — the sandbox host id
// for a sprite, the `agent_runtimes` row for a pod — so the runner is invisible
// to them: removing the capacity would strand the runner host, its runtimes and
// any agent reconcile adopted onto them (`agent_runtimes.daemon_id ->
// runtime_hosts` is ON DELETE SET NULL, so even removing the host only orphans
// them further). Callers that remove the capacity must remove its runner too.
//
// Deleting the runtimes cascades their agents (`agents.runtime_id` ON DELETE
// CASCADE) and deleting the host cascades its `daemon_tokens` — the same shape
// DaemonHostService.deleteRevoked relies on.
const deleteManagedRunnerHostByName = async (
    db: Database,
    userId: string,
    hostName: string
): Promise<void> => {
    const runners = await db
        .select({ id: runtimeHosts.id })
        .from(runtimeHosts)
        .where(
            and(
                eq(runtimeHosts.userId, userId),
                eq(runtimeHosts.kind, 'daemon'),
                eq(runtimeHosts.managed, true),
                eq(runtimeHosts.name, hostName)
            )
        )
    if (runners.length === 0) return
    const runnerIds = runners.map((r) => r.id)
    await db
        .delete(agentRuntimes)
        .where(inArray(agentRuntimes.daemonId, runnerIds))
    await db.delete(runtimeHosts).where(inArray(runtimeHosts.id, runnerIds))
}

export const deleteSpriteRunnerHostForSprite = async (
    db: Database,
    userId: string,
    spriteName: string
): Promise<void> =>
    deleteManagedRunnerHostByName(db, userId, runnerHostName(spriteName))

// The pod twin. Keyed by runtime id rather than by a VM name because the pod is
// created before any agent exists and is addressed by its runtime row
// throughout — see podRunnerHostName.
export const deletePodRunnerHostForRuntime = async (
    db: Database,
    userId: string,
    runtimeId: string
): Promise<void> =>
    deleteManagedRunnerHostByName(db, userId, podRunnerHostName(runtimeId))
