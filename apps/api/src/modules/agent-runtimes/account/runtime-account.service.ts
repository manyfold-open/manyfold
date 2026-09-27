import {
    DAEMON_FEATURE_ACCOUNT_INSPECT,
    parseRuntimeAccountProbe,
    runtimeAccountSupport,
    runtimeAccountUsage,
    runtimeLocalCredentialStatus,
    runtimeLocalInspectFeature
} from '@manyfold/shared'
import type {
    AgentRuntime,
    ModelConfigFramework,
    RuntimeAccountUsage,
    RuntimeAccountView,
    RuntimeAccountViewStatus,
} from '@manyfold/shared'
import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import type { AgentRuntimeRow, RuntimeHostRow } from '@manyfold/db'
import {
    HostDaemonAccess,
    HostDaemonOfflineError
} from '@/modules/agents/adapters/host-daemon-access'
import { HostDaemonsService } from '@/modules/hosts/host-daemons.service'
import {
    RuntimeContextService,
    type RuntimeContext
} from '@/modules/hosts/runtime-context.service'
import {
    isConcurrentActiveLimitError,
    RuntimeAccessService
} from '@/modules/runtime-access/runtime-access.service'
import {
    credentialContextFor
} from '@/modules/agents/model-config/agent-model-config.service'

// An older CLI answers account.inspect for pi or agy with nothing, which
// would read as "not signed in"; it is asked to update instead.
const inspectsAccount = (
    features: readonly string[],
    framework: ModelConfigFramework
): boolean => {
    const required = runtimeLocalInspectFeature(framework)
    return (
        features.includes(DAEMON_FEATURE_ACCOUNT_INSPECT) &&
        (required === null || features.includes(required))
    )
}

// One runtime page open = one vendor usage call, and Anthropic's endpoint has
// a tight budget, so identical requests inside this window share a result and
// a 429 pins the window to the vendor's Retry-After. Per instance on purpose:
// the worst case across instances is one extra probe.
const CACHE_TTL_MS = 30_000
// How long a good usage answer is reused before the vendor is asked again.
// The usage endpoints rate-limit far below how often a page is opened or
// refreshed (Anthropic answered a second read within minutes with a 429 and
// a multi-minute Retry-After on a local stack [2026-09-11]); the sign-in
// itself is still re-read on every probe.
const USAGE_TTL_MS = 10 * 60_000
const DAEMON_RPC_TIMEOUT_MS = 20_000
const SANDBOX_RPC_TIMEOUT_MS = 30_000
const MAX_ERROR_CHARS = 300

type HostView = RuntimeAccountView['host']

// The account view still speaks sprites.dev's lifecycle vocabulary for the
// host it probed; the host row stores the provider-neutral power state.
const hostViewOf = (host: RuntimeHostRow): HostView => ({
    powerState: host.powerState,
    terminalEnabled: host.terminalEnabled
})

const identityKeyOf = (view: RuntimeAccountView): string | null =>
    view.identity?.accountId ?? view.identity?.email ?? null

@Injectable()
export class RuntimeAccountService {
    private readonly log = new Logger(RuntimeAccountService.name)
    private readonly cache = new Map<
        string,
        { until: number; view: RuntimeAccountView }
    >()
    private readonly inflight = new Map<string, Promise<RuntimeAccountView>>()
    // The last good usage per runtime: `until` is how long a probe may skip
    // the vendor call for it, `identityKey` whose usage it is.
    private readonly usageCache = new Map<
        string,
        {
            usage: RuntimeAccountUsage
            identityKey: string | null
            until: number
        }
    >()

    constructor(
        private readonly context: RuntimeContextService,
        private readonly hostDaemons: HostDaemonsService,
        private readonly runtimeAccess: RuntimeAccessService,
        private readonly hostAccess: HostDaemonAccess
    ) {}

    async getView(
        userId: string,
        runtimeId: string,
        // refreshUsage: the user's explicit ask to read usage from the vendor
        // again; bypasses both caches.
        opts: { wake: boolean; refreshUsage?: boolean }
    ): Promise<RuntimeAccountView> {
        const ctx = await this.context.forRuntime(runtimeId)
        if (!ctx || ctx.runtime.userId !== userId)
            throw new NotFoundException(`agent runtime ${runtimeId} not found`)
        const row = ctx.runtime
        if (runtimeAccountSupport(row.framework, ctx.placement) !== 'ok')
            return this.view(row, ctx.placement, 'unsupported')
        const now = Date.now()
        const cached = this.cache.get(row.id)
        // A wake request is the user asking to spend a VM start; a cached
        // "asleep" answer must not swallow it.
        if (
            cached &&
            cached.until > now &&
            !opts.refreshUsage &&
            !(opts.wake && cached.view.status === 'sandbox-asleep')
        )
            return cached.view
        const key = `${row.id}:${opts.wake ? 'wake' : 'peek'}${opts.refreshUsage ? ':usage' : ''}`
        const pending = this.inflight.get(key)
        if (pending) return pending
        const promise = this.probe(ctx, opts.wake, opts.refreshUsage === true)
            .then((view) => {
                const retryAfter = view.usage?.error?.retryAfterSeconds
                const ttl =
                    view.usage?.error?.kind === 'rate-limited' && retryAfter
                        ? retryAfter * 1000
                        : CACHE_TTL_MS
                // The cap frees itself the moment another VM idles; a cached
                // refusal would keep saying no after it did.
                if (view.status !== 'sandbox-limit')
                    this.cache.set(row.id, { until: Date.now() + ttl, view })
                return view
            })
            .finally(() => this.inflight.delete(key))
        this.inflight.set(key, promise)
        return promise
    }

