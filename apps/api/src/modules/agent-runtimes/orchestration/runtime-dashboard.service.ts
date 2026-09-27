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
import {
    agentCredentials,
    agentRuntimes,
    agents,
    auditLogs,
    type AgentRuntimeRow,
    type Database,
    type RuntimeHostRow
} from '@manyfold/db'
import type { SpritesLogger } from '@manyfold/sprites'
import { DRIZZLE } from '@/db/tokens'
import { AgentRuntimesService } from '@/modules/agent-runtimes/agent-runtimes.service'
import { HostProviderClients } from '@/modules/hosts/providers/host-provider-clients.service'
import { SandboxProviderRegistry } from '@/modules/hosts/providers/sandbox-provider'
import {
    RuntimeContextService,
    type RuntimeContext
} from '@/modules/hosts/runtime-context.service'
import { CryptoService } from '@/modules/secrets/crypto.service'
import { FrameworkExtensionsRegistry } from '@/modules/frameworks/framework-extensions.registry'
import { HermesSpriteBootstrap } from '@/modules/agents/bootstrap/hermes-sprite'
import { OpenClawSpriteBootstrap } from '@/modules/agents/bootstrap/openclaw-sprite'
import type { BootstrapContext } from '@/modules/agents/bootstrap/framework-bootstrap'
import type {
    ResolvedHermesCredentials,
    ResolvedOpenclawCredentials
} from '@/modules/agents/credentials/resolved-credentials'
import { mergeGeneratedCredentials } from '@/modules/agents/credentials/credential-merge'
import { inBackgroundContext } from '@/common/telemetry/background-context'
import { HERMES_PORT } from '@/modules/agents/bootstrap/hermes-shared'
import { OPENCLAW_PORT } from '@/modules/agents/bootstrap/openclaw-shared'
import { PodHostServices } from '@/modules/agent-runtimes/provisioning/pod-host-services'
import { podServiceRecipe } from '@/modules/agent-runtimes/provisioning/pod-service-frameworks'
import { podScriptRunner } from '@/modules/agent-runtimes/provisioning/pod-framework-setup'

const POD_SERVICE_READY_TIMEOUT_MS = 180_000

// A claim older than this with no terminal write is an interrupted toggle
// (API restart mid-orchestration); the sweep marks it error so the CAS can
// be re-claimed. Timestamps live INSIDE dashboard_state ('enabling@<ISO>')
// because unrelated writes keep refreshing the row's updatedAt.
const STALE_TOGGLE_MS = 15 * 60_000
const SWEEP_INTERVAL_MS = 60_000

interface SpriteToggleTarget {
    ctx: BootstrapContext
    creds: Record<string, unknown>
}

// Placement dispatcher for the dashboard/control-UI surface: a runtime on a
// sprites host gets the sprite service choreography, and one on a pod host
// rewrites the config and has the host's daemon restart the service
// (ADR-0035). The hermes dashboard is sprite-only —
// the k8s host shape (cookie-authed `-dashboard` ingress sidecar) was
// retired with zero enabled rows measured on prod and staging [2026-08-28].
// Deliberately does NOT depend on AgentsService — AgentsModule imports this
// module, so that edge would be a cycle.
@Injectable()
export class RuntimeDashboardService implements OnModuleInit, OnModuleDestroy {
    private readonly log = new Logger(RuntimeDashboardService.name)
    private sweepTimer: ReturnType<typeof setInterval> | null = null

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly runtimes: AgentRuntimesService,
        private readonly context: RuntimeContextService,
        private readonly hostClients: HostProviderClients,
        private readonly providers: SandboxProviderRegistry,
        private readonly crypto: CryptoService,
        private readonly hermesBootstrap: HermesSpriteBootstrap,
        private readonly openclawBootstrap: OpenClawSpriteBootstrap,
        @Optional()
        private readonly extensions: FrameworkExtensionsRegistry = new FrameworkExtensionsRegistry(),
        // Same convention; absent, a pod host's toggle is refused.
        @Optional() private readonly podServices?: PodHostServices
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
            if (ctx.placement === 'k8s')
                await this.reconfigurePodService(runtime, ctx.host!, enabled)
            else {
                const target = await this.buildSpriteTarget(ctx)
                await this.openclawBootstrap.setControlUi(
                    target.ctx,
                    target.creds,
                    enabled
                )
            }
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
        if (ctx.placement !== 'sprites')
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
    // derive from the machine's provider ref (ADR-0036); nothing on the
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

