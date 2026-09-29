import { Inject, Injectable, Logger } from '@nestjs/common'
import { and, eq, isNotNull, or } from 'drizzle-orm'
import { AWAKE_KEEP_TASK_NAME } from '@manyfold/shared'
import {
    runtimeHosts,
    type Database,
    type KeepAwakeLease,
    type RuntimeHostRow
} from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { TelemetryService } from '@/common/telemetry/telemetry.service'
import { liveHostedHosts } from '@/modules/runtime-access/runtime-usage-counts'
import { HostsService } from './hosts.service'
import { HostProviderResolver } from './providers/host-provider-resolver.service'
import { SandboxProviderRegistry } from './providers/sandbox-provider'
import { AWAKE_TTL } from './host-awake.service'

// How long a hold outlives the platform that stopped renewing it.
export const KEEP_AWAKE_TTL_SEC = 30 * 60
const KEEP_TTL_MS = KEEP_AWAKE_TTL_SEC * 1000
// Renewed with a third of the TTL still ahead, so a missed tick or two never
// lets a kept-awake machine lapse.
const RENEW_WITH_LEFT_MS = 20 * 60_000
// Per-tick caps: bound the execs one sweep can raise.
const MAX_ACTIONS_PER_TICK = 5
const RETRY_AFTER_MS = 2 * 60_000
const MAX_BACKOFF_MS = 5 * 60_000

export interface KeepAwakeHeadroom {
    orgActive: number
    activeCap: number
}

export type KeepAwakeOutcome =
    | { state: 'held' | 'released' | 'unchanged' }
    | { state: 'failed'; message: string }

const iso = (ms: number): string => new Date(ms).toISOString()

const isLive = (lease: KeepAwakeLease | null, now: number): boolean =>
    !!lease?.expiresAt && Date.parse(lease.expiresAt) > now

