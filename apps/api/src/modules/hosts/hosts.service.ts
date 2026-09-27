import { Inject, Injectable } from '@nestjs/common'
import { and, eq, sql } from 'drizzle-orm'
import {
    runtimeHosts,
    type Database,
    type NewRuntimeHostRow,
    type RuntimeHostKind,
    type RuntimeHostPowerState,
    type RuntimeHostProviderRef,
    type RuntimeHostRow,
    type RuntimeHostStatus
} from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'

// The machine table (ADR-0037). Lifecycle and power live here; the daemon
// connection lives in host_daemons and never writes this row.
@Injectable()
export class HostsService {
    constructor(@Inject(DRIZZLE) private readonly db: Database) {}

    async findById(id: string): Promise<RuntimeHostRow | null> {
        const [row] = await this.db
            .select()
            .from(runtimeHosts)
            .where(eq(runtimeHosts.id, id))
            .limit(1)
        return row ?? null
    }

    async findForUser(
        userId: string,
        id: string
    ): Promise<RuntimeHostRow | null> {
        const [row] = await this.db
            .select()
            .from(runtimeHosts)
            .where(and(eq(runtimeHosts.id, id), eq(runtimeHosts.userId, userId)))
            .limit(1)
        return row ?? null
    }

    async listForUser(
        userId: string,
        kind?: RuntimeHostKind
    ): Promise<RuntimeHostRow[]> {
        return this.db
            .select()
            .from(runtimeHosts)
            .where(
                and(
                    eq(runtimeHosts.userId, userId),
                    kind ? eq(runtimeHosts.kind, kind) : undefined
                )
            )
    }

    async setStatus(
        id: string,
        status: RuntimeHostStatus,
        failureReason: string | null = null
    ): Promise<RuntimeHostRow | null> {
        const [row] = await this.db
            .update(runtimeHosts)
            .set({ status, failureReason, updatedAt: new Date() })
            .where(eq(runtimeHosts.id, id))
            .returning()
        return row ?? null
    }

    // Records a provider power observation; powerChangedAt only moves when
    // the state actually changes, so it reads as "since when".
    async setPower(
        id: string,
        state: RuntimeHostPowerState
    ): Promise<RuntimeHostRow | null> {
        const [row] = await this.db
            .update(runtimeHosts)
            .set({
                powerState: state,
                powerChangedAt: sql`case when ${runtimeHosts.powerState} is distinct from ${state} then now() else ${runtimeHosts.powerChangedAt} end`,
                updatedAt: new Date()
            })
            .where(eq(runtimeHosts.id, id))
            .returning()
        return row ?? null
    }

    async patch(
        id: string,
        values: Partial<Omit<NewRuntimeHostRow, 'id' | 'userId' | 'kind'>>,
        db: Pick<Database, 'update'> = this.db
    ): Promise<RuntimeHostRow | null> {
        const [row] = await db
            .update(runtimeHosts)
            .set({ ...values, updatedAt: new Date() })
            .where(eq(runtimeHosts.id, id))
            .returning()
        return row ?? null
    }

    // The adapter's own identity for the machine; only the adapter for the
    // host's provider kind reads or writes it.
    async setProviderRef(
        id: string,
        ref: RuntimeHostProviderRef,
        db: Pick<Database, 'update'> = this.db
    ): Promise<RuntimeHostRow | null> {
        return this.patch(id, { providerRef: ref }, db)
    }

    // Every provider mutation runs under the generation this returns; a
    // callback carrying an older one is dropped by its caller.
    async bumpGeneration(id: string): Promise<number> {
        const [row] = await this.db
            .update(runtimeHosts)
            .set({
                generation: sql`${runtimeHosts.generation} + 1`,
                updatedAt: new Date()
            })
            .where(eq(runtimeHosts.id, id))
            .returning({ generation: runtimeHosts.generation })
        if (!row) throw new Error(`host ${id} not found`)
        return row.generation
    }
}
