import {
    DAEMON_FEATURE_ACCOUNT_INSPECT,
    parseRuntimeAccountProbe,
    runtimeAccountSupport,
    runtimeAccountUsage,
    runtimeLocalCredentialStatus
} from '@manyfold/shared'
import type {
    ConfigurableFramework,
    RuntimeAccountUsage,
    RuntimeAccountView,
    RuntimeAccountViewStatus
} from '@manyfold/shared'
import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import type { AgentRuntimeRow, SpritesAccount } from '@manyfold/db'
import {
    createClient as createSpritesClient,
    execSprite
} from '@manyfold/sprites'
import type { ExecOptions, ExecResult, SpritesClient } from '@manyfold/sprites'
import { DaemonHostService } from '@/modules/daemon/daemon-host.service'
import { DaemonRegistryService } from '@/modules/daemon/daemon-registry.service'
import {
    isConcurrentActiveLimitError,
    RuntimeAccessService
} from '@/modules/runtime-access/runtime-access.service'
import { SpritesAccountsService } from '@/modules/sprites-accounts/sprites-accounts.service'
import {
    credentialContextFor,
    runtimeInspectScript
} from '@/modules/agents/model-config/agent-model-config.service'
import { AgentRuntimesService } from '../agent-runtimes.service'
import { runtimeAccountScript } from './runtime-account-script'

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
const SANDBOX_EXEC_TIMEOUT_MS = 30_000
const MAX_ERROR_CHARS = 300

// The account script only needs the credential facts from the model inspect
// script, so its catalog (which shapes the discarded model lists) stays empty.
const EMPTY_INSPECT_CATALOG = {
    claudeAliases: [],
    codexModels: [],
    codexSpeeds: [],
    codexIntelligence: [],
    geminiModels: [],
    geminiAliases: []
}

