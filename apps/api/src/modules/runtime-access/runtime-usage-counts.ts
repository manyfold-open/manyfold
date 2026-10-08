import type { RuntimeProviderKind } from '@manyfold/shared'
import {
    agentRuntimes,
    runtimeHosts,
    type Database
} from '@manyfold/db'
import { and, count, eq, inArray, ne, or, sql } from 'drizzle-orm'

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0]

// A hosted host that still occupies provider capacity: being created, usable,
// in maintenance (its machine still exists, it just failed the provider's
// health check), or waiting for its destroy to be confirmed. `failed` never
// got (or has already lost) its machine; `retired` is a local-host state.
export const HOSTED_LIVE_STATUSES = [
    'provisioning',
    'ready',
    'maintenance',
    'deleting'
] as const

// Composable predicates over runtime_hosts (ADR-0037 R1): a host's placement
// is its kind plus its provider's kind, never a column of its own.
export const hostedOnProviderKind = (kind: RuntimeProviderKind) =>
    sql`exists (select 1 from runtime_providers p where p.id = ${runtimeHosts.providerId} and p.kind = ${kind})`

export const liveHostedHosts = (kind: RuntimeProviderKind) =>
    and(
        eq(runtimeHosts.kind, 'hosted'),
        inArray(runtimeHosts.status, [...HOSTED_LIVE_STATUSES]),
        hostedOnProviderKind(kind)
    )

// A live hosted machine that is up. The concurrency caps, active-hours
// enforcement, the admin overview and the exec-session reaper all count this
// one set, keyed on the corrected power the status sync keeps.
export const runningHostedHosts = (kind: RuntimeProviderKind) =>
    and(liveHostedHosts(kind), eq(runtimeHosts.powerState, 'running'))

// The raw-SQL twins, for scalar subqueries that alias runtime_hosts as `h`.
// The status list is derived, so the twins cannot drift from the builders.
export const LIVE_SPRITES_HOST_SQL = `h.kind = 'hosted' and h.status in (${HOSTED_LIVE_STATUSES.map((status) => `'${status}'`).join(', ')}) and exists (select 1 from runtime_providers p where p.id = h.provider_id and p.kind = 'sprites')`

export const RUNNING_SPRITES_HOST_SQL = `${LIVE_SPRITES_HOST_SQL} and h.power_state = 'running'`

export const liveLocalHosts = () =>
    and(eq(runtimeHosts.kind, 'local'), ne(runtimeHosts.status, 'retired'))

// The hosts whose runtimes take always-online agent slots: the user's own
// computers and their cloud computers.
const alwaysOnlineHosts = () => or(liveLocalHosts(), liveHostedHosts('k8s'))

export interface RuntimeUsageCounts {
    statefulSandboxUsage: number
    alwaysOnlineRuntimesUsed: number
    alwaysOnlineAgentsUsed: number
    persistentContainersUsed: number
    localDaemonsUsed: number
}

export const emptyUsage = (): RuntimeUsageCounts => ({
    statefulSandboxUsage: 0,
    alwaysOnlineRuntimesUsed: 0,
    alwaysOnlineAgentsUsed: 0,
    persistentContainersUsed: 0,
    localDaemonsUsed: 0
})

// A local host is the always-online runtime and each framework on it an
// always-online agent slot; a pod host (ADR-0035) is metered the same way and
// is also the persistent container. A sandbox is metered per VM.
export const usageCountsForUsers = async (
    db: Database,
    userIds: string[]
): Promise<Map<string, RuntimeUsageCounts>> => {
    const result = new Map<string, RuntimeUsageCounts>()
    if (userIds.length === 0) return result

    const [localHostRows, spriteHostRows, podHostRows, runtimeRows] =
        await Promise.all([
            db
                .select({ userId: runtimeHosts.userId, value: count() })
                .from(runtimeHosts)
                .where(
                    and(inArray(runtimeHosts.userId, userIds), liveLocalHosts())
                )
                .groupBy(runtimeHosts.userId),
            db
                .select({ userId: runtimeHosts.userId, value: count() })
                .from(runtimeHosts)
                .where(
                    and(
                        inArray(runtimeHosts.userId, userIds),
                        liveHostedHosts('sprites')
                    )
                )
                .groupBy(runtimeHosts.userId),
            db
                .select({ userId: runtimeHosts.userId, value: count() })
                .from(runtimeHosts)
                .where(
                    and(
                        inArray(runtimeHosts.userId, userIds),
                        liveHostedHosts('k8s')
                    )
                )
                .groupBy(runtimeHosts.userId),
            db
                .select({ userId: agentRuntimes.userId, value: count() })
                .from(agentRuntimes)
                .innerJoin(runtimeHosts, eq(runtimeHosts.id, agentRuntimes.hostId))
                .where(
                    and(
                        inArray(agentRuntimes.userId, userIds),
                        ne(agentRuntimes.status, 'failed'),
                        alwaysOnlineHosts()
                    )
                )
                .groupBy(agentRuntimes.userId)
        ])

    const ensure = (userId: string): RuntimeUsageCounts => {
        let current = result.get(userId)
        if (!current) {
            current = emptyUsage()
            result.set(userId, current)
        }
        return current
    }

    for (const row of runtimeRows)
        ensure(row.userId).alwaysOnlineAgentsUsed += Number(row.value ?? 0)
    for (const row of localHostRows) {
        const usage = ensure(row.userId)
        const n = Number(row.value ?? 0)
        usage.alwaysOnlineRuntimesUsed += n
        usage.localDaemonsUsed += n
    }
    for (const row of spriteHostRows)
        ensure(row.userId).statefulSandboxUsage = Number(row.value ?? 0)
    for (const row of podHostRows) {
        const usage = ensure(row.userId)
        const n = Number(row.value ?? 0)
        usage.alwaysOnlineRuntimesUsed += n
        usage.persistentContainersUsed += n
    }
    return result
}

export const alwaysOnlineUsageInTx = async (
    tx: Tx,
    userId: string
): Promise<{ runtimesUsed: number; agentsUsed: number }> => {
    const [hostRow] = await tx
        .select({ value: count() })
        .from(runtimeHosts)
        .where(
            and(
                eq(runtimeHosts.userId, userId),
                or(liveLocalHosts(), liveHostedHosts('k8s'))
            )
        )
    const [agentsRow] = await tx
        .select({ value: count() })
        .from(agentRuntimes)
        .innerJoin(runtimeHosts, eq(runtimeHosts.id, agentRuntimes.hostId))
        .where(
            and(
                eq(agentRuntimes.userId, userId),
                ne(agentRuntimes.status, 'failed'),
                alwaysOnlineHosts()
            )
        )
    return {
        runtimesUsed: Number(hostRow?.value ?? 0),
        agentsUsed: Number(agentsRow?.value ?? 0)
    }
}
