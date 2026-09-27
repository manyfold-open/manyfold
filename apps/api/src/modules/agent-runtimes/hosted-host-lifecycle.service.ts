import {
    ConflictException,
    Inject,
    Injectable,
    Logger,
    NotFoundException
} from '@nestjs/common'
import { and, count, eq, isNull, sql } from 'drizzle-orm'
import {
    agentRuntimes,
    agents,
    daemonTokens,
    hostDaemons,
    runtimeHosts,
    serviceLeases,
    type Database,
    type RuntimeHostRow
} from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { TelemetryService } from '@/common/telemetry/telemetry.service'
import { HostsService } from '@/modules/hosts/hosts.service'
import { RuntimeProvidersService } from '@/modules/hosts/runtime-providers.service'
import { SandboxProviderRegistry } from '@/modules/hosts/providers/sandbox-provider'
import { SandboxActiveDurationService } from '@/modules/agents/sandbox-active-duration/sandbox-active-duration.service'
import { providerRefLabel } from './host-ref'
import { daemonConfigLeaseName } from '@/modules/daemon/daemon-config-delivery.service'

export const HOST_NOT_EMPTY_CODE = 'HOST_NOT_EMPTY'

// Host deletion (ADR-0036 R8): 409 while agents exist, else `deleting` →
// revoke the host's tokens → adapter.destroy → delete runtimes, host_daemons
// and the host in one transaction. A destroy that fails leaves the row at
// `deleting` with the reason, and the reaper / a retry runs it again under the
// next generation. A local host is `retired` first (R5) and then deleted
// without any provider call.
@Injectable()
export class HostedHostLifecycleService {
    private readonly log = new Logger(HostedHostLifecycleService.name)

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly hosts: HostsService,
        private readonly providers: RuntimeProvidersService,
        private readonly adapters: SandboxProviderRegistry,
        private readonly activeDuration: SandboxActiveDurationService,
        private readonly telemetry: TelemetryService
    ) {}

    // `force` deletes the agents and runtimes on the host too (account
    // deletion); every other caller refuses while an agent is bound.
    async deleteHost(
        hostId: string,
        opts: { force?: boolean } = {}
    ): Promise<void> {
        const host = await this.hosts.findById(hostId)
        if (!host) throw new NotFoundException(`host ${hostId} not found`)
        if (host.kind === 'local') {
            await this.deleteLocalHost(host, opts)
            return
        }
        const claimed = await this.db.transaction(async (tx) => {
            await tx.execute(
                sql`select pg_advisory_xact_lock(hashtextextended(${host.userId}, 0))`
            )
            const [row] = await tx
                .select({ value: count() })
                .from(agents)
                .innerJoin(agentRuntimes, eq(agentRuntimes.id, agents.runtimeId))
                .where(eq(agentRuntimes.hostId, host.id))
            if (Number(row?.value ?? 0) > 0) {
                if (!opts.force)
                    throw new ConflictException({
                        message: 'host still has agents; delete them first',
                        code: HOST_NOT_EMPTY_CODE
                    })
                await tx.delete(agents).where(
                    sql`${agents.runtimeId} in (select id from agent_runtimes where host_id = ${host.id})`
                )
            }
            const now = new Date()
            const updated = await tx
                .update(runtimeHosts)
                .set({
                    status: 'deleting',
                    failureReason: null,
                    keepAwake: false,
                    generation: sql`${runtimeHosts.generation} + 1`,
                    updatedAt: now
                })
                .where(
                    and(
                        eq(runtimeHosts.id, host.id),
                        eq(runtimeHosts.kind, 'hosted')
                    )
                )
                .returning({ generation: runtimeHosts.generation })
            if (updated.length === 0) return null
            await tx
                .update(daemonTokens)
                .set({ revokedAt: now })
                .where(
                    and(
                        eq(daemonTokens.hostId, host.id),
                        isNull(daemonTokens.revokedAt)
                    )
                )
            return updated[0].generation
        })
        if (claimed === null) return
        // Credit the final running interval before the row goes: the ledger
        // row outlives the host so the user's period rollup stays intact.
        await this.activeDuration.settleHostNotRunning(
            host.id,
            host.userId,
            new Date()
        )
        const deleting: RuntimeHostRow = {
            ...host,
            status: 'deleting',
            generation: claimed
        }
        try {
            await this.destroy(deleting)
        } catch (err) {
            const reason = (err as Error).message.slice(0, 512)
            await this.hosts.setStatus(host.id, 'deleting', reason)
            this.log.warn(
                `host destroy failed host=${host.id} (${providerRefLabel(host)}): ${reason}`
            )
            throw err
        }
        await this.db.transaction(async (tx) => {
            await tx
                .delete(agentRuntimes)
                .where(eq(agentRuntimes.hostId, host.id))
            await tx.delete(hostDaemons).where(eq(hostDaemons.hostId, host.id))
            await tx
                .delete(serviceLeases)
                .where(eq(serviceLeases.name, daemonConfigLeaseName(host.id)))
            await tx.delete(runtimeHosts).where(eq(runtimeHosts.id, host.id))
        })
        this.telemetry.event('host.deleted', {
            hostId: host.id,
            userId: host.userId,
            kind: host.kind,
            providerId: host.providerId
        })
    }

    private async destroy(host: RuntimeHostRow): Promise<void> {
        if (!host.providerId || !host.providerRef) return
        const provider = await this.providers.findById(host.providerId)
        if (!provider)
            throw new Error(`runtime provider ${host.providerId} not found`)
        await this.adapters.for(provider.kind).destroy({
            host,
            provider,
            generation: host.generation
        })
    }

    // R5: a local host is retired (tokens revoked, registration and WS
    // refused) and only then permanently deleted; both are database-only.
    async retireLocalHost(hostId: string): Promise<void> {
        const now = new Date()
        await this.db.transaction(async (tx) => {
            const updated = await tx
                .update(runtimeHosts)
                .set({ status: 'retired', updatedAt: now })
                .where(
                    and(
                        eq(runtimeHosts.id, hostId),
                        eq(runtimeHosts.kind, 'local')
                    )
                )
                .returning({ id: runtimeHosts.id })
            if (updated.length === 0) return
            await tx
                .update(daemonTokens)
                .set({ revokedAt: now })
                .where(
                    and(
                        eq(daemonTokens.hostId, hostId),
                        isNull(daemonTokens.revokedAt)
                    )
                )
        })
    }

    private async deleteLocalHost(
        host: RuntimeHostRow,
        opts: { force?: boolean }
    ): Promise<void> {
        await this.db.transaction(async (tx) => {
            const [row] = await tx
                .select({ value: count() })
                .from(agents)
                .innerJoin(agentRuntimes, eq(agentRuntimes.id, agents.runtimeId))
                .where(eq(agentRuntimes.hostId, host.id))
            if (Number(row?.value ?? 0) > 0) {
                if (!opts.force)
                    throw new ConflictException({
                        message: 'host still has agents; delete them first',
                        code: HOST_NOT_EMPTY_CODE
                    })
                await tx.delete(agents).where(
                    sql`${agents.runtimeId} in (select id from agent_runtimes where host_id = ${host.id})`
                )
            }
            await tx
                .update(daemonTokens)
                .set({ revokedAt: new Date() })
                .where(
                    and(
                        eq(daemonTokens.hostId, host.id),
                        isNull(daemonTokens.revokedAt)
                    )
                )
            await tx
                .delete(agentRuntimes)
                .where(eq(agentRuntimes.hostId, host.id))
            await tx.delete(hostDaemons).where(eq(hostDaemons.hostId, host.id))
            await tx
                .delete(serviceLeases)
                .where(eq(serviceLeases.name, daemonConfigLeaseName(host.id)))
            await tx.delete(runtimeHosts).where(eq(runtimeHosts.id, host.id))
        })
    }
}