type HostView = RuntimeAccountView['host']

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
        private readonly runtimes: AgentRuntimesService,
        private readonly daemonHosts: DaemonHostService,
        private readonly daemonRegistry: DaemonRegistryService,
        private readonly accounts: SpritesAccountsService,
        private readonly runtimeAccess: RuntimeAccessService
    ) {}

    async getView(
        userId: string,
        runtimeId: string,
        // refreshUsage: the user's explicit ask to read usage from the vendor
        // again; bypasses both caches.
        opts: { wake: boolean; refreshUsage?: boolean }
    ): Promise<RuntimeAccountView> {
        const row = await this.runtimes.findById(runtimeId)
        if (!row || row.userId !== userId)
            throw new NotFoundException(`agent runtime ${runtimeId} not found`)
        if (runtimeAccountSupport(row.framework, row.kind) !== 'ok')
            return this.view(row, 'unsupported')
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
        const promise = this.probe(row, opts.wake, opts.refreshUsage === true)
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
        row: AgentRuntimeRow,
        wake: boolean,
        refreshUsage: boolean
    ): Promise<RuntimeAccountView> {
        const framework = row.framework as ConfigurableFramework
        try {
            const fetchUsage = refreshUsage || !this.usageFresh(row.id)
            const view = await this.probeHost(row, framework, wake, fetchUsage)
            // The kept usage belongs to whoever was signed in when it was
            // read; a different identity now means asking again now, not
            // showing one account's numbers under another's name.
            if (!fetchUsage && this.usageIdentityChanged(row.id, view))
                return this.settleUsage(
                    row.id,
                    await this.probeHost(row, framework, wake, true),
                    true
                )
            return this.settleUsage(row.id, view, fetchUsage)
        } catch (err) {
            // Tokens never reach this process, so the message is safe to show;
            // it is still capped because a failed exec can echo a whole stdout.
            const message = (err as Error).message || String(err)
            this.log.warn(
                `runtime account probe failed runtime=${row.id} kind=${row.kind}: ${message.slice(0, MAX_ERROR_CHARS)}`
            )
            return this.view(row, 'probe-failed', {
                error: message.slice(0, MAX_ERROR_CHARS)
            })
        }
    }

    private probeHost(
        row: AgentRuntimeRow,
        framework: ConfigurableFramework,
        wake: boolean,
        fetchUsage: boolean
    ): Promise<RuntimeAccountView> {
        return row.kind === 'daemon'
            ? this.probeDaemon(row, framework, fetchUsage)
            : this.probeSandbox(row, framework, wake, fetchUsage)
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

    private async probeDaemon(
        row: AgentRuntimeRow,
        framework: ConfigurableFramework,
        fetchUsage: boolean
    ): Promise<RuntimeAccountView> {
        if (!row.daemonId)
            return this.view(row, 'probe-failed', {
                error: 'runtime has no daemon host'
            })
        const host = await this.daemonHosts.findById(row.daemonId)
        if (!host || host.userId !== row.userId)
            return this.view(row, 'probe-failed', {
                error: 'daemon host not found'
            })
        if (!this.daemonHosts.isOnline(host))
            return this.view(row, 'daemon-offline')
        if (!host.clientFeatures.includes(DAEMON_FEATURE_ACCOUNT_INSPECT))
            return this.view(row, 'daemon-upgrade-required')
        const payload = await this.daemonRegistry.rpc({
            daemonId: host.id,
            method: 'account.inspect',
            payload: { framework, usage: fetchUsage },
            timeoutMs: DAEMON_RPC_TIMEOUT_MS
        })
        return this.viewFromProbe(row, payload, null)
    }

    private async probeSandbox(
        row: AgentRuntimeRow,
        framework: ConfigurableFramework,
        wake: boolean,
        fetchUsage: boolean
    ): Promise<RuntimeAccountView> {
        if (!row.hostId)
            return this.view(row, 'probe-failed', {
                error: 'runtime has no sandbox host'
            })
        const host = await this.runtimes.findHostById(row.hostId)
        if (!host || host.userId !== row.userId || host.kind !== 'sandbox')
            return this.view(row, 'probe-failed', {
                error: 'sandbox host not found'
            })
        const hostView: HostView = {
            spriteStatus: host.spriteStatus,
            terminalEnabled: host.terminalEnabled
        }
        if (!host.spriteName || !host.accountId)
            return this.view(row, 'probe-failed', {
                host: hostView,
                error: 'sandbox is not provisioned'
            })
        // An exec wakes a sleeping VM and starts billing its running time, so
        // a page open only reads a sandbox that is already awake; waking is
        // the user's explicit click.
        if (host.spriteStatus !== 'running' && !wake)
            return this.view(row, 'sandbox-asleep', { host: hostView })
        try {
            await this.runtimeAccess.reserveActiveSlot({
                userId: row.userId,
                hostId: host.id
            })
        } catch (err) {
            // Another sandbox holds the plan's active slot: a named state, so
            // the page can say what to do rather than show a failed probe.
            if (!isConcurrentActiveLimitError(err)) throw err
            return this.view(row, 'sandbox-limit', {
                host: hostView,
                error: (err as Error).message
            })
        }
        const account = await this.accounts.getById(host.accountId)
        if (!account)
            return this.view(row, 'probe-failed', {
                host: hostView,
                error: 'sandbox account unavailable'
            })
        const script = [
            'export PATH="$HOME/.local/bin:$PATH"',
            runtimeInspectScript(framework, EMPTY_INSPECT_CATALOG),
            runtimeAccountScript(framework, undefined, { fetchUsage })
        ].join('\n')
        const result = await this.exec(
            this.spritesClientFor(account),
            host.spriteName,
            {
                cmd: ['bash', '-lc', script],
                stdin: '',
                timeoutMs: SANDBOX_EXEC_TIMEOUT_MS
            }
        )
        if (result.exitCode !== 0)
            throw new Error(
                result.stderr.trim() ||
                    `account inspect exited with code ${result.exitCode}`
            )
        return this.viewFromProbe(
            row,
            mergeSandboxProbe(result.stdout),
            hostView
        )
    }

    // Public seam for the auth-profiles listing, which receives the ambient
    // probe from the same host RPC and must render it identically.
    fromProbe(
        row: AgentRuntimeRow,
        raw: unknown,
        host: HostView
    ): RuntimeAccountView {
        return this.viewFromProbe(row, raw, host)
    }

    private viewFromProbe(
        row: AgentRuntimeRow,
        raw: unknown,
        host: HostView
    ): RuntimeAccountView {
        const probe = parseRuntimeAccountProbe(raw)
        if (!probe)
            return this.view(row, 'probe-failed', {
                host,
                error: 'host returned no account probe'
            })
        const evaluated = runtimeLocalCredentialStatus(
            probe.credentialFacts,
            Date.now(),
            credentialContextFor(row.kind)
        )
        return {
            ...this.view(row, 'ok', { host }),
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
        status: RuntimeAccountViewStatus,
        extra: { host?: HostView; error?: string | null } = {}
    ): RuntimeAccountView {
        return {
            runtimeId: row.id,
            framework: row.framework,
            kind: row.kind,
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

    // Seams so tests can fake the sprites.dev control plane and exec transport
    // (same shape as SandboxesService).
    protected spritesClientFor(account: SpritesAccount): SpritesClient {
        return createSpritesClient({
            token: this.accounts.decryptToken(account),
            accountSlug: account.slug
        })
    }

    protected exec(
        client: SpritesClient,
        spriteName: string,
        opts: ExecOptions
    ): Promise<ExecResult> {
        return execSprite(client, spriteName, opts)
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
