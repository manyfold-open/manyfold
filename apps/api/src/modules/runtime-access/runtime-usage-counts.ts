import {
    agentRuntimes,
    runtimeHosts,
    type Database
} from '@manyfold/db'
import { and, count, eq, inArray, ne, notExists, sql } from 'drizzle-orm'

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0]

// A platform-managed host and the per-framework runtimes `daemon register`
// creates inside it are the platform's own bring-up, not capacity the user
// asked for — they are already hidden from the user's lists, and counting them
// against the always-online limit is what deadlocks a full Free account (#804).
// Runtimes on a normal daemon host, and every k8s runtime, still count.
const notOnManagedHost = (db: Database | Tx) =>
    notExists(
        db
            .select({ one: sql`1` })
            .from(runtimeHosts)
            .where(
                and(
                    eq(runtimeHosts.id, agentRuntimes.daemonId),
                    eq(runtimeHosts.managed, true)
                )
            )
    )

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

export const usageCountsForUsers = async (
    db: Database,
    userIds: string[]
): Promise<Map<string, RuntimeUsageCounts>> => {
    const result = new Map<string, RuntimeUsageCounts>()
    if (userIds.length === 0) return result

    const [runtimeRows, daemonHostRows, spriteHostRows] = await Promise.all([
        db
            .select({
                userId: agentRuntimes.userId,
                kind: agentRuntimes.kind,
                value: count()
            })
            .from(agentRuntimes)
            .where(
                and(
                    inArray(agentRuntimes.userId, userIds),
                    ne(agentRuntimes.status, 'failed'),
                    notOnManagedHost(db)
                )
            )
            .groupBy(agentRuntimes.userId, agentRuntimes.kind),
        db
            .select({
                userId: runtimeHosts.userId,
                value: count()
            })
            .from(runtimeHosts)
            .where(
                and(
                    eq(runtimeHosts.kind, 'daemon'),
                    inArray(runtimeHosts.userId, userIds),
                    ne(runtimeHosts.status, 'revoked'),
                    eq(runtimeHosts.managed, false)
                )
            )
            .groupBy(runtimeHosts.userId),
        db
            .select({
                userId: runtimeHosts.userId,
                value: count()
            })
            .from(runtimeHosts)
            .where(
                and(
                    inArray(runtimeHosts.userId, userIds),
                    eq(runtimeHosts.kind, 'sandbox'),
                    eq(runtimeHosts.status, 'active')
                )
            )
            .groupBy(runtimeHosts.userId)
    ])

    const ensure = (userId: string): RuntimeUsageCounts => {
        let current = result.get(userId)
        if (!current) {
            current = emptyUsage()
            result.set(userId, current)
        }
        return current
    }

    for (const row of runtimeRows) {
        const usage = ensure(row.userId)
        const n = Number(row.value ?? 0)
        switch (row.kind) {
            case 'sprites':
                // counted per sandbox host in spriteHostRows below
                break
            case 'k8s':
                usage.alwaysOnlineRuntimesUsed += n
                usage.alwaysOnlineAgentsUsed += n
                usage.persistentContainersUsed += n
                break
            case 'daemon':
                usage.alwaysOnlineAgentsUsed += n
                break
            case 'external':
                break
        }
    }
    for (const row of daemonHostRows) {
        const usage = ensure(row.userId)
        const n = Number(row.value ?? 0)
        usage.alwaysOnlineRuntimesUsed += n
        usage.localDaemonsUsed += n
    }
    for (const row of spriteHostRows) {
        ensure(row.userId).statefulSandboxUsage = Number(row.value ?? 0)
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
                eq(runtimeHosts.kind, 'daemon'),
                eq(runtimeHosts.userId, userId),
                ne(runtimeHosts.status, 'revoked'),
                eq(runtimeHosts.managed, false)
            )
        )
    const [k8sRow] = await tx
        .select({ value: count() })
        .from(agentRuntimes)
        .where(
            and(
                eq(agentRuntimes.userId, userId),
                eq(agentRuntimes.kind, 'k8s'),
                ne(agentRuntimes.status, 'failed')
            )
        )
    const [agentsRow] = await tx
        .select({ value: count() })
        .from(agentRuntimes)
        .where(
            and(
                eq(agentRuntimes.userId, userId),
                ne(agentRuntimes.status, 'failed'),
                sql`${agentRuntimes.kind} IN ('daemon','k8s')`,
                notOnManagedHost(tx)
            )
        )
    return {
        runtimesUsed: Number(hostRow?.value ?? 0) + Number(k8sRow?.value ?? 0),
        agentsUsed: Number(agentsRow?.value ?? 0)
    }
}
