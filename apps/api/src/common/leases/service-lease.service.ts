import { Inject, Injectable } from '@nestjs/common'
import { and, eq, lt, or } from 'drizzle-orm'
import { serviceLeases, type Database } from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'

// Single-leader election for background loops that must run on exactly one
// API instance. Same TTL-takeover semantics as the channel leases: acquiring
// succeeds when the row is ours or expired; a crashed/stopped leader is taken
// over after the TTL lapses, and a clean shutdown releases immediately.
@Injectable()
export class ServiceLeaseService {
    constructor(@Inject(DRIZZLE) private readonly db: Database) {}

    async tryAcquireOrRenew(
        name: string,
        holderId: string,
        ttlMs: number
    ): Promise<boolean> {
        const now = new Date()
        const expiresAt = new Date(now.getTime() + ttlMs)
        const rows = await this.db
            .insert(serviceLeases)
            .values({
                name,
                holderId,
                acquiredAt: now,
                expiresAt,
                updatedAt: now
            })
            .onConflictDoUpdate({
                target: serviceLeases.name,
                set: { holderId, expiresAt, updatedAt: now },
                setWhere: or(
                    eq(serviceLeases.holderId, holderId),
                    lt(serviceLeases.expiresAt, now)
                )
            })
            .returning({ name: serviceLeases.name })
        return rows.length > 0
    }

    async release(name: string, holderId: string): Promise<void> {
        await this.db
            .delete(serviceLeases)
            .where(
                and(
                    eq(serviceLeases.name, name),
                    eq(serviceLeases.holderId, holderId)
                )
            )
    }
}
