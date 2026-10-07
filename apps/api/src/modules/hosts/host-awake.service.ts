import { randomUUID } from 'node:crypto'
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common'
import { AWAKE_HOLD_TASK_PREFIX } from '@manyfold/shared'
import type { RuntimeHostRow } from '@manyfold/db'
import { HostProviderResolver } from './providers/host-provider-resolver.service'
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

// A hold for exactly one piece of work: taken before it, released after it,
// nothing held between two of them; the release grace keeps back-to-back work
// on one lease. A hold handed to the caller instead is one a caller can
// forget, and a forgotten hold is renewed until the API restarts.
// Seen on staging [2026-09-29]: four callers forgot the hold a history-read
// handle carried, and a sandbox read by a gemini automation every 2 h ran
// 14–20 h a day from 2026-09-20.
export const whileHeld = async <T>(
    hold: (() => AwakeHold) | undefined,
    work: () => Promise<T>
): Promise<T> => {
    const held = hold?.()
    try {
        return await work()
    } finally {
        void held?.release()
    }
}

// The lease bounds the leak when the owning instance dies mid-work: the
// machine keeps executing (that is the whole point) and suspends on its own
// soon after. Renewed at a third of the TTL so one failed renew is not fatal.
export const AWAKE_TTL = '30m'
const AWAKE_TTL_MS = 30 * 60_000
const AWAKE_RENEW_MS = 10 * 60_000
const RELEASE_GRACE_MS = 5_000
// Inside the shutdown's own close budget (server-bootstrap.ts).
const SHUTDOWN_RELEASE_MS = 4_000

interface Lease {
    host: RuntimeHostRow
    name: string
    count: number
    pending: Promise<boolean>
    renew: ReturnType<typeof setInterval>
    grace: ReturnType<typeof setTimeout> | null
    // A holder handed its work on mid-flight (detach): whoever picked it up
    // relies on this task until its TTL, so nothing here may delete it.
    detached: boolean
}

const leaseName = (): string =>
    `${AWAKE_HOLD_TASK_PREFIX}${randomUUID().replace(/-/g, '').slice(0, 8)}`

@Injectable()
export class HostAwakeService implements OnModuleDestroy {
    private readonly log = new Logger(HostAwakeService.name)
    // One name per API instance: instances never delete each other's hold,
    // and the prefix is what marks it as the platform's (isPlatformTaskName),
    // so the sandbox's Tasks surface neither lists it as the agent's nor
    // deletes it on a user's stop.
    private readonly leaseName = leaseName()
    private readonly leases = new Map<string, Lease>()
    // Until when a detached task of this instance may still carry handed-off
    // work on a host. A lease opened there meanwhile takes a fresh name: under
    // the instance's own name its release would delete that task.
    // Seen on staging [2026-10-07]: a turn detached at shutdown, then the
    // daemon's reconnect took a config-delivery hold on the same instance;
    // that hold's release deleted the turn's task and the sprite went cold.
    private readonly detachedUntil = new Map<string, number>()
    // A closed lease's release still in flight, by host. Every lease of this
    // instance has the same name, so the next lease on that host acquires only
    // once the release has landed: a PUT that overtook the DELETE would be
    // deleted by it, and its holders would believe the machine held while
    // nothing holds it until the next renew.
    private readonly closing = new Map<string, Promise<void>>()

    constructor(
        private readonly providers: SandboxProviderRegistry,
        private readonly clients: HostProviderResolver
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
                lease.detached = true
                lease.count -= 1
                if (lease.count > 0) return
                clearInterval(lease.renew)
                if (this.leases.get(host.id) === lease)
                    this.leases.delete(host.id)
                this.markDetached(host.id)
            }
        }
    }

    // An instance going away lets go of every machine it holds: nothing
    // renews a lease once its instance is gone, and one left behind keeps its
    // machine awake, and billed, for the rest of its TTL. Work handed to
    // another instance holds the machine again from there. onModuleDestroy
    // runs at the start of app.close(), before anything that can hang on an
    // open socket.
    // Seen on local [2026-09-29]: four API restarts left four hold tasks on a
    // sandbox whose work had all ended, and it stayed running.
    async onModuleDestroy(): Promise<void> {
        const leases = [...this.leases.values()]
        this.leases.clear()
        for (const lease of leases) {
            clearInterval(lease.renew)
            if (lease.grace) clearTimeout(lease.grace)
        }
        await Promise.race([
            Promise.allSettled([
                // A detached lease carries work handed to another owner: it
                // stays until its TTL, as the detach promised.
                ...leases
                    .filter((lease) => !lease.detached)
                    .map((lease) => this.release(lease)),
                // Leases already closing: their release is half done.
                ...this.closing.values()
            ]),
            new Promise<void>((resolve) =>
                setTimeout(resolve, SHUTDOWN_RELEASE_MS).unref()
            )
        ])
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
        const until = this.detachedUntil.get(host.id)
        if (until !== undefined && until <= Date.now())
            this.detachedUntil.delete(host.id)
        const fresh = this.detachedUntil.has(host.id)
        const name = fresh ? leaseName() : this.leaseName
        // Only a lease of the instance's own name can race the DELETE of the
        // last one; a fresh name has nothing in flight to wait for.
        const closing = fresh ? undefined : this.closing.get(host.id)
        const lease: Lease = {
            host,
            name,
            count: 0,
            pending: closing
                ? closing.then(() => this.acquire(host, name))
                : this.acquire(host, name),
            renew: setInterval(() => {
                lease.pending = this.acquire(host, name)
            }, AWAKE_RENEW_MS),
            grace: null,
            detached: false
        }
        if (typeof lease.renew.unref === 'function') lease.renew.unref()
        this.leases.set(host.id, lease)
        return lease
    }

    private async close(lease: Lease): Promise<void> {
        if (this.leases.get(lease.host.id) !== lease || lease.count > 0) return
        clearInterval(lease.renew)
        this.leases.delete(lease.host.id)
        // One of its holders detached: the work it handed on still needs the
        // task, so it lapses by its TTL instead of being deleted.
        if (lease.detached) {
            this.markDetached(lease.host.id)
            return
        }
        const released = this.release(lease)
        this.closing.set(lease.host.id, released)
        await released
        if (this.closing.get(lease.host.id) === released)
            this.closing.delete(lease.host.id)
    }

    // Its last renew may have just landed, so the task lives a full TTL from
    // now at most.
    private markDetached(hostId: string): void {
        this.detachedUntil.set(hostId, Date.now() + AWAKE_TTL_MS)
    }

    private async release(lease: Lease): Promise<void> {
        // Whatever create or renew was last in flight lands first: a release
        // settled early would otherwise race its own DELETE past the PUT and
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
