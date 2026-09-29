import {
    agentBaseUrl,
    auditAction,
    envTextFromExtras,
    type AgentFramework
} from '@manyfold/shared'
import type { AgentRuntimeSummary } from '@manyfold/shared'
import { randomBytes, randomUUID } from 'node:crypto'
import {
    BadRequestException,
    ConflictException,
    Inject,
    Injectable,
    InternalServerErrorException,
    Logger,
    NotFoundException,
    Optional,
    type OnModuleDestroy,
    type OnModuleInit
} from '@nestjs/common'
import { eq, like, or } from 'drizzle-orm'
import { WebSocket } from 'ws'
import {
    agentCredentials,
    agentRuntimes,
    agents,
    auditLogs,
    type Database
} from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { AgentRuntimesService } from '@/modules/agent-runtimes/agent-runtimes.service'
import { HostProviderResolver } from '@/modules/hosts/providers/host-provider-resolver.service'
import { SandboxProviderRegistry } from '@/modules/hosts/providers/sandbox-provider'
import {
    RuntimeContextService,
    type RuntimeContext
} from '@/modules/hosts/runtime-context.service'
import { CryptoService } from '@/modules/secrets/crypto.service'
import { FrameworkExtensionsRegistry } from '@/modules/frameworks/framework-extensions.registry'
import type {
    ResolvedHermesCredentials,
    ResolvedOpenclawCredentials
} from '@/modules/agents/credentials/resolved-credentials'
import { mergeGeneratedCredentials } from '@/modules/agents/credentials/credential-merge'
import { inBackgroundContext } from '@/common/telemetry/background-context'
import {
    HostServices,
    type ServiceSettings
} from '@/modules/agent-runtimes/provisioning/host-services'
import { serviceFrameworkRecipe } from '@/modules/agents/bootstrap/service-frameworks'

const PROBE_ATTEMPTS = 10
const PROBE_INTERVAL_MS = 3_000

// A claim older than this with no terminal write is an interrupted toggle
// (API restart mid-orchestration); the sweep marks it error so the CAS can
// be re-claimed. Timestamps live INSIDE dashboard_state ('enabling@<ISO>')
// because unrelated writes keep refreshing the row's updatedAt.
const STALE_TOGGLE_MS = 15 * 60_000
const SWEEP_INTERVAL_MS = 60_000

