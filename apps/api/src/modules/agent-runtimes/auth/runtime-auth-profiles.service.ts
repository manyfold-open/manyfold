import {
    ConflictException,
    ForbiddenException,
    Inject,
    Injectable,
    Logger,
    NotFoundException,
    ServiceUnavailableException
} from '@nestjs/common'
import { and, eq, ne } from 'drizzle-orm'
import {
    DAEMON_FEATURE_AUTH_CONTEXT,
    runtimeAuthRoot,
    runtimeAuthProfileEnv,

    DAEMON_FEATURE_AUTH_PROFILES,
    RUNTIME_AUTH_ERROR,
    createObjectId,
    parseRuntimeAccountProbe,
    runnerHostName,
    runtimeAuthSupported,
    runtimeLocalCredentialStatus,
    type ConfigurableFramework,
    type DaemonAuthCreateResponse,
    type DaemonAuthListResponse,
    type DaemonAuthLogoutResponse,
    type DaemonAuthOperationRecord,
    type DaemonAuthProfileReport,
    type DaemonPtyAuthLogin,
    type RuntimeAccountProbe,
    type RuntimeAuthAvailability,
    type RuntimeAuthCredentialStatus,
    type RuntimeAuthListView,
    type RuntimeAuthOperationView,
    type RuntimeAuthProfileView
} from '@manyfold/shared'
import {
    type Agent,
    agentRuntimes,
    agents,
    runtimeAuthOperations,
    runtimeAuthProfiles,
    runtimeHosts,
    type AgentRuntimeRow,
    type Database,
    type RuntimeAuthOperationRow,
    type RuntimeAuthProfileRow,
    type RuntimeHostRow
} from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import type { AuthPrincipal } from '@/common/guards/auth.guard'
import { DaemonHostService } from '@/modules/daemon/daemon-host.service'
import { DaemonRegistryService } from '@/modules/daemon/daemon-registry.service'
import { AgentRuntimesService } from '../agent-runtimes.service'
import { RuntimeAccountService } from '../account/runtime-account.service'
import { authContextRefFor } from '@/modules/agents/model-config/runtime-auth-selection'

// Runtime auth profiles, API side: metadata + bindings live here, credentials
// and their state live on the host (daemon RPC `auth.*`). Every mutation is
// an operation row minted before the host is touched, so a lost ack is
// reconciled from the host's journal instead of by a second vendor call.
//
// Hosts: a daemon runtime talks to its own daemon; a sprites runtime talks to
// the sprite-runner daemon registered from that sandbox (the same host code,
// the same capability gate). No runner, or a runner without the capability,
// reads as unavailable — never as "use the native home instead".

const RPC_TIMEOUT_MS = 20_000
const LOGOUT_TIMEOUT_MS = 45_000
// The terminal socket closes before the sign-in shell has exited: the daemon
// only journals the verdict from the PTY's exit handler, so the first read
// after a close usually still says running. Seen on a local daemon
// [2026-09-09]: terminal.closed at .0xx, journal failed at .126 — the verdict
// was 100 ms behind the close and the row stayed running for good.
const SETTLE_POLL_MS = 250
const SETTLE_WAIT_MS = 8_000
const settled = (status: string): boolean =>
    status !== 'pending' && status !== 'running'
const MAX_ERROR_CHARS = 300
const MAX_IDENTITY_CHARS = 200

const VENDOR_FOR: Record<ConfigurableFramework, string> = {
    'claude-code': 'anthropic',
    codex: 'openai',
    'gemini-cli': 'google'
}

interface ResolvedHost {
    host: RuntimeHostRow | null
    availability: RuntimeAuthAvailability
}

const clip = (value: string | null | undefined): string | null =>
    value ? value.slice(0, MAX_IDENTITY_CHARS) : null

const conflict = (
    code: string,
    message: string,
    extra: Record<string, unknown> = {}
): ConflictException => new ConflictException({ code, message, ...extra })

