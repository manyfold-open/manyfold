import { ConflictException } from '@nestjs/common'
import type { Database } from '@manyfold/db'
import { sql } from 'drizzle-orm'

// Lock the physical installation, not the agent addressing it. Transaction
// ownership spans API replicas and releases on either success or failure.
export const withRuntimeUpgradeLock = async <T>(
    db: Database,
    target: { accountId: string; spriteName: string; component: string },
    work: () => Promise<T>
): Promise<T> => {
    const key = JSON.stringify([
        'runtime-upgrade',
        target.accountId,
        target.spriteName,
        target.component
    ])
    return db.transaction(async (tx) => {
        const [lock] = await tx.execute<{ acquired: boolean }>(
            sql`select pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) as acquired`
        )
        if (!lock.acquired)
            throw new ConflictException({
                code: 'UPGRADE_IN_PROGRESS',
                message: 'An upgrade is already in progress for this target'
            })
        return work()
    })
}
