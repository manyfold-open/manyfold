import {
    DAEMON_FEATURE_ACCOUNT_INSPECT,
    parseRuntimeAccountProbe,
    runtimeAccountSupport,
    runtimeAccountUsage,
    runtimeLocalCredentialStatus
} from '@manyfold/shared'
import type {
    ConfigurableFramework,
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
import { RuntimeAccessService } from '@/modules/runtime-access/runtime-access.service'
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

@Injectable()
export class RuntimeAccountService {
    private readonly log = new Logger(RuntimeAccountService.name)
    private readonly cache = new Map<
        string,
        { until: number; view: RuntimeAccountView }
    >()
    private readonly inflight = new Map<string, Promise<RuntimeAccountView>>()

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
        opts: { wake: boolean }
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
            !(opts.wake && cached.view.status === 'sandbox-asleep')
        )
            return cached.view
        const key = `${row.id}:${opts.wake ? 'wake' : 'peek'}`
        const pending = this.inflight.get(key)
        if (pending) return pending
        const promise = this.probe(row, opts.wake)
            .then((view) => {
                const retryAfter = view.usage?.error?.retryAfterSeconds
                const ttl =
                    view.usage?.error?.kind === 'rate-limited' && retryAfter
                        ? retryAfter * 1000
                        : CACHE_TTL_MS
                this.cache.set(row.id, { until: Date.now() + ttl, view })
                return view
            })
            .finally(() => this.inflight.delete(key))
        this.inflight.set(key, promise)
        return promise
    }

    private async probe(
        row: AgentRuntimeRow,
        wake: boolean
    ): Promise<RuntimeAccountView> {
        const framework = row.framework as ConfigurableFramework
        try {
            return row.kind === 'daemon'
                ? await this.probeDaemon(row, framework)
                : await this.probeSandbox(row, framework, wake)
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

    private async probeDaemon(
        row: AgentRuntimeRow,
        framework: ConfigurableFramework
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
            payload: { framework },
            timeoutMs: DAEMON_RPC_TIMEOUT_MS
        })
        return this.viewFromProbe(row, payload, null)
    }

    private async probeSandbox(
        row: AgentRuntimeRow,
        framework: ConfigurableFramework,
        wake: boolean
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
        await this.runtimeAccess.reserveActiveSlot({
            userId: row.userId,
            hostId: host.id
        })
        const account = await this.accounts.getById(host.accountId)
        if (!account)
            return this.view(row, 'probe-failed', {
                host: hostView,
                error: 'sandbox account unavailable'
            })
        const script = [
            'export PATH="$HOME/.local/bin:$PATH"',
            runtimeInspectScript(framework, EMPTY_INSPECT_CATALOG),
            runtimeAccountScript(framework)
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