    private async probe(
        ctx: RuntimeContext,
        wake: boolean,
        refreshUsage: boolean
    ): Promise<RuntimeAccountView> {
        const row = ctx.runtime
        const framework = row.framework as ModelConfigFramework
        try {
            const fetchUsage = refreshUsage || !this.usageFresh(row.id)
            const view = await this.probeHost(ctx, framework, wake, fetchUsage)
            // The kept usage belongs to whoever was signed in when it was
            // read; a different identity now means asking again now, not
            // showing one account's numbers under another's name.
            if (!fetchUsage && this.usageIdentityChanged(row.id, view))
                return this.settleUsage(
                    row.id,
                    await this.probeHost(ctx, framework, wake, true),
                    true
                )
            return this.settleUsage(row.id, view, fetchUsage)
        } catch (err) {
            // Tokens never reach this process, so the message is safe to show;
            // it is still capped because a failed exec can echo a whole stdout.
            const message = (err as Error).message || String(err)
            this.log.warn(
                `runtime account probe failed runtime=${row.id} placement=${ctx.placement}: ${message.slice(0, MAX_ERROR_CHARS)}`
            )
            return this.view(row, ctx.placement, 'probe-failed', {
                error: message.slice(0, MAX_ERROR_CHARS)
            })
        }
    }

    private usageFresh(runtimeId: string): boolean {
        const entry = this.usageCache.get(runtimeId)
        return entry !== undefined && entry.until > Date.now()
    }

    private usageIdentityChanged(
        runtimeId: string,
        view: RuntimeAccountView
    ): boolean {
        const entry = this.usageCache.get(runtimeId)
        return (
            entry !== undefined &&
            view.status === 'ok' &&
            entry.identityKey !== identityKeyOf(view)
        )
    }

    // A probe that asked the vendor refreshes the kept usage when the answer
    // is good and otherwise keeps the last good numbers (their fetchedAt says
    // how old they are) rather than replacing them with an error; a probe
    // that skipped the vendor takes the kept usage as its own.
    private settleUsage(
        runtimeId: string,
        view: RuntimeAccountView,
        fetched: boolean
    ): RuntimeAccountView {
        if (view.status !== 'ok') return view
        const entry = this.usageCache.get(runtimeId)
        if (!fetched) return entry ? { ...view, usage: entry.usage } : view
        if (view.usage && !view.usage.error) {
            this.usageCache.set(runtimeId, {
                usage: view.usage,
                identityKey: identityKeyOf(view),
                until: Date.now() + USAGE_TTL_MS
            })
            return view
        }
        if (
            view.usage?.error &&
            entry &&
            entry.identityKey === identityKeyOf(view)
        )
            return { ...view, usage: entry.usage }
        return view
    }