// A sandbox's keep-awake switch, held the way the platform holds a machine for
// its own work (ADR-0038): a task inside the VM that the API renews, one per
// host, never a loop living in the VM. Releasing it is an exec, and an exec
// resumes a sleeping sprite, so a machine that is not running is never woken
// to let go: its task expires on its own.
@Injectable()
export class HostKeepAwakeService {
    private readonly log = new Logger(HostKeepAwakeService.name)
    private readonly nextEligibleAt = new Map<string, number>()
    private readonly failures = new Map<string, number>()

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly hosts: HostsService,
        private readonly providers: SandboxProviderRegistry,
        private readonly clients: HostProviderResolver,
        private readonly telemetry: TelemetryService
    ) {}

    // Bring the machine in line with its switch now: the user's toggle, a
    // stop, a provisioning that finished. The flag is re-read after every
    // provider call, so a toggle that raced this one wins.
    async converge(host: RuntimeHostRow): Promise<KeepAwakeOutcome> {
        const fresh = await this.hosts.findById(host.id)
        if (!fresh || !this.supported(fresh)) return { state: 'unchanged' }
        if (fresh.keepAwake) {
            if (fresh.status !== 'ready') return { state: 'unchanged' }
            const held = await this.hold(fresh)
            const after = await this.hosts.findById(host.id)
            if (after && !after.keepAwake) return this.release(after)
            return held
        }
        if (fresh.powerState !== 'running') return { state: 'unchanged' }
        const released = await this.release(fresh)
        const after = await this.hosts.findById(host.id)
        if (after?.keepAwake && after.status === 'ready') return this.hold(after)
        return released
    }

    // The leader tick: renew what is kept awake before its TTL runs low, wake a
    // kept-awake machine that slept anyway (inside the org's running cap: the
    // enable was admitted, a re-wake is not re-admitted), let go of running
    // machines whose switch is off, and forget holds that expired on their own.
    async reconcile(args: {
        headroom: () => Promise<KeepAwakeHeadroom>
    }): Promise<void> {
        const now = Date.now()
        const rows = await this.db
            .select()
            .from(runtimeHosts)
            .where(
                and(
                    liveHostedHosts('sprites'),
                    or(
                        eq(runtimeHosts.keepAwake, true),
                        isNotNull(runtimeHosts.keepAwakeLease)
                    )
                )
            )
        let actions = 0
        let wakeBudget: number | null = null
        for (const host of rows) {
            if (actions >= MAX_ACTIONS_PER_TICK) break
            if (now < (this.nextEligibleAt.get(host.id) ?? 0)) continue
            const lease = host.keepAwakeLease
            if (host.keepAwake) {
                if (host.status !== 'ready') continue
                const running = host.powerState === 'running'
                const lapsing =
                    !isLive(lease, now + RENEW_WITH_LEFT_MS) || !running
                if (!lapsing) continue
                if (!running) {
                    if (wakeBudget === null) {
                        const room = await args.headroom()
                        wakeBudget = Math.max(0, room.activeCap - room.orgActive)
                        if (wakeBudget === 0)
                            this.telemetry.event('keep_awake.wake_capacity_skip', {
                                orgActive: room.orgActive,
                                activeCap: room.activeCap
                            })
                    }
                    if (wakeBudget === 0) continue
                    wakeBudget -= 1
                }
                actions += 1
                this.settle(host.id, await this.hold(host))
                continue
            }
            if (!isLive(lease, now)) {
                await this.save(host.id, null)
                continue
            }
            if (host.powerState !== 'running') continue
            actions += 1
            this.settle(host.id, await this.release(host))
        }
    }

    private supported(host: RuntimeHostRow): boolean {
        const kind = host.providerRef?.kind
        return (
            host.kind === 'hosted' &&
            !!kind &&
            this.providers.has(kind) &&
            !!this.providers.for(kind).holdAwake
        )
    }

    private async hold(host: RuntimeHostRow): Promise<KeepAwakeOutcome> {
        const now = Date.now()
        try {
            const { provider, adapter } = await this.adapterFor(host)
            await adapter.holdAwake!(
                { host, provider },
                { name: AWAKE_KEEP_TASK_NAME, ttl: AWAKE_TTL }
            )
            await this.save(host.id, {
                expiresAt: iso(now + KEEP_TTL_MS),
                verifiedAt: iso(now),
                lastError: null
            })
            return { state: 'held' }
        } catch (err) {
            const message = `keep-awake hold failed: ${(err as Error).message}`
            await this.save(host.id, {
                expiresAt: host.keepAwakeLease?.expiresAt ?? null,
                verifiedAt: host.keepAwakeLease?.verifiedAt ?? null,
                lastError: message.slice(0, 512)
            })
            this.telemetry.event('keep_awake.hold_failed', { hostId: host.id })
            return { state: 'failed', message }
        }
    }

    private async release(host: RuntimeHostRow): Promise<KeepAwakeOutcome> {
        try {
            const { provider, adapter } = await this.adapterFor(host)
            await adapter.releaseAwake?.(
                { host, provider },
                { name: AWAKE_KEEP_TASK_NAME }
            )
            await this.save(host.id, null)
            return { state: 'released' }
        } catch (err) {
            const message = `keep-awake release failed: ${(err as Error).message}`
            await this.save(host.id, {
                expiresAt: host.keepAwakeLease?.expiresAt ?? null,
                verifiedAt: host.keepAwakeLease?.verifiedAt ?? null,
                lastError: message.slice(0, 512)
            })
            this.telemetry.event('keep_awake.release_failed', { hostId: host.id })
            return { state: 'failed', message }
        }
    }

    // A failing host backs off; a settled one waits a tick before the next
    // look, so a lagging listing does not re-hold what was just held.
    private settle(hostId: string, outcome: KeepAwakeOutcome): void {
        const now = Date.now()
        if (outcome.state === 'failed') {
            const failures = (this.failures.get(hostId) ?? 0) + 1
            this.failures.set(hostId, failures)
            this.nextEligibleAt.set(
                hostId,
                now + Math.min(RETRY_AFTER_MS * 2 ** Math.min(failures - 1, 4), MAX_BACKOFF_MS)
            )
            this.log.warn(`keep-awake host=${hostId}: ${outcome.message}`)
            return
        }
        this.failures.delete(hostId)
        this.nextEligibleAt.set(hostId, now + RETRY_AFTER_MS)
    }

    private async save(
        hostId: string,
        lease: KeepAwakeLease | null
    ): Promise<void> {
        try {
            await this.hosts.patch(hostId, { keepAwakeLease: lease })
        } catch (err) {
            this.log.warn(
                `keep-awake record patch failed for host ${hostId}: ${(err as Error).message}`
            )
        }
    }

    private async adapterFor(host: RuntimeHostRow) {
        const provider = await this.clients.providerForHost(host)
        return { provider, adapter: this.providers.for(provider.kind) }
    }
}