    // The port the framework's UI is served on inside the machine: the
    // built-in gateways' own, an edition framework's from its health URL,
    // else the public https port (both providers route by name, not port).
    private servicePortFor(framework: AgentFramework): number {
        if (framework === 'hermes') return HERMES_PORT
        if (framework === 'openclaw') return OPENCLAW_PORT
        const healthUrl =
            this.extensions.get(framework)?.spriteService?.supervision.healthUrl
        if (healthUrl) {
            try {
                const port = Number(new URL(healthUrl).port)
                if (port > 0) return port
            } catch {
                // not a URL: fall through to the public port
            }
        }
        return 443
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
            const target = await this.buildSpriteTarget(ctx)
            if (enabled)
                await this.hermesBootstrap.enableDashboard(
                    target.ctx,
                    target.creds
                )
            else
                await this.hermesBootstrap.disableDashboard(
                    target.ctx,
                    target.creds
                )
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

    private async buildSpriteTarget(
        ctx: RuntimeContext
    ): Promise<SpriteToggleTarget> {
        const runtime = ctx.runtime
        if (!runtime.primaryAgentId)
            throw new InternalServerErrorException(
                `runtime ${runtime.id} has no primaryAgentId`
            )
        const [agent] = await this.db
            .select()
            .from(agents)
            .where(eq(agents.id, runtime.primaryAgentId))
            .limit(1)
        if (!agent)
            throw new NotFoundException(
                `agent ${runtime.primaryAgentId} not found for runtime ${runtime.id}`
            )
        if (!ctx.host || ctx.host.providerRef?.kind !== 'sprites')
            throw new BadRequestException('agent has no sprite')
        const { client, spriteName } =
            await this.hostClients.spritesClientForHost(ctx.host)
        const creds = await this.decryptCreds(runtime.id)
        const bootstrap: BootstrapContext = {
            agentId: agent.id,
            runtimeId: runtime.id,
            userId: agent.userId,
            spriteName,
            mountPath: agent.mountPath,
            client,
            logger: this.spritesLogger(),
            envText: envTextFromExtras(agent.extras) ?? null,
            controlUiEnabled: runtime.controlUiEnabled,
            dashboardEnabled: runtime.dashboardEnabled
        }
        return { ctx: bootstrap, creds }
    }

    // The config and service of a framework on a pod host, rewritten for
    // this control UI setting and restarted by the host's daemon.
    private async reconfigurePodService(
        runtime: AgentRuntimeRow,
        host: RuntimeHostRow,
        controlUiEnabled: boolean
    ): Promise<void> {
        const recipe = podServiceRecipe(runtime.framework)
        if (!recipe || !this.podServices)
            throw new BadRequestException(
                `${runtime.framework} has no service on this cloud computer`
            )
        const exec = await this.hostClients.podExecForHost(host)
        // The service's env carries the runtime's agent env, as on a sprite.
        const [agent] = runtime.primaryAgentId
            ? await this.db
                  .select({ extras: agents.extras })
                  .from(agents)
                  .where(eq(agents.id, runtime.primaryAgentId))
                  .limit(1)
            : []
        const setup = await recipe.configure(
            podScriptRunner(exec, (event, fields) =>
                this.log.warn(`${event} ${JSON.stringify(fields)}`)
            ),
            {
                credentials: await this.decryptCreds(runtime.id),
                envText: agent ? (envTextFromExtras(agent.extras) ?? null) : null,
                controlUiEnabled
            }
        )
        const target = { id: host.id, userId: host.userId }
        await this.podServices.upsert(target, setup.spec)
        await this.podServices.restart(target, setup.spec.name)
        await this.podServices.waitHealthy(
            target,
            setup.spec.name,
            POD_SERVICE_READY_TIMEOUT_MS
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

    private spritesLogger(): SpritesLogger {
        return {
            debug: () => {},
            info: (m, meta) =>
                this.log.log(`[sprites] ${m} ${JSON.stringify(meta ?? {})}`),
            warn: (m, meta) =>
                this.log.warn(`[sprites] ${m} ${JSON.stringify(meta ?? {})}`),
            error: (m, meta) =>
                this.log.error(`[sprites] ${m} ${JSON.stringify(meta ?? {})}`)
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
