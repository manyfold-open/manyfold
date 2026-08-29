import {
    agentBaseUrl,
    auditAction,
    envTextFromExtras
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
    type Database
} from '@manyfold/db'
import {
    createClient as createSpritesClient,
    type SpritesLogger
} from '@manyfold/sprites'
import { DRIZZLE } from '@/db/tokens'
import { AgentRuntimesService } from '@/modules/agent-runtimes/agent-runtimes.service'
import { K8sRuntimeSidecarService } from '@/modules/agent-runtimes/orchestration/k8s-runtime-sidecar.service'
import { SpritesAccountsService } from '@/modules/sprites-accounts/sprites-accounts.service'
import { CryptoService } from '@/modules/secrets/crypto.service'
import { buildNarraNexusDeepLink } from '@/modules/narranexus/narranexus-deep-link'
import { HermesSpriteBootstrap } from '@/modules/agents/bootstrap/hermes-sprite'
import { OpenClawSpriteBootstrap } from '@/modules/agents/bootstrap/openclaw-sprite'
import type { BootstrapContext } from '@/modules/agents/bootstrap/framework-bootstrap'
import type {
    ResolvedHermesCredentials,
    ResolvedOpenclawCredentials
} from '@/modules/agents/credentials/resolved-credentials'
import { mergeGeneratedCredentials } from '@/modules/agents/credentials/credential-merge'

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

// Runtime-kind dispatcher for the dashboard/control-UI surface: sprite rows
// get the sprite service choreography; openclaw control-UI on k8s still
// delegates to the sidecar service. The hermes dashboard is sprite-only —
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
        private readonly k8sSidecar: K8sRuntimeSidecarService,
        private readonly accounts: SpritesAccountsService,
        private readonly crypto: CryptoService,
        private readonly hermesBootstrap: HermesSpriteBootstrap,
        private readonly openclawBootstrap: OpenClawSpriteBootstrap
    ) {}

    onModuleInit(): void {
        this.sweepTimer = setInterval(() => {
            void this.sweepStaleToggles()
        }, SWEEP_INTERVAL_MS)
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
        const runtime = await this.loadRuntime(runtimeId, callerUserId, isAdmin)
        if (runtime.framework !== 'openclaw')
            throw new BadRequestException(
                'control UI toggle only supported for openclaw runtimes'
            )
        if (runtime.kind !== 'sprites')
            return this.k8sSidecar.setControlUi(
                callerUserId,
                runtimeId,
                enabled,
                isAdmin
            )
        if (runtime.controlUiEnabled === enabled)
            return this.runtimes.toSummary(runtime)

        await this.claimOrConflict(runtime.id, enabled)
        try {
            const target = await this.buildSpriteTarget(runtime)
            await this.openclawBootstrap.setControlUi(
                target.ctx,
                target.creds,
                enabled
            )
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
        const runtime = await this.loadRuntime(runtimeId, callerUserId, isAdmin)
        if (runtime.framework !== 'hermes')
            throw new BadRequestException(
                'dashboard toggle only supported for hermes runtimes'
            )
        if (runtime.kind !== 'sprites')
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
        void this.runDashboardToggle(callerUserId, runtime, enabled).catch(
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
        const runtime = await this.loadRuntime(runtimeId, callerUserId, isAdmin)
        if (
            runtime.framework !== 'openclaw' &&
            runtime.framework !== 'narranexus' &&
            runtime.framework !== 'hermes'
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
        if (runtime.framework === 'hermes' && runtime.kind !== 'sprites')
            // The legacy k8s dashboard host (cookie-authed `-dashboard`
            // ingress sidecar) was removed; only a pre-removal row could
            // still carry dashboardEnabled here, and falling through would
            // 500 on the missing dashboardToken. Before the audit write, so
            // a refusal never records a mint.
            throw new BadRequestException(
                'the hermes dashboard is sprite-only; k8s dashboard hosting was removed'
            )
        if (!runtime.ingressHost)
            throw new BadRequestException('runtime has no ingress host')

        // The URL we hand back is per-agent only for narranexus (its deep
        // link carries an `agent=` param). For openclaw/hermes the URL is
        // runtime-scoped; we keep the caller-supplied agentId in the audit
        // log so admin lookups still show which agent's dashboard was opened.
        const resolvedAgentId =
            runtime.framework === 'narranexus'
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
                    runtime.ingressHost,
                    `/?token=${encodeURIComponent(parsed.dashboardToken)}`
                )
            }
        }

        if (runtime.framework === 'narranexus') {
            const parsed = credsPlain as { gatewayToken?: string }
            if (!parsed.gatewayToken)
                throw new InternalServerErrorException(
                    `runtime ${runtime.id} credentials missing gatewayToken — rebuild the runtime`
                )
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
                url: buildNarraNexusDeepLink({
                    ingressHost: runtime.ingressHost,
                    gatewayToken: parsed.gatewayToken,
                    manyfoldUserId: runtime.userId,
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
                runtime.ingressHost,
                `/#token=${encodeURIComponent(creds.gatewayToken)}`
            )
        }
    }

    // Background half of the async hermes toggle: persists the dashboard
    // token, runs the service choreography, then resolves dashboard_state.
    private async runDashboardToggle(
        callerUserId: string,
        runtime: AgentRuntimeRow,
        enabled: boolean
    ): Promise<void> {
        try {
            if (enabled) await this.ensureDashboardToken(runtime.id)
            const target = await this.buildSpriteTarget(runtime)
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
        runtime: AgentRuntimeRow
    ): Promise<SpriteToggleTarget> {
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
        if (!agent.accountId || !agent.spriteName)
            throw new BadRequestException('agent has no sprite')
        const account = await this.accounts.getById(agent.accountId)
        if (!account)
            throw new InternalServerErrorException(
                `sprites account ${agent.accountId} not found`
            )
        const client = createSpritesClient({
            token: this.accounts.decryptToken(account),
            accountSlug: account.slug
        })
        const creds = await this.decryptCreds(runtime.id)
        const ctx: BootstrapContext = {
            agentId: agent.id,
            runtimeId: runtime.id,
            userId: agent.userId,
            spriteName: agent.spriteName,
            mountPath: agent.mountPath,
            client,
            logger: this.spritesLogger(),
            envText: envTextFromExtras(agent.extras) ?? null,
            controlUiEnabled: runtime.controlUiEnabled,
            dashboardEnabled: runtime.dashboardEnabled
        }
        return { ctx, creds }
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
    ): Promise<AgentRuntimeRow> {
        const row = await this.runtimes.findById(runtimeId)
        if (!row || (!isAdmin && row.userId !== callerUserId))
            throw new NotFoundException(`agent runtime ${runtimeId} not found`)
        return row
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