// The dashboard/control-UI surface: a toggle rewrites the framework's config
// and has the host's daemon restart its services (ADR-0035), on a sandbox and
// a cloud computer alike. The hermes dashboard is sandbox-only — the k8s host
// shape (cookie-authed `-dashboard` ingress sidecar) was retired with zero
// enabled rows measured on prod and staging [2026-08-28]; on a sandbox its
// front proxy takes over the public URL. Deliberately does NOT depend on
// AgentsService — AgentsModule imports this module, so that edge would be a
// cycle.
@Injectable()
export class RuntimeDashboardService implements OnModuleInit, OnModuleDestroy {
    private readonly log = new Logger(RuntimeDashboardService.name)
    private sweepTimer: ReturnType<typeof setInterval> | null = null

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly runtimes: AgentRuntimesService,
        private readonly context: RuntimeContextService,
        private readonly hostClients: HostProviderResolver,
        private readonly providers: SandboxProviderRegistry,
        private readonly crypto: CryptoService,
        private readonly hostServices: HostServices,
        @Optional()
        private readonly extensions: FrameworkExtensionsRegistry = new FrameworkExtensionsRegistry()
    ) {}

    onModuleInit(): void {
        this.sweepTimer = setInterval(inBackgroundContext(() => {
            void this.sweepStaleToggles()
        }), SWEEP_INTERVAL_MS)
        this.sweepTimer.unref?.()
    }

    onModuleDestroy(): void {
        if (this.sweepTimer) clearInterval(this.sweepTimer)
    }

    async setControlUi(
        callerUserId: string,
        runtimeId: string,
        enabled: boolean,
        isAdmin: boolean
    ): Promise<AgentRuntimeSummary> {
        const ctx = await this.loadRuntime(runtimeId, callerUserId, isAdmin)
        const runtime = ctx.runtime
        if (runtime.framework !== 'openclaw')
            throw new BadRequestException(
                'control UI toggle only supported for openclaw runtimes'
            )
        if (ctx.placement !== 'sprites' && ctx.placement !== 'k8s')
            throw new BadRequestException(
                'control UI toggle only supported for sandboxes and cloud computers'
            )
        if (runtime.controlUiEnabled === enabled)
            return this.runtimes.toSummary(runtime)

        await this.claimOrConflict(runtime.id, enabled)
        try {
            await this.reconfigure(ctx, { controlUiEnabled: enabled })
            await this.runtimes.applyStatusPatch(runtime.id, {
                controlUiEnabled: enabled,
                dashboardState: null
            })
            await this.audit(
                callerUserId,
                auditAction.AGENT_RUNTIME_CONTROL_UI_TOGGLED,
                runtime.id,
                {
                    enabled,
                    runtimeId: runtime.id,
                    primaryAgentId: runtime.primaryAgentId,
                    ownerUserId: runtime.userId,
                    onBehalfOf: callerUserId !== runtime.userId
                }
            )
        } catch (err) {
            const reason = sanitizeReason(err)
            await this.runtimes.applyStatusPatch(runtime.id, {
                dashboardState: `error:${reason}`
            })
            await this.audit(
                callerUserId,
                auditAction.AGENT_RUNTIME_CONTROL_UI_TOGGLE_FAILED,
                runtime.id,
                {
                    enabled,
                    reason,
                    runtimeId: runtime.id,
                    primaryAgentId: runtime.primaryAgentId,
                    ownerUserId: runtime.userId,
                    onBehalfOf: callerUserId !== runtime.userId
                }
            )
            throw new InternalServerErrorException({
                message: 'failed to toggle openclaw control UI',
                reason
            })
        }
        return this.refreshedSummary(runtime.id)
    }

    // A service framework's config rewritten and its services restarted on
    // its host's daemon with the runtime's own settings: an operator's
    // repair, and how a cutover moves a runtime onto its daemon's services.
    async restartService(
        callerUserId: string,
        runtimeId: string,
        isAdmin: boolean
    ): Promise<AgentRuntimeSummary> {
        const ctx = await this.loadRuntime(runtimeId, callerUserId, isAdmin)
        const runtime = ctx.runtime
        if (!serviceFrameworkRecipe(runtime.framework))
            throw new BadRequestException(
                `${runtime.framework} runs no service to restart`
            )
        if (ctx.placement !== 'sprites' && ctx.placement !== 'k8s')
            throw new BadRequestException(
                'service restart is only supported on sandboxes and cloud computers'
            )
        await this.reconfigure(ctx, {})
        await this.audit(
            callerUserId,
            auditAction.AGENT_RUNTIME_SERVICE_RESTARTED,
            runtime.id,
            {
                runtimeId: runtime.id,
                framework: runtime.framework,
                ownerUserId: runtime.userId,
                onBehalfOf: callerUserId !== runtime.userId
            }
        )
        return this.refreshedSummary(runtime.id)
    }

    async setDashboard(
        callerUserId: string,
        runtimeId: string,
        enabled: boolean,
        isAdmin: boolean
    ): Promise<AgentRuntimeSummary> {
        const ctx = await this.loadRuntime(runtimeId, callerUserId, isAdmin)
        const runtime = ctx.runtime
        if (runtime.framework !== 'hermes')
            throw new BadRequestException(
                'dashboard toggle only supported for hermes runtimes'
            )
        if (ctx.placement !== 'sprites' || !ctx.host)
            throw new BadRequestException(
                'dashboard toggle only supported for sprites runtimes'
            )
        // Disable on an already-disabled runtime is a no-op; enable when the
        // flag is already true still re-runs the (idempotent) choreography as
        // a repair path for drifted services.
        if (!enabled && !runtime.dashboardEnabled && !runtime.dashboardState)
            return this.runtimes.toSummary(runtime)

        await this.claimOrConflict(runtime.id, enabled)
        // The first enable builds the hermes web UI (npm install + vite) —
        // minutes, longer than any proxy timeout. Claim, kick the work into
        // the background, and return immediately; dashboardState carries
        // progress and the flag flips only on success.
        void this.runDashboardToggle(callerUserId, ctx, enabled).catch(
            (err) =>
                this.log.error(
                    `dashboard toggle job crashed runtimeId=${runtime.id}: ${(err as Error).message}`
                )
        )
        return this.refreshedSummary(runtime.id)
    }

    async getControlUiUrl(
        runtimeId: string,
        callerUserId: string,
        isAdmin: boolean,
        agentId?: string
    ): Promise<{ url: string }> {
        const ctx = await this.loadRuntime(runtimeId, callerUserId, isAdmin)
        const runtime = ctx.runtime
        const controlUi = this.extensions.get(runtime.framework)?.controlUi
        if (
            runtime.framework !== 'openclaw' &&
            runtime.framework !== 'hermes' &&
            !controlUi
        )
            throw new BadRequestException(
                'control UI URL not supported for this framework'
            )
        if (runtime.framework === 'openclaw' && !runtime.controlUiEnabled)
            throw new BadRequestException(
                'control UI is disabled for this runtime'
            )
        if (runtime.framework === 'hermes' && !runtime.dashboardEnabled)
            throw new BadRequestException(
                'dashboard is disabled for this runtime'
            )
        if (runtime.framework === 'hermes' && ctx.placement !== 'sprites')
            // The legacy k8s dashboard host (cookie-authed `-dashboard`
            // ingress sidecar) was removed; only a pre-removal row could
            // still carry dashboardEnabled here, and falling through would
            // 500 on the missing dashboardToken. Before the audit write, so
            // a refusal never records a mint.
            throw new BadRequestException(
                'the hermes dashboard is sprite-only; k8s dashboard hosting was removed'
            )
        const ingressHost = await this.ingressHostFor(ctx)
        if (!ingressHost)
            throw new BadRequestException('runtime has no ingress host')

        // The URL we hand back is per-agent only for an agent-scoped control
        // UI (its link names the agent). For openclaw/hermes the URL is
        // runtime-scoped; we keep the caller-supplied agentId in the audit
        // log so admin lookups still show which agent's dashboard was opened.
        const resolvedAgentId = controlUi?.agentScoped
            ? (agentId ?? runtime.primaryAgentId ?? null)
            : (agentId ?? null)

        await this.audit(
            callerUserId,
            auditAction.AGENT_RUNTIME_CONTROL_UI_URL_MINTED,
            runtime.id,
            {
                runtimeId: runtime.id,
                primaryAgentId: runtime.primaryAgentId,
                ownerUserId: runtime.userId,
                onBehalfOf: callerUserId !== runtime.userId,
                agentId: resolvedAgentId
            }
        )

        const credsPlain = await this.decryptCreds(runtime.id)

        if (runtime.framework === 'hermes') {
            const parsed = credsPlain as ResolvedHermesCredentials
            if (!parsed.dashboardToken)
                throw new InternalServerErrorException(
                    `runtime ${runtime.id} credentials missing dashboardToken — re-enable the dashboard`
                )
            return {
                url: agentBaseUrl(
                    ingressHost,
                    `/?token=${encodeURIComponent(parsed.dashboardToken)}`
                )
            }
        }

        if (controlUi) {
            let agentInternalId: string | null = null
            if (resolvedAgentId) {
                const [agentRow] = await this.db
                    .select({ internalId: agents.internalId })
                    .from(agents)
                    .where(eq(agents.id, resolvedAgentId))
                    .limit(1)
                agentInternalId = agentRow?.internalId ?? null
            }
            return {
                url: controlUi.mint({
                    runtime: { ...runtime, ingressHost },
                    credentials: credsPlain as Record<string, unknown>,
                    agentInternalId
                })
            }
        }

        const creds = credsPlain as unknown as ResolvedOpenclawCredentials
        if (!creds.gatewayToken)
            throw new InternalServerErrorException(
                `runtime ${runtime.id} credentials missing gatewayToken — rebuild the runtime`
            )
        return {
            url: agentBaseUrl(
                ingressHost,
                `/#token=${encodeURIComponent(creds.gatewayToken)}`
            )
        }
    }

    // A service framework's public entry is the host's provider adapter's to
    // derive from the machine's provider ref (ADR-0037); nothing on the
    // runtime row.
    private async ingressHostFor(ctx: RuntimeContext): Promise<string | null> {
        if (!ctx.host || !ctx.providerKind) return null
        const provider = await this.hostClients.providerForHost(ctx.host)
        const url = this.providers.for(ctx.providerKind).publicUrl?.({
            host: ctx.host,
            provider,
            framework: ctx.runtime.framework,
            port: this.servicePortFor(ctx.runtime.framework)
        })
        if (!url) return null
        try {
            return new URL(url).host || null
        } catch {
            return null
        }
    }

    // The port the framework's UI is served on inside the machine, else the
    // public https port (both providers route by name, not port).
    private servicePortFor(framework: AgentFramework): number {
        return serviceFrameworkRecipe(framework)?.port ?? 443
    }

    // Background half of the async hermes toggle: persists the dashboard
    // token, runs the service choreography, then resolves dashboard_state.
    private async runDashboardToggle(
        callerUserId: string,
        ctx: RuntimeContext,
        enabled: boolean
    ): Promise<void> {
        const runtime = ctx.runtime
        try {
            if (enabled) await this.ensureDashboardToken(runtime.id)
            await this.switchDashboard(ctx, enabled)
            await this.runtimes.applyStatusPatch(runtime.id, {
                dashboardEnabled: enabled,
                dashboardState: null
            })
            await this.audit(
                callerUserId,
                auditAction.AGENT_RUNTIME_DASHBOARD_TOGGLED,
                runtime.id,
                {
                    enabled,
                    runtimeId: runtime.id,
                    primaryAgentId: runtime.primaryAgentId,
                    ownerUserId: runtime.userId,
                    onBehalfOf: callerUserId !== runtime.userId
                }
            )
        } catch (err) {
            const reason = sanitizeReason(err)
            // A failed disable rolls back to the ENABLED topology (chat must
            // stay routable), so the flag is left untouched either way — only
            // the state records the failure.
            await this.runtimes
                .applyStatusPatch(runtime.id, {
                    dashboardState: `error:${reason}`
                })
                .catch(() => undefined)
            await this.audit(
                callerUserId,
                auditAction.AGENT_RUNTIME_DASHBOARD_TOGGLE_FAILED,
                runtime.id,
                {
                    enabled,
                    reason,
                    runtimeId: runtime.id,
                    primaryAgentId: runtime.primaryAgentId,
                    ownerUserId: runtime.userId,
                    onBehalfOf: callerUserId !== runtime.userId
                }
            )
        }
    }

    private async claimOrConflict(
        runtimeId: string,
        enabled: boolean
    ): Promise<void> {
        const claim = `${enabled ? 'enabling' : 'disabling'}@${new Date().toISOString()}`
        const claimed = await this.runtimes.claimDashboardState(
            runtimeId,
            claim
        )
        if (!claimed)
            throw new ConflictException(
                'a dashboard toggle is already in progress for this runtime'
            )
    }

    // Reuse the stored token across toggles so previously minted URLs keep
    // working after a disable/enable cycle; generate once via the locked
    // credential merge (concurrent writers share one row lock).
    private async ensureDashboardToken(runtimeId: string): Promise<void> {
        const merged = await mergeGeneratedCredentials(
            this.db,
            this.crypto,
            runtimeId,
            (current) => {
                const existing = current.dashboardToken
                if (typeof existing === 'string' && existing.length > 0)
                    return null
                return {
                    ...current,
                    dashboardToken: randomBytes(32).toString('hex')
                }
            }
        )
        if (!merged)
            throw new InternalServerErrorException(
                `no stored credentials for runtime ${runtimeId}`
            )
    }

    // The framework's config rewritten and its services restarted with one
    // setting changed; the rest are the runtime's own, and its env the
    // primary agent's.
    private async reconfigure(
        ctx: RuntimeContext,
        change: Partial<ServiceSettings>
    ): Promise<void> {
        const { runtime, host } = ctx
        if (!host)
            throw new BadRequestException(`runtime ${runtime.id} has no host`)
        const [agent] = runtime.primaryAgentId
            ? await this.db
                  .select({ extras: agents.extras })
                  .from(agents)
                  .where(eq(agents.id, runtime.primaryAgentId))
                  .limit(1)
            : []
        await this.hostServices.reconfigure(runtime, host, {
            credentials: await this.decryptCreds(runtime.id),
            envText: agent ? (envTextFromExtras(agent.extras) ?? null) : null,
            controlUiEnabled: runtime.controlUiEnabled,
            dashboardEnabled: runtime.dashboardEnabled,
            ...change
        })
    }

    // The hermes dashboard switched on a sandbox, proved through its public
    // URL, and rolled back to the other topology when that fails: chat must
    // never be left unroutable. Enabled, the front proxy serves /v1 from the
    // gateway, refuses the UI's HTML without the token, and passes the UI's
    // WebSocket with the Origin a browser sends; disabled, the gateway
    // answers directly.
    private async switchDashboard(
        ctx: RuntimeContext,
        enabled: boolean
    ): Promise<void> {
        await this.reconfigure(ctx, { dashboardEnabled: enabled })
        try {
            const base = await this.publicBaseUrl(ctx)
            await this.probe(`${base}/v1/health`, (status) => status === 200, enabled ? 'gateway /v1/health via proxy' : 'gateway /v1/health direct')
            if (enabled) {
                await this.probe(`${base}/`, (status) => status === 401, 'tokenless dashboard root returns 401')
                const creds = (await this.decryptCreds(ctx.runtime.id)) as ResolvedHermesCredentials
                await this.probeWs(
                    `${base.replace(/^http/, 'ws')}/api/ws?token=${encodeURIComponent(creds.dashboardToken ?? '')}`,
                    base,
                    'dashboard /api/ws handshake with browser Origin'
                )
            }
        } catch (err) {
            this.log.warn(
                `dashboard ${enabled ? 'enable' : 'disable'} rolled back runtimeId=${ctx.runtime.id}: ${(err as Error).message}`
            )
            await this.reconfigure(ctx, { dashboardEnabled: !enabled }).catch(
                (rollbackErr: Error) =>
                    this.log.error(
                        `dashboard rollback failed runtimeId=${ctx.runtime.id}: ${rollbackErr.message}`
                    )
            )
            throw err
        }
    }

    private async publicBaseUrl(ctx: RuntimeContext): Promise<string> {
        const ingressHost = await this.ingressHostFor(ctx)
        if (!ingressHost)
            throw new InternalServerErrorException(
                `runtime ${ctx.runtime.id} has no public URL`
            )
        return `https://${ingressHost}`
    }

    private async probe(
        url: string,
        ok: (status: number) => boolean,
        label: string
    ): Promise<void> {
        let last: number | string = 'unreachable'
        for (let attempt = 0; attempt < PROBE_ATTEMPTS; attempt++) {
            try {
                const res = await fetch(url, { signal: AbortSignal.timeout(5_000) })
                last = res.status
                await res.arrayBuffer().catch(() => undefined)
                if (ok(res.status)) return
            } catch {
                last = 'unreachable'
            }
            await new Promise((resolve) => setTimeout(resolve, PROBE_INTERVAL_MS))
        }
        throw new InternalServerErrorException(
            `probe failed (${label}): last status ${last} at ${url}`
        )
    }

    // The URL carries the dashboard token as a query param; error messages
    // flow into logs and the persisted dashboard_state, so only the path is
    // ever reported.
    private async probeWs(url: string, origin: string, label: string): Promise<void> {
        let last = 'unreachable'
        for (let attempt = 0; attempt < PROBE_ATTEMPTS; attempt++) {
            try {
                await new Promise<void>((resolve, reject) => {
                    const ws = new WebSocket(url, { origin, handshakeTimeout: 5_000 })
                    ws.once('open', () => {
                        ws.terminate()
                        resolve()
                    })
                    ws.once('unexpected-response', (_req, res) => {
                        ws.terminate()
                        reject(new Error(`handshake rejected with status ${res.statusCode}`))
                    })
                    ws.once('error', (err) => reject(err))
                })
                return
            } catch (err) {
                last = (err as Error).message
            }
            await new Promise((resolve) => setTimeout(resolve, PROBE_INTERVAL_MS))
        }
        throw new InternalServerErrorException(
            `probe failed (${label}): ${last} at ${url.split('?')[0]}`
        )
    }

    private async decryptCreds(
        runtimeId: string
    ): Promise<Record<string, unknown>> {
        const [row] = await this.db
            .select()
            .from(agentCredentials)
            .where(eq(agentCredentials.runtimeId, runtimeId))
            .limit(1)
        if (!row)
            throw new NotFoundException(
                `no stored credentials for runtime ${runtimeId}`
            )
        return JSON.parse(
            this.crypto.decrypt({
                ciphertext: row.payloadCiphertext,
                keyVersion: row.keyVersion
            })
        ) as Record<string, unknown>
    }

    private async loadRuntime(
        runtimeId: string,
        callerUserId: string,
        isAdmin: boolean
    ): Promise<RuntimeContext> {
        const ctx = await this.context.forRuntime(runtimeId)
        if (!ctx || (!isAdmin && ctx.runtime.userId !== callerUserId))
            throw new NotFoundException(`agent runtime ${runtimeId} not found`)
        return ctx
    }

    private async refreshedSummary(
        runtimeId: string
    ): Promise<AgentRuntimeSummary> {
        const refreshed = await this.runtimes.findById(runtimeId)
        if (!refreshed)
            throw new InternalServerErrorException(
                `runtime ${runtimeId} vanished during dashboard toggle`
            )
        return this.runtimes.toSummary(refreshed)
    }

    private async sweepStaleToggles(): Promise<void> {
        try {
            const rows = await this.db
                .select({
                    id: agentRuntimes.id,
                    userId: agentRuntimes.userId,
                    dashboardState: agentRuntimes.dashboardState
                })
                .from(agentRuntimes)
                .where(
                    or(
                        like(agentRuntimes.dashboardState, 'enabling@%'),
                        like(agentRuntimes.dashboardState, 'disabling@%')
                    )
                )
            const now = Date.now()
            for (const row of rows) {
                const at = Date.parse(
                    row.dashboardState?.split('@')[1] ?? ''
                )
                if (Number.isNaN(at) || now - at < STALE_TOGGLE_MS) continue
                await this.runtimes.applyStatusPatch(row.id, {
                    dashboardState: 'error:interrupted'
                })
                await this.audit(
                    row.userId,
                    auditAction.AGENT_RUNTIME_DASHBOARD_TOGGLE_FAILED,
                    row.id,
                    {
                        reason: 'interrupted',
                        swept: true,
                        staleState: row.dashboardState,
                        runtimeId: row.id
                    }
                )
                this.log.warn(
                    `swept stale dashboard toggle runtimeId=${row.id} state=${row.dashboardState}`
                )
            }
        } catch (err) {
            this.log.warn(
                `dashboard-state sweep failed: ${(err as Error).message}`
            )
        }
    }

    private async audit(
        actorId: string,
        action: string,
        subject: string,
        meta: Record<string, unknown>
    ): Promise<void> {
        try {
            await this.db.insert(auditLogs).values({
                id: randomUUID(),
                actorId,
                action,
                subject,
                meta
            })
        } catch (err) {
            this.log.warn(
                `audit write failed: ${(err as Error).message} action=${action}`
            )
        }
    }
}

const sanitizeReason = (err: unknown): string => {
    const msg = (err as Error)?.message ?? 'unknown error'
    return msg.slice(0, 512).replace(/Bearer\s+\S+/g, 'Bearer [REDACTED]')
}