    // Agent → Runtime → Host → host daemon (R11): the probe is one RPC to the
    // machine's daemon whatever the placement. A sleeping sandbox is only
    // woken on the user's explicit click; a local host that is offline can
    // only be brought back by its owner.
    private async probeHost(
        ctx: RuntimeContext,
        framework: ModelConfigFramework,
        wake: boolean,
        fetchUsage: boolean
    ): Promise<RuntimeAccountView> {
        const row = ctx.runtime
        const host = ctx.host
        if (!host)
            return this.view(row, ctx.placement, 'probe-failed', {
                error: 'runtime has no host'
            })
        const hostView = host.kind === 'hosted' ? hostViewOf(host) : null
        if (host.kind === 'hosted') {
            if (host.status !== 'ready')
                return this.view(row, ctx.placement, 'probe-failed', {
                    host: hostView,
                    error: 'sandbox is not provisioned'
                })
            // An exec wakes a sleeping VM and starts billing its running
            // time, so a page open only reads a sandbox that is already
            // awake; waking is the user's explicit click.
            if (host.powerState !== 'running' && !wake)
                return this.view(row, ctx.placement, 'sandbox-asleep', {
                    host: hostView
                })
            try {
                await this.runtimeAccess.reserveActiveSlot({
                    userId: row.userId,
                    hostId: host.id
                })
            } catch (err) {
                // Another sandbox holds the plan's active slot: a named
                // state, so the page can say what to do rather than show a
                // failed probe.
                if (!isConcurrentActiveLimitError(err)) throw err
                return this.view(row, ctx.placement, 'sandbox-limit', {
                    host: hostView,
                    error: (err as Error).message
                })
            }
        }
        // The admitted wake is what brings a sleeping machine's daemon up; a
        // page open on a running machine only reads the daemon the API holds
        // a socket to. The probe runs under the machine's hold (ADR-0038).
        const daemon = await this.hostDaemons.findByHostId(host.id)
        try {
            return await this.hostAccess.withHost(
                {
                    host,
                    daemon,
                    placement: ctx.placement,
                    reason: 'account-inspect',
                    wake
                },
                async (session) => {
                    if (!inspectsAccount(session.daemon.clientFeatures, framework))
                        return this.view(
                            row,
                            ctx.placement,
                            'daemon-upgrade-required',
                            { host: hostView }
                        )
                    const payload = await session.rpc({
                        method: 'account.inspect',
                        payload: { framework, usage: fetchUsage },
                        timeoutMs:
                            host.kind === 'hosted'
                                ? SANDBOX_RPC_TIMEOUT_MS
                                : DAEMON_RPC_TIMEOUT_MS
                    })
                    return this.viewFromProbe(
                        row,
                        ctx.placement,
                        payload,
                        hostView
                    )
                }
            )
        } catch (err) {
            if (!(err instanceof HostDaemonOfflineError)) throw err
            if (host.kind === 'local')
                return this.view(row, ctx.placement, 'daemon-offline')
            return this.view(row, ctx.placement, 'probe-failed', {
                host: hostView,
                error: 'sandbox daemon offline'
            })
        }
    }

    // Public seam for the auth-profiles listing, which receives the ambient
    // probe from the same host RPC and must render it identically.
    fromProbe(
        row: AgentRuntimeRow,
        raw: unknown,
        host: HostView,
        placement: AgentRuntime
    ): RuntimeAccountView {
        return this.viewFromProbe(row, placement, raw, host)
    }

    private viewFromProbe(
        row: AgentRuntimeRow,
        placement: AgentRuntime,
        raw: unknown,
        host: HostView
    ): RuntimeAccountView {
        const probe = parseRuntimeAccountProbe(raw)
        if (!probe)
            return this.view(row, placement, 'probe-failed', {
                host,
                error: 'host returned no account probe'
            })
        const evaluated = runtimeLocalCredentialStatus(
            probe.credentialFacts,
            Date.now(),
            credentialContextFor(placement)
        )
        return {
            ...this.view(row, placement, 'ok', { host }),
            checkedAt: probe.checkedAt,
            credentialStatus: evaluated.status,
            credentialReason: evaluated.reason,
            tokenSource: probe.tokenSource,
            identity: probe.identity,
            usage: runtimeAccountUsage(probe)
        }
    }

    private view(
        row: AgentRuntimeRow,
        placement: AgentRuntime,
        status: RuntimeAccountViewStatus,
        extra: { host?: HostView; error?: string | null } = {}
    ): RuntimeAccountView {
        return {
            runtimeId: row.id,
            framework: row.framework,
            kind: placement,
            status,
            checkedAt: null,
            credentialStatus: 'unknown',
            credentialReason: 'not-reported',
            tokenSource: null,
            identity: null,
            usage: null,
            host: extra.host ?? null,
            error: extra.error ?? null
        }
    }
}

// The sandbox exec prints the model inspect line (`{"frameworks":[…]}`) and
// then the account line (`{"account":{…}}`); the facts from the first ride
// into the probe so the API judges sign-in with its usual evaluator.
export const mergeSandboxProbe = (stdout: string): unknown => {
    let frameworks: unknown[] | null = null
    let account: Record<string, unknown> | null = null
    for (const rawLine of stdout.split(/\r?\n/)) {
        const line = rawLine.trim()
        if (!line.startsWith('{')) continue
        let parsed: unknown
        try {
            parsed = JSON.parse(line)
        } catch {
            continue
        }
        if (!parsed || typeof parsed !== 'object') continue
        const record = parsed as Record<string, unknown>
        if (Array.isArray(record.frameworks)) frameworks = record.frameworks
        if (record.account && typeof record.account === 'object')
            account = record.account as Record<string, unknown>
    }
    if (!account) return null
    const capability = frameworks?.find(
        (item): item is Record<string, unknown> =>
            Boolean(item) &&
            typeof item === 'object' &&
            (item as Record<string, unknown>).framework === account?.framework
    )
    return { ...account, credentialFacts: capability?.credentialFacts ?? null }
}
