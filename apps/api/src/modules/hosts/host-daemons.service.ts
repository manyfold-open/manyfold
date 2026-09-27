import { Inject, Injectable } from '@nestjs/common'
import { eq, inArray } from 'drizzle-orm'
import { daemonOnline } from '@manyfold/shared'
import {
    hostDaemons,
    type Database,
    type HostDaemonRow,
    type NewHostDaemonRow
} from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'

// The one daemon connection a host has (ADR-0037). Presence is derived from
// lastSeenAt; there is no status column and no sweep.
// The API holds a socket to this daemon somewhere (the registry writes the
// lease on connect and clears it on an orderly close). This, not presence,
// is what a dispatch decision reads: a heartbeat outlives a closed socket by
// up to the presence window, a lease does not (ADR-0038).
export const hasRpcLease = (
    daemon: HostDaemonRow | null | undefined
): daemon is HostDaemonRow =>
    Boolean(daemon?.rpcInstanceId && daemon.rpcConnectedAt)

@Injectable()
export class HostDaemonsService {
    constructor(@Inject(DRIZZLE) private readonly db: Database) {}

    async findByHostId(hostId: string): Promise<HostDaemonRow | null> {
        const [row] = await this.db
            .select()
            .from(hostDaemons)
            .where(eq(hostDaemons.hostId, hostId))
            .limit(1)
        return row ?? null
    }

    async findByHostIds(hostIds: string[]): Promise<Map<string, HostDaemonRow>> {
        const out = new Map<string, HostDaemonRow>()
        if (hostIds.length === 0) return out
        const rows = await this.db
            .select()
            .from(hostDaemons)
            .where(inArray(hostDaemons.hostId, hostIds))
        for (const row of rows) out.set(row.hostId, row)
        return out
    }

    isOnline(row: HostDaemonRow | null | undefined): boolean {
        return daemonOnline(row)
    }

    async upsert(
        hostId: string,
        values: Omit<NewHostDaemonRow, 'hostId'>,
        db: Pick<Database, 'insert'> = this.db
    ): Promise<HostDaemonRow> {
        const now = new Date()
        const [row] = await db
            .insert(hostDaemons)
            .values({ ...values, hostId, updatedAt: now })
            .onConflictDoUpdate({
                target: hostDaemons.hostId,
                set: { ...values, updatedAt: now }
            })
            .returning()
        return row
    }

    async patch(
        hostId: string,
        patch: Partial<Omit<HostDaemonRow, 'hostId'>>
    ): Promise<HostDaemonRow | null> {
        const [row] = await this.db
            .update(hostDaemons)
            .set(patch)
            .where(eq(hostDaemons.hostId, hostId))
            .returning()
        return row ?? null
    }

    async deleteByHostId(
        hostId: string,
        db: Pick<Database, 'delete'> = this.db
    ): Promise<void> {
        await db.delete(hostDaemons).where(eq(hostDaemons.hostId, hostId))
    }
}