@Injectable()
export class RuntimeAuthProfilesService {
    private readonly log = new Logger(RuntimeAuthProfilesService.name)

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly runtimes: AgentRuntimesService,
        private readonly daemonHosts: DaemonHostService,
        private readonly daemonRegistry: DaemonRegistryService,
        private readonly account: RuntimeAccountService
    ) {}

    // ---- lookups -----------------------------------------------------------

    private async requireRuntime(
        userId: string,
        runtimeId: string
    ): Promise<AgentRuntimeRow> {
        const row = await this.runtimes.findById(runtimeId)
        if (!row || row.userId !== userId)
            throw new NotFoundException(`agent runtime ${runtimeId} not found`)
        return row
    }

    private async requireProfile(
        runtime: AgentRuntimeRow,
        profileId: string
    ): Promise<RuntimeAuthProfileRow> {
        const [row] = await this.db
            .select()
            .from(runtimeAuthProfiles)
            .where(eq(runtimeAuthProfiles.id, profileId))
            .limit(1)
        // One answer for "not yours", "another runtime's" and "gone": no
        // cross-owner existence signal.
        if (
            !row ||
            row.userId !== runtime.userId ||
            row.runtimeId !== runtime.id ||
            row.lifecycle === 'deleted'
        )
            throw new NotFoundException({
                code: RUNTIME_AUTH_ERROR.notFound,
                message: 'auth profile not found'
            })
        return row
    }

    private async resolveHost(runtime: AgentRuntimeRow): Promise<ResolvedHost> {
        if (!runtimeAuthSupported(runtime.framework, runtime.kind))
            return { host: null, availability: 'unsupported' }
        let host: RuntimeHostRow | null = null
        if (runtime.kind === 'daemon') {
            host = runtime.daemonId
                ? await this.daemonHosts.findById(runtime.daemonId)
                : null
            if (!host || host.userId !== runtime.userId)
                return { host: null, availability: 'host-unavailable' }
            if (!this.daemonHosts.isOnline(host))
                return { host, availability: 'daemon-offline' }
        } else {
            if (!runtime.spriteName)
                return { host: null, availability: 'host-unavailable' }
            const [runner] = await this.db
                .select()
                .from(runtimeHosts)
                .where(
                    and(
                        eq(runtimeHosts.userId, runtime.userId),
                        eq(runtimeHosts.kind, 'daemon'),
                        eq(runtimeHosts.managed, true),
                        eq(runtimeHosts.name, runnerHostName(runtime.spriteName))
                    )
                )
                .limit(1)
            host = runner ?? null
            if (!host) return { host: null, availability: 'host-unavailable' }
            // A sleeping sandbox has no runner heartbeat; waking is the
            // user's explicit choice and rides the existing sandbox flows.
            if (!this.daemonHosts.isOnline(host))
                return { host, availability: 'sandbox-asleep' }
        }
        if (!host.clientFeatures.includes(DAEMON_FEATURE_AUTH_PROFILES))
            return { host, availability: 'daemon-upgrade-required' }
        return { host, availability: 'ok' }
    }

    private async requireHost(runtime: AgentRuntimeRow): Promise<RuntimeHostRow> {
        const resolved = await this.resolveHost(runtime)
        if (resolved.availability === 'ok' && resolved.host) return resolved.host
        if (resolved.availability === 'unsupported')
            throw conflict(
                RUNTIME_AUTH_ERROR.contextUnsupported,
                'this runtime cannot hold auth profiles'
            )
        if (resolved.availability === 'daemon-upgrade-required')
            throw conflict(
                RUNTIME_AUTH_ERROR.daemonUpgradeRequired,
                'update the mf CLI on this host to manage auth profiles'
            )
        throw new ServiceUnavailableException({
            code: RUNTIME_AUTH_ERROR.hostUnavailable,
            message:
                resolved.availability === 'sandbox-asleep'
                    ? 'the sandbox is asleep; wake it first'
                    : 'the host is offline'
        })
    }

    private async rpc<T>(
        host: RuntimeHostRow,
        method:
            | 'auth.list'
            | 'auth.create'
            | 'auth.inspect'
            | 'auth.logout'
            | 'auth.operation',
        payload: Record<string, unknown>,
        timeoutMs = RPC_TIMEOUT_MS
    ): Promise<T> {
        try {
            return (await this.daemonRegistry.rpc({
                daemonId: host.id,
                method,
                payload,
                timeoutMs
            })) as T
        } catch (err) {
            const message = ((err as Error).message || String(err)).slice(
                0,
                MAX_ERROR_CHARS
            )
            if (message.includes(RUNTIME_AUTH_ERROR.busy))
                throw conflict(
                    RUNTIME_AUTH_ERROR.busy,
                    'the profile is in use by a sign-in or another operation'
                )
            if (message.includes(RUNTIME_AUTH_ERROR.missing))
                throw conflict(
                    RUNTIME_AUTH_ERROR.missing,
                    'the host no longer holds this profile; sign in again'
                )
            if (message.includes(RUNTIME_AUTH_ERROR.targetMismatch))
                throw conflict(
                    RUNTIME_AUTH_ERROR.targetMismatch,
                    'the profile belongs to another framework'
                )
            this.log.warn(
                `runtime auth rpc failed method=${method} host=${host.id}: ${message}`
            )
            throw new ServiceUnavailableException({
                code: RUNTIME_AUTH_ERROR.hostUnavailable,
                message
            })
        }
    }

    // ---- projection --------------------------------------------------------

    private credentialStatusFrom(
        probe: RuntimeAccountProbe
    ): RuntimeAuthCredentialStatus {
        const evaluated = runtimeLocalCredentialStatus(
            probe.credentialFacts,
            Date.now(),
            { configPresenceIsEvidence: false }
        )
        if (evaluated.status === 'valid') return 'valid'
        if (evaluated.status === 'expired') {
            const facts = probe.credentialFacts as
                | { hasRefreshToken?: boolean }
                | null
            return facts?.hasRefreshToken ? 'refresh-required' : 'reauth-required'
        }
        if (evaluated.status === 'missing')
            return probe.identity && probe.tokenSource === 'keychain-unread'
                ? 'valid'
                : 'missing'
        return probe.identity ? 'valid' : 'unknown'
    }

    // Folds one host report into the row: identity fields, status, generation.
    // Lifecycle only moves pending → ready here (a sign-in that completed
    // outside an operation); every other transition belongs to an operation.
    private async applyReport(
        row: RuntimeAuthProfileRow,
        report: DaemonAuthProfileReport
    ): Promise<RuntimeAuthProfileRow> {
        const patch: Partial<RuntimeAuthProfileRow> = {
            credentialGeneration: Math.max(
                row.credentialGeneration,
                report.generation
            ),
            updatedAt: new Date()
        }
        if (!report.present) {
            patch.credentialStatus = 'missing'
            patch.lastErrorCode = RUNTIME_AUTH_ERROR.missing
        } else if (report.error) {
            patch.lastErrorCode = 'probe_failed'
        } else if (report.probe) {
            const probe = parseRuntimeAccountProbe(report.probe)
            if (probe) {
                const status = this.credentialStatusFrom(probe)
                patch.credentialStatus = status
                patch.checkedAt = new Date(probe.checkedAt)
                patch.lastErrorCode = null
                patch.vendor = VENDOR_FOR[probe.framework]
                if (probe.identity) {
                    patch.email = clip(probe.identity.email)
                    patch.displayName = clip(probe.identity.name)
                    patch.organization = clip(probe.identity.organization)
                    patch.plan = clip(probe.identity.plan)
                    patch.vendorAccountId = clip(probe.identity.accountId)
                }
                if (
                    row.lifecycle === 'pending' &&
                    (status === 'valid' || probe.identity)
                )
                    patch.lifecycle = 'ready'
            }
        }
        const [updated] = await this.db
            .update(runtimeAuthProfiles)
            .set(patch)
            .where(eq(runtimeAuthProfiles.id, row.id))
            .returning()
        return updated ?? { ...row, ...patch }
    }

    private async agentsByProfile(
        runtimeId: string
    ): Promise<Map<string, { id: string; name: string }[]>> {
        const rows = await this.db
            .select({
                id: agents.id,
                name: agents.name,
                profileId: agents.runtimeAuthProfileId
            })
            .from(agents)
            .where(eq(agents.runtimeId, runtimeId))
        const byProfile = new Map<string, { id: string; name: string }[]>()
        for (const agent of rows) {
            if (!agent.profileId) continue
            const list = byProfile.get(agent.profileId) ?? []
            list.push({ id: agent.id, name: agent.name })
            byProfile.set(agent.profileId, list)
        }
        return byProfile
    }

    private toView(
        row: RuntimeAuthProfileRow,
        agentCount: number,
        defaultProfileId: string | null
    ): RuntimeAuthProfileView {
        return {
            id: row.id,
            runtimeId: row.runtimeId,
            framework: row.framework,
            label: row.label,
            authMethod: row.authMethod,
            lifecycle: row.lifecycle,
            credentialStatus: row.credentialStatus,
            credentialGeneration: row.credentialGeneration,
            identity:
                row.email || row.displayName || row.organization || row.plan
                    ? {
                          email: row.email,
                          name: row.displayName,
                          organization: row.organization,
                          plan: row.plan,
                          accountId: row.vendorAccountId
                      }
                    : null,
            vendorUserId: row.vendorUserId,
            vendorAccountId: row.vendorAccountId,
            checkedAt: row.checkedAt?.toISOString() ?? null,
            lastErrorCode: row.lastErrorCode,
            agentCount,
            isDefault: defaultProfileId === row.id,
            createdAt: row.createdAt.toISOString(),
            updatedAt: row.updatedAt.toISOString()
        }
    }

    private operationView(row: RuntimeAuthOperationRow): RuntimeAuthOperationView {
        return {
            id: row.id,
            runtimeId: row.runtimeId,
            profileId: row.profileId,
            kind: row.kind,
            status: row.status,
            resultCode: row.resultCode,
            error: row.error,
            revoke: row.revoke,
            deadlineAt: row.deadlineAt?.toISOString() ?? null,
            createdAt: row.createdAt.toISOString(),
            updatedAt: row.updatedAt.toISOString()
        }
    }

    // ---- reads -------------------------------------------------------------

    async list(userId: string, runtimeId: string): Promise<RuntimeAuthListView> {
        const runtime = await this.requireRuntime(userId, runtimeId)
        const resolved = await this.resolveHost(runtime)
        let rows = await this.db
            .select()
            .from(runtimeAuthProfiles)
            .where(
                and(
                    eq(runtimeAuthProfiles.runtimeId, runtime.id),
                    ne(runtimeAuthProfiles.lifecycle, 'deleted')
                )
            )
        let ambient: RuntimeAuthListView['ambient'] = null
        let error: string | null = null
        if (resolved.availability === 'ok' && resolved.host) {
            try {
                const listed = await this.rpc<DaemonAuthListResponse>(
                    resolved.host,
                    'auth.list',
                    { framework: runtime.framework, runtimeId: runtime.id, probe: true }
                )
                const reports = new Map(
                    listed.profiles.map((report) => [report.profileId, report])
                )
                rows = await Promise.all(
                    rows.map((row) =>
                        this.applyReport(
                            row,
                            reports.get(row.id) ?? {
                                profileId: row.id,
                                present: false,
                                authMethod: null,
                                generation: row.credentialGeneration,
                                createdAt: null,
                                lastLoginAt: null,
                                probe: null,
                                error: null
                            }
                        )
                    )
                )
                ambient = listed.ambient
                    ? this.account.fromProbe(runtime, listed.ambient, null)
                    : null
            } catch (err) {
                error = ((err as Error).message || String(err)).slice(
                    0,
                    MAX_ERROR_CHARS
                )
            }
        }
        const byProfile = await this.agentsByProfile(runtime.id)
        const executeCapable =
            resolved.availability === 'ok' &&
            (resolved.host?.clientFeatures ?? []).includes(
                DAEMON_FEATURE_AUTH_CONTEXT
            )
        return {
            runtimeId: runtime.id,
            framework: runtime.framework,
            kind: runtime.kind,
            availability: resolved.availability,
            capabilities: {
                manage: resolved.availability === 'ok',
                execute: executeCapable
            },
            defaultProfileId: runtime.defaultAuthProfileId,
            ambient,
            profiles: rows
                .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
                .map((row) =>
                    this.toView(
                        row,
                        byProfile.get(row.id)?.length ?? 0,
                        runtime.defaultAuthProfileId
                    )
                ),
            error
        }
    }

    async inspect(
        userId: string,
        runtimeId: string,
        profileId: string
    ): Promise<RuntimeAuthProfileView> {
        const runtime = await this.requireRuntime(userId, runtimeId)
        const row = await this.requireProfile(runtime, profileId)
        const host = await this.requireHost(runtime)
        const report = await this.rpc<DaemonAuthProfileReport>(
            host,
            'auth.inspect',
            { framework: runtime.framework, runtimeId: runtime.id, profileId }
        )
        const updated = await this.applyReport(row, report)
        const byProfile = await this.agentsByProfile(runtime.id)
        return this.toView(
            updated,
            byProfile.get(row.id)?.length ?? 0,
            runtime.defaultAuthProfileId
        )
    }

    async operation(
        userId: string,
        operationId: string
    ): Promise<RuntimeAuthOperationView> {
        const [row] = await this.db
            .select()
            .from(runtimeAuthOperations)
            .where(eq(runtimeAuthOperations.id, operationId))
            .limit(1)
        if (!row || row.userId !== userId)
            throw new NotFoundException({
                code: RUNTIME_AUTH_ERROR.notFound,
                message: 'operation not found'
            })
        // A login still open in the database may already be decided on the
        // host (the close-time reconcile read the journal too early). One
        // read, no wait: the poller behind this call supplies the cadence.
        if (row.kind === 'login' && !settled(row.status)) {
            const healed = await this.syncLoginFromHost(userId, row, 0).catch(
                (err) => {
                    this.log.warn(
                        `login operation sync skipped operation=${row.id}: ${(err as Error).message}`
                    )
                    return null
                }
            )
            if (healed) return this.operationView(healed)
        }
        return this.operationView(row)
    }

    // ---- mutations (human principals only) ---------------------------------

    private assertHuman(principal: AuthPrincipal): void {
        // A runtime identity manages nothing about the host's accounts: the
        // account scope would let an agent enumerate and rebind its owner's
        // vendor sign-ins.
        if (principal.kind === 'agent-runtime')
            throw new ForbiddenException({
                code: 'auth_profile_forbidden',
                message: 'auth profiles are managed by a person, not an agent'
            })
    }

    async create(
        principal: AuthPrincipal,
        runtimeId: string,
        body: { label?: string; authMethod: 'subscription' | 'api-key' }
    ): Promise<RuntimeAuthProfileView> {
        this.assertHuman(principal)
        const runtime = await this.requireRuntime(principal.userId, runtimeId)
        if (body.authMethod !== 'subscription')
            // Host-local API-key profiles need the masked key prompt on the
            // host; until that ships, platform API keys remain the existing
            // model-provider flow.
            throw conflict(
                RUNTIME_AUTH_ERROR.contextUnsupported,
                'only subscription profiles can be created yet'
            )
        const host = await this.requireHost(runtime)
        const framework = runtime.framework as ConfigurableFramework
        const existingCount = (
            await this.db
                .select({ id: runtimeAuthProfiles.id })
                .from(runtimeAuthProfiles)
                .where(
                    and(
                        eq(runtimeAuthProfiles.runtimeId, runtime.id),
                        ne(runtimeAuthProfiles.lifecycle, 'deleted')
                    )
                )
        ).length
        const id = createObjectId('runtimeAuthProfile')
        const label = body.label?.trim() || `Account ${existingCount + 1}`
        const [row] = await this.db
            .insert(runtimeAuthProfiles)
            .values({
                id,
                userId: runtime.userId,
                runtimeId: runtime.id,
                framework,
                label,
                authMethod: body.authMethod,
                vendor: VENDOR_FOR[framework]
            })
            .returning()
        try {
            await this.rpc<DaemonAuthCreateResponse>(host, 'auth.create', {
                framework,
                runtimeId: runtime.id,
                profileId: id,
                authMethod: body.authMethod
            })
        } catch (err) {
            await this.db
                .update(runtimeAuthProfiles)
                .set({
                    lifecycle: 'error',
                    lastErrorCode: RUNTIME_AUTH_ERROR.hostUnavailable,
                    updatedAt: new Date()
                })
                .where(eq(runtimeAuthProfiles.id, id))
            throw err
        }
        return this.toView(row, 0, runtime.defaultAuthProfileId)
    }

    private async mintOperation(input: {
        runtime: AgentRuntimeRow
        profileId: string
        kind: 'login' | 'logout' | 'remove'
        requestId?: string
    }): Promise<RuntimeAuthOperationRow> {
        if (input.requestId) {
            const [existing] = await this.db
                .select()
                .from(runtimeAuthOperations)
                .where(
                    and(
                        eq(runtimeAuthOperations.profileId, input.profileId),
                        eq(runtimeAuthOperations.kind, input.kind),
                        eq(runtimeAuthOperations.requestId, input.requestId)
                    )
                )
                .limit(1)
            if (existing) return existing
        }
        const [row] = await this.db
            .insert(runtimeAuthOperations)
            .values({
                id: createObjectId('runtimeAuthOperation'),
                userId: input.runtime.userId,
                runtimeId: input.runtime.id,
                profileId: input.profileId,
                kind: input.kind,
                requestId: input.requestId ?? null,
                deadlineAt:
                    input.kind === 'login'
                        ? new Date(Date.now() + 15 * 60_000)
                        : null
            })
            .returning()
        return row
    }

    private async finishOperation(
        id: string,
        patch: Partial<RuntimeAuthOperationRow>
    ): Promise<RuntimeAuthOperationRow> {
        const [row] = await this.db
            .update(runtimeAuthOperations)
            .set({ ...patch, updatedAt: new Date() })
            .where(eq(runtimeAuthOperations.id, id))
            .returning()
        return row
    }

    // A login is a PTY session: this mints the operation the terminal
    // gateway attaches to (`?operationId=`), and `reconcileLogin` folds the
    // host's verdict back once that shell closes.
    async startLogin(
        principal: AuthPrincipal,
        runtimeId: string,
        profileId: string,
        body: { requestId?: string }
    ): Promise<RuntimeAuthOperationView> {
        this.assertHuman(principal)
        const runtime = await this.requireRuntime(principal.userId, runtimeId)
        const row = await this.requireProfile(runtime, profileId)
        if (row.lifecycle === 'deleting')
            throw conflict(RUNTIME_AUTH_ERROR.stateConflict, 'profile is being removed')
        await this.requireHost(runtime)
        const operation = await this.mintOperation({
            runtime,
            profileId: row.id,
            kind: 'login',
            requestId: body.requestId
        })
        return this.operationView(operation)
    }

    // The terminal gateway's view of a login: who owns it, which host to open
    // the PTY on, and the opaque ref the daemon composes the sign-in from.
    async loginTarget(
        userId: string,
        operationId: string
    ): Promise<{
        host: RuntimeHostRow
        runtime: AgentRuntimeRow
        authLogin: DaemonPtyAuthLogin
    }> {
        const [operation] = await this.db
            .select()
            .from(runtimeAuthOperations)
            .where(eq(runtimeAuthOperations.id, operationId))
            .limit(1)
        if (!operation || operation.userId !== userId || operation.kind !== 'login')
            throw new NotFoundException({
                code: RUNTIME_AUTH_ERROR.notFound,
                message: 'login operation not found'
            })
        if (operation.status !== 'pending' && operation.status !== 'running')
            throw conflict(
                RUNTIME_AUTH_ERROR.stateConflict,
                `login operation is ${operation.status}`
            )
        const runtime = await this.requireRuntime(userId, operation.runtimeId)
        const row = await this.requireProfile(runtime, operation.profileId)
        const host = await this.requireHost(runtime)
        await this.finishOperation(operation.id, { status: 'running' })
        return {
            host,
            runtime,
            authLogin: {
                framework: runtime.framework as ConfigurableFramework,
                runtimeId: runtime.id,
                profileId: row.id,
                operationId: operation.id
            }
        }
    }

    async reconcileLogin(userId: string, operationId: string): Promise<void> {
        const [operation] = await this.db
            .select()
            .from(runtimeAuthOperations)
            .where(eq(runtimeAuthOperations.id, operationId))
            .limit(1)
        if (!operation || operation.userId !== userId) return
        try {
            await this.syncLoginFromHost(userId, operation, SETTLE_WAIT_MS)
        } catch (err) {
            this.log.warn(
                `login reconcile failed operation=${operationId}: ${(err as Error).message}`
            )
            await this.finishOperation(operation.id, {
                status: 'failed',
                resultCode: RUNTIME_AUTH_ERROR.operationTimeout,
                error: ((err as Error).message || String(err)).slice(0, MAX_ERROR_CHARS)
            })
        }
    }

    // Reads the host's journal for a login until it carries a verdict (or
    // waitMs runs out) and folds that verdict into the row. Returns the
    // updated row, or null when the host still says running.
    private async syncLoginFromHost(
        userId: string,
        operation: RuntimeAuthOperationRow,
        waitMs: number
    ): Promise<RuntimeAuthOperationRow | null> {
        const runtime = await this.requireRuntime(userId, operation.runtimeId)
        const row = await this.requireProfile(runtime, operation.profileId)
        const host = await this.requireHost(runtime)
        const deadline = Date.now() + waitMs
        let record = await this.rpc<DaemonAuthOperationRecord>(
            host,
            'auth.operation',
            { runtimeId: runtime.id, operationId: operation.id }
        )
        while (!settled(record.status) && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS))
            record = await this.rpc<DaemonAuthOperationRecord>(
                host,
                'auth.operation',
                { runtimeId: runtime.id, operationId: operation.id }
            )
        }
        if (!settled(record.status)) return null
        const updated = await this.finishOperation(operation.id, {
            status: record.status,
            resultCode: record.resultCode,
            error: record.error
        })
        if (record.status === 'succeeded') {
            await this.db
                .update(runtimeAuthProfiles)
                .set({
                    lifecycle: 'ready',
                    lastErrorCode: null,
                    updatedAt: new Date()
                })
                .where(eq(runtimeAuthProfiles.id, row.id))
            await this.inspect(userId, runtime.id, row.id).catch((err) =>
                this.log.warn(
                    `post-login inspect failed profile=${row.id}: ${(err as Error).message}`
                )
            )
        }
        return updated
    }

    async logout(
        principal: AuthPrincipal,
        runtimeId: string,
        profileId: string,
        body: { requestId?: string }
    ): Promise<RuntimeAuthOperationView> {
        return this.signOutOrRemove(principal, runtimeId, profileId, body, 'sign-out')
    }

    async remove(
        principal: AuthPrincipal,
        runtimeId: string,
        profileId: string,
        body: { requestId?: string }
    ): Promise<RuntimeAuthOperationView> {
        return this.signOutOrRemove(principal, runtimeId, profileId, body, 'remove')
    }

    private async signOutOrRemove(
        principal: AuthPrincipal,
        runtimeId: string,
        profileId: string,
        body: { requestId?: string },
        mode: 'sign-out' | 'remove'
    ): Promise<RuntimeAuthOperationView> {
        this.assertHuman(principal)
        const runtime = await this.requireRuntime(principal.userId, runtimeId)
        const row = await this.requireProfile(runtime, profileId)
        if (mode === 'remove') {
            const bound = (await this.agentsByProfile(runtime.id)).get(row.id) ?? []
            if (bound.length)
                throw conflict(
                    RUNTIME_AUTH_ERROR.inUse,
                    'agents still use this profile; switch them first',
                    { agents: bound }
                )
            if (runtime.defaultAuthProfileId === row.id)
                throw conflict(
                    RUNTIME_AUTH_ERROR.inUse,
                    'this profile is the runtime default; change the default first'
                )
        }
        const host = await this.requireHost(runtime)
        const operation = await this.mintOperation({
            runtime,
            profileId: row.id,
            kind: mode === 'remove' ? 'remove' : 'logout',
            requestId: body.requestId
        })
        if (operation.status !== 'pending') return this.operationView(operation)
        await this.finishOperation(operation.id, { status: 'running' })
        if (mode === 'remove')
            await this.db
                .update(runtimeAuthProfiles)
                .set({ lifecycle: 'deleting', updatedAt: new Date() })
                .where(eq(runtimeAuthProfiles.id, row.id))
        let result: DaemonAuthLogoutResponse
        try {
            result = await this.rpc<DaemonAuthLogoutResponse>(
                host,
                'auth.logout',
                {
                    framework: runtime.framework,
                    runtimeId: runtime.id,
                    profileId: row.id,
                    operationId: operation.id,
                    mode
                },
                LOGOUT_TIMEOUT_MS
            )
        } catch (err) {
            const message = ((err as Error).message || String(err)).slice(
                0,
                MAX_ERROR_CHARS
            )
            // Keep the row retryable: a deleting profile stays deleting, an
            // ack lost mid-flight is resolved by the next attempt reading the
            // host journal under the same operation id.
            await this.finishOperation(operation.id, {
                status: 'failed',
                resultCode: RUNTIME_AUTH_ERROR.hostUnavailable,
                error: message
            })
            throw err
        }
        const now = new Date()
        await this.finishOperation(operation.id, {
            status: result.signedOut ? 'succeeded' : 'failed',
            resultCode: result.signedOut ? null : 'logout_failed',
            error: result.logoutError,
            revoke: result.revoke
        })
        await this.db
            .update(runtimeAuthProfiles)
            .set(
                mode === 'remove' && result.removed
                    ? {
                          lifecycle: 'deleted',
                          credentialStatus: 'missing',
                          credentialGeneration: result.generation,
                          deletedAt: now,
                          updatedAt: now
                      }
                    : {
                          lifecycle: result.signedOut ? 'signed-out' : row.lifecycle,
                          credentialStatus: result.signedOut
                              ? 'missing'
                              : row.credentialStatus,
                          credentialGeneration: result.generation,
                          lastErrorCode: result.signedOut ? null : 'logout_failed',
                          updatedAt: now
                      }
            )
            .where(eq(runtimeAuthProfiles.id, row.id))
        const [updated] = await this.db
            .select()
            .from(runtimeAuthOperations)
            .where(eq(runtimeAuthOperations.id, operation.id))
            .limit(1)
        return this.operationView(updated ?? operation)
    }

    // The credential-context env for a profile-bound SPRITES agent's terminal.
    // A sandbox terminal is a sprites.dev pty, not a daemon call, so the API
    // composes the (non-secret) relocation vars from the runner's store
    // layout: <home>/.manyfold/runtime-auth/<runnerDaemonId>/<runtimeId>/…
    // Daemon runtimes never use this — the daemon resolves its own paths.
    async sessionEnvForAgent(agent: Agent): Promise<Record<string, string> | null> {
        const ref = authContextRefFor(agent)
        if (!ref || agent.runtime !== 'sprites') return null
        const runtime = await this.runtimes.findById(ref.runtimeId)
        if (!runtime || runtime.userId !== agent.userId) return null
        const resolved = await this.resolveHost(runtime)
        if (
            resolved.availability !== 'ok' ||
            !resolved.host ||
            !resolved.host.clientFeatures.includes(DAEMON_FEATURE_AUTH_CONTEXT)
        )
            return null
        const [profile] = await this.db
            .select({ id: runtimeAuthProfiles.id, lifecycle: runtimeAuthProfiles.lifecycle })
            .from(runtimeAuthProfiles)
            .where(eq(runtimeAuthProfiles.id, ref.profileId))
            .limit(1)
        if (!profile || profile.lifecycle === 'deleted') return null
        const home = runtime.homeDir ?? '/home/sprite'
        const viewDir = `${runtimeAuthRoot(`${home}/.manyfold`)}/${resolved.host.id}/${runtime.id}/profiles/${ref.profileId}/view`
        return {
            ...runtimeAuthProfileEnv(ref.framework, viewDir),
            ...(ref.framework === 'codex'
                ? { CODEX_SQLITE_HOME: `${home}/.codex` }
                : {})
        }
    }

    async setDefault(
        principal: AuthPrincipal,
        runtimeId: string,
        profileId: string | null
    ): Promise<RuntimeAuthListView> {
        this.assertHuman(principal)
        const runtime = await this.requireRuntime(principal.userId, runtimeId)
        if (profileId) {
            const row = await this.requireProfile(runtime, profileId)
            if (row.lifecycle === 'deleting')
                throw conflict(RUNTIME_AUTH_ERROR.stateConflict, 'profile is being removed')
        }
        await this.db
            .update(agentRuntimes)
            .set({ defaultAuthProfileId: profileId, updatedAt: new Date() })
            .where(eq(agentRuntimes.id, runtime.id))
        return this.list(principal.userId, runtime.id)
    }
}
