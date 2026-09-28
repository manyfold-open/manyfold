import { randomUUID } from 'node:crypto'
import { Injectable, Logger } from '@nestjs/common'
import { AWAKE_HOLD_TASK_PREFIX } from '@manyfold/shared'
import type { RuntimeHostRow } from '@manyfold/db'
import { HostProviderClients } from './providers/host-provider-clients.service'
import { SandboxProviderRegistry } from './providers/sandbox-provider'

// ADR-0038: a machine that can sleep is kept awake by a lease for exactly as
// long as somebody is working on it. The lease is the provider's own activity
// primitive (a sprite's /v1/tasks entry: TTL-bound, reachable only from inside
// the VM), and acquiring it is what resumes a suspended machine. One lease per
// host per API instance, reference-counted here: the first holder pays the
// provider call, later holders share it, and the last release lets the machine
// sleep again. Nothing else in the API keeps a machine awake.

export interface AwakeHold {
    // The first provider call for this hold settled; true when the lease is
    // in place. A path that needs the machine resumed before its next step
    // (waiting for the daemon to dial in) awaits it; the fast path does not.
    settled: Promise<boolean>
    // Work finished: drop this reference. The lease is released once nobody
    // holds it, after a grace period so back-to-back work on one machine
    // (admission, then the turn; one turn, then the next) never lets it sleep
    // in the gap.
    release: () => Promise<void>
    // Work was handed to another owner mid-flight (a turn that suspended):
    // drop this reference without ever deleting the lease from here. Whoever
    // picks the work up holds their own; the TTL bounds the leak.
    detach: () => void
}

export const NOOP_HOLD: AwakeHold = {
    settled: Promise.resolve(true),
    release: async () => {},
    detach: () => {}
}

// The lease bounds the leak when the owning instance dies mid-work: the
// machine keeps executing (that is the whole point) and suspends on its own
// soon after. Renewed at a third of the TTL so one failed renew is not fatal.
export const AWAKE_TTL = '30m'
const AWAKE_RENEW_MS = 10 * 60_000
const RELEASE_GRACE_MS = 5_000

interface Lease {
    host: RuntimeHostRow
    name: string
    count: number
    pending: Promise<boolean>
    renew: ReturnType<typeof setInterval>
    grace: ReturnType<typeof setTimeout> | null
}

@Injectable()
export class HostAwakeService {
    private readonly log = new Logger(HostAwakeService.name)
    // One name per API instance: instances never delete each other's hold,
    // and the prefix is what marks it as the platform's (isPlatformTaskName),
    // so the sandbox's Tasks surface neither lists it as the agent's nor
    // deletes it on a user's stop.
    private readonly leaseName = `${AWAKE_HOLD_TASK_PREFIX}${randomUUID().replace(/-/g, '').slice(0, 8)}`
    private readonly leases = new Map<string, Lease>()

    constructor(
        private readonly providers: SandboxProviderRegistry,
        private readonly clients: HostProviderClients
    ) {}

    // A hold on the machine behind `host`. A machine that never sleeps (a pod,
    // a self-owned computer) has nothing to hold: the no-op hold is returned
    // so callers never branch on the provider.
    hold(host: RuntimeHostRow, reason: string): AwakeHold {
        const kind = host.providerRef?.kind
        const adapter =
            host.kind === 'hosted' && kind && this.providers.has(kind)
                ? this.providers.for(kind)
                : null
        if (!adapter?.holdAwake) return NOOP_HOLD
        const existing = this.leases.get(host.id)
        const lease = existing ?? this.open(host)
        if (existing?.grace) {
            clearTimeout(existing.grace)
            existing.grace = null
        }
        lease.count += 1
        this.log.debug(
            `awake hold hostId=${host.id} reason=${reason} holders=${lease.count}`
        )
        let done = false
        return {
            settled: lease.pending,
            release: async () => {
                if (done) return
                done = true
                lease.count -= 1
                if (lease.count > 0) return
                lease.grace = setTimeout(() => {
                    void this.close(lease)
                }, this.releaseGraceMs())
                if (typeof lease.grace.unref === 'function') lease.grace.unref()
            },
            detach: () => {
                if (done) return
                done = true
                lease.count -= 1
                if (lease.count > 0) return
                clearInterval(lease.renew)
                if (this.leases.get(host.id) === lease)
                    this.leases.delete(host.id)
            }
        }
    }

    // Everything held right now, for a summary or a test.
    holders(hostId: string): number {
        return this.leases.get(hostId)?.count ?? 0
    }

    // Overridable in tests instead of injected: a number has no DI token.
    protected releaseGraceMs(): number {
        return RELEASE_GRACE_MS
    }

    private open(host: RuntimeHostRow): Lease {
        const name = this.leaseName
        const lease: Lease = {
            host,
            name,
            count: 0,
            pending: this.acquire(host, name),
            renew: setInterval(() => {
                lease.pending = this.acquire(host, name)
            }, AWAKE_RENEW_MS),
            grace: null
        }
        if (typeof lease.renew.unref === 'function') lease.renew.unref()
        this.leases.set(host.id, lease)
        return lease
    }

    private async close(lease: Lease): Promise<void> {
        if (this.leases.get(lease.host.id) !== lease || lease.count > 0) return
        clearInterval(lease.renew)
        this.leases.delete(lease.host.id)
        // Whatever create or renew was last in flight lands first: a release
        // settled early would otherwise race its own DELETE past the POST and
        // leave a full-TTL lease that nobody renews and nothing needs.
        await lease.pending
        try {
            const { provider, adapter } = await this.adapterFor(lease.host)
            await adapter.releaseAwake?.(
                { host: lease.host, provider },
                { name: lease.name }
            )
        } catch (err) {
            // The TTL is the backstop: a failed release only keeps the machine
            // awake a little longer than necessary.
            this.log.warn(
                `awake release failed hostId=${lease.host.id} class=${errorClass(err)}`
            )
        }
    }

    private async acquire(host: RuntimeHostRow, name: string): Promise<boolean> {
        try {
            const { provider, adapter } = await this.adapterFor(host)
            await adapter.holdAwake?.({ host, provider }, { name, ttl: AWAKE_TTL })
            return true
        } catch (err) {
            this.log.warn(
                `awake hold failed hostId=${host.id} class=${errorClass(err)}`
            )
            return false
        }
    }

    private async adapterFor(host: RuntimeHostRow) {
        const provider = await this.clients.providerForHost(host)
        return { provider, adapter: this.providers.for(provider.kind) }
    }
}

const errorClass = (err: unknown): string =>
    err instanceof Error && err.name ? err.name : typeof err
