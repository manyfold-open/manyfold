import {
    DAEMON_FEATURE_DAEMON_UPDATE,
    DAEMON_FEATURE_DAEMON_UPDATE_CHANNEL,
    DAEMON_ONLINE_THRESHOLD_MS,
    DaemonHostSummary,
    DaemonStartupMethod,
    DetectedFramework,
    MfCliChannel,
    RegisterDaemonRequest,
    UpgradeDaemonHostResponse,
    auditAction,
    cliChannelOfVersion,
    createObjectId,
    isCliUpdateAvailable,
    isCliVersionTooOld
} from '@manyfold/shared'
import {
    BadRequestException,
    ConflictException,
    ForbiddenException,
    Inject,
    Injectable,
    Logger,
    NotFoundException,
    ServiceUnavailableException,
    UnauthorizedException
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { randomUUID } from 'node:crypto'
import { and, eq, inArray, sql } from 'drizzle-orm'
import {
    agents,
    agentRuntimes,
    auditLogs,
    daemonTokens,
    runtimeHosts,
    type Database,
    type RuntimeHostRow
} from '@manyfold/db'
import {
    cliDevAllowedForDeployEnv,
    resolveMfDeployEnv
} from '@/common/deploy-env'
import { DRIZZLE } from '@/db/tokens'
import { AdminSettingsService } from '@/modules/admin-settings/admin-settings.service'
import { RuntimeAccessService } from '@/modules/runtime-access/runtime-access.service'
import { DaemonRegistryService } from './daemon-registry.service'
import { DaemonRateLimitService } from './daemon-rate-limit.service'
import { DaemonCliVersionService } from './daemon-cli-version.service'
import { CliVersionCatalogService } from './cli-version-catalog.service'

const UPGRADE_RATE_LIMIT = 5
const UPGRADE_RATE_WINDOW_MS = 60_000
const UPGRADE_RPC_TIMEOUT_MS = 180_000

const isInitUnitStartup = (
    method: DaemonStartupMethod | null
): method is Exclude<DaemonStartupMethod, 'manual'> =>
    method !== null && method !== 'manual'

const ONLINE_THRESHOLD_MS = DAEMON_ONLINE_THRESHOLD_MS

const sameJson = (a: unknown, b: unknown): boolean =>
    JSON.stringify(a) === JSON.stringify(b)

@Injectable()
export class DaemonHostService {
    private readonly log = new Logger(DaemonHostService.name)

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly runtimeAccess: RuntimeAccessService,
        private readonly adminSettings: AdminSettingsService,
        private readonly registry: DaemonRegistryService,
        private readonly rateLimit: DaemonRateLimitService,
        private readonly cliVersion: DaemonCliVersionService,
        private readonly cliCatalog: CliVersionCatalogService,
        private readonly config: ConfigService
    ) {}

    // Cross-channel daemon upgrades (e.g. installing a dev build on a
    // stable daemon) are only offered in local/staging and only to daemons new
    // enough to honour the channel override in the daemon.update RPC.
    private crossChannelAllowed(host: RuntimeHostRow): boolean {
        return (
            cliDevAllowedForDeployEnv(
                resolveMfDeployEnv(this.config.get<string>('MF_DEPLOY_ENV'))
            ) &&
            host.clientFeatures.includes(DAEMON_FEATURE_DAEMON_UPDATE_CHANNEL)
        )
    }

    async upsertOnRegister(args: {
        tokenId: string
        request: RegisterDaemonRequest
        lastIp: string | null
    }): Promise<RuntimeHostRow> {
        const { tokenId, request, lastIp } = args
        return this.db.transaction(async (tx) => {
            const [token] = await tx
                .select()
                .from(daemonTokens)
                .where(eq(daemonTokens.id, tokenId))
                .for('update')
                .limit(1)
            if (!token) throw new UnauthorizedException('token not found')
            if (token.revokedAt)
                throw new UnauthorizedException('token revoked')
            if (token.expiresAt && token.expiresAt < new Date())
                throw new UnauthorizedException('token expired')

            const userId = token.userId
            const managed = token.purpose === 'sprite_runner'
            await this.runtimeAccess.lockDaemonHostRegistrationInTx(tx, userId)

            const [existing] = await tx
                .select()
                .from(runtimeHosts)
                .where(
                    and(
                        eq(runtimeHosts.userId, userId),
                        eq(runtimeHosts.daemonUuid, request.daemonUuid)
                    )
                )
                .for('update')
                .limit(1)
            if (token.daemonId && token.daemonId !== existing?.id)
                throw new ForbiddenException(
                    'token already bound to a different daemon'
                )
            if (existing?.managed && !managed)
                throw new ForbiddenException(
                    'ordinary token cannot register a managed daemon'
                )

            const now = new Date()
            const reported = {
                name: request.name,
                hostname: request.hostname,
                os: request.os,
                arch: request.arch,
                cliVersion: request.cliVersion,
                homeDir: request.homeDir,
                workspaceBaseDir: request.workspaceBaseDir,
                skillsDir: request.skillsDir ?? null,
                detectedFrameworks: request.detectedFrameworks,
                terminalPty: request.terminalPty ?? null,
                lastSeenAt: now,
                lastIp,
                status: 'active' as const
            }
            let host: RuntimeHostRow
            if (existing) {
                if (existing.status === 'revoked') {
                    this.log.warn(
                        `reactivating revoked daemon host ${existing.id} on register`
                    )
                    if (!managed)
                        await this.runtimeAccess.assertDaemonHostSlotAvailableInTx(
                            tx,
                            userId
                        )
                }
                const [updated] = await tx
                    .update(runtimeHosts)
                    .set({
                        ...reported,
                        managed: sql`${runtimeHosts.managed} or ${managed}`,
                        updatedAt: now
                    })
                    .where(eq(runtimeHosts.id, existing.id))
                    .returning()
                host = updated
            } else {
                if (!managed)
                    await this.runtimeAccess.assertDaemonHostSlotAvailableInTx(
                        tx,
                        userId
                    )
                const [inserted] = await tx
                    .insert(runtimeHosts)
                    .values({
                        id: createObjectId('daemonHost'),
                        userId,
                        daemonUuid: request.daemonUuid,
                        ...reported,
                        managed
                    })
                    .returning()
                host = inserted
            }

            await tx
                .update(daemonTokens)
                .set({ daemonId: host.id })
                .where(eq(daemonTokens.id, token.id))
            return host
        })
    }

    // Fires every 15s per online daemon, so the steady-state SET is trimmed to
    // the presence column alone: the reported metadata (including the
    // detectedFrameworks JSONB) is only re-written when it actually differs.
    // lastSeenAt always advances — the 45s presence sweep reads it, and a
    // skipped touch would mark a live daemon offline. Returns the post-write
    // row so the caller does not re-read what it just wrote (#629).
    async heartbeat(args: {
        daemonId: string
        detectedFrameworks: DetectedFramework[]
        cliVersion: string
        startupMethod: DaemonStartupMethod
        terminalPty?: boolean
        clientFeatures?: string[]
    }): Promise<RuntimeHostRow | null> {
        const host = await this.findById(args.daemonId)
        if (!host) throw new NotFoundException('daemon host not found')
        if (host.status === 'revoked')
            throw new ForbiddenException('daemon host has been revoked')
        const now = new Date()
        const terminalPty = args.terminalPty ?? null
        const changed: Partial<RuntimeHostRow> = {}
        if (!sameJson(host.detectedFrameworks, args.detectedFrameworks))
            changed.detectedFrameworks = args.detectedFrameworks
        if (host.cliVersion !== args.cliVersion)
            changed.cliVersion = args.cliVersion
        if (host.startupMethod !== args.startupMethod)
            changed.startupMethod = args.startupMethod
        if (host.terminalPty !== terminalPty) changed.terminalPty = terminalPty
        if (
            args.clientFeatures &&
            !sameJson(host.clientFeatures, args.clientFeatures)
        )
            changed.clientFeatures = args.clientFeatures
        if (host.status !== 'active') changed.status = 'active'
        const patch: Partial<RuntimeHostRow> = {
            ...changed,
            ...(Object.keys(changed).length > 0 ? { updatedAt: now } : {}),
            lastSeenAt: now
        }
        const [updated] = await this.db
            .update(runtimeHosts)
            .set(patch)
            .where(eq(runtimeHosts.id, args.daemonId))
            .returning()
        return updated ?? null
    }

    async touchLastSeen(daemonId: string): Promise<void> {
        const host = await this.findById(daemonId)
        if (!host || host.status === 'revoked') return
        await this.db
            .update(runtimeHosts)
            .set({ lastSeenAt: new Date(), status: 'active' })
            .where(eq(runtimeHosts.id, daemonId))
    }

    async findById(id: string): Promise<RuntimeHostRow | null> {
        const [row] = await this.db
            .select()
            .from(runtimeHosts)
            .where(eq(runtimeHosts.id, id))
            .limit(1)
        return row ?? null
    }

    // User-facing: "the machines you registered". Platform-managed hosts (a
    // Phase 3 sprite runner is one) are excluded — the user did not create it,
    // cannot act on it, and it would sit in this list looking like a machine
    // they could target.
    async listForUser(userId: string): Promise<RuntimeHostRow[]> {
        return this.db
            .select()
            .from(runtimeHosts)
            .where(
                and(
                    eq(runtimeHosts.userId, userId),
                    eq(runtimeHosts.kind, 'daemon'),
                    eq(runtimeHosts.managed, false)
                )
            )
    }

    async revoke(args: { id: string; userId: string }): Promise<void> {
        const now = new Date()
        await this.db
            .update(runtimeHosts)
            .set({ status: 'revoked', updatedAt: now })
            .where(
                and(
                    eq(runtimeHosts.id, args.id),
                    eq(runtimeHosts.userId, args.userId)
                )
            )
        await this.db
            .update(agentRuntimes)
            .set({ status: 'stopped', updatedAt: now })
            .where(eq(agentRuntimes.daemonId, args.id))
        await this.db
            .update(agents)
            .set({
                status: 'stopped',
                failureReason: 'daemon revoked',
                updatedAt: now
            })
            .where(eq(agents.daemonId, args.id))
    }

    async deleteRevoked(args: {
        id: string
        actorId: string
        userId?: string
    }): Promise<void> {
        const host = await this.findById(args.id)
        if (
            !host ||
            host.kind !== 'daemon' ||
            (args.userId !== undefined && host.userId !== args.userId)
        ) {
            throw new NotFoundException('daemon host not found')
        }
        if (host.status !== 'revoked')
            throw new ConflictException(
                'daemon host must be revoked before deletion'
            )
        const deletedRuntimeCount = await this.db.transaction(async (tx) => {
            const deletedRuntimes = await tx
                .delete(agentRuntimes)
                .where(eq(agentRuntimes.daemonId, args.id))
                .returning({ id: agentRuntimes.id })
            const [deleted] = await tx
                .delete(runtimeHosts)
                .where(
                    and(
                        eq(runtimeHosts.id, args.id),
                        eq(runtimeHosts.kind, 'daemon'),
                        eq(runtimeHosts.status, 'revoked'),
                        args.userId === undefined
                            ? undefined
                            : eq(runtimeHosts.userId, args.userId)
                    )
                )
                .returning({ id: runtimeHosts.id })
            if (!deleted)
                throw new ConflictException(
                    'daemon host must be revoked before deletion'
                )
            return deletedRuntimes.length
        })
        await this.audit(args.actorId, auditAction.DAEMON_DELETED, args.id, {
            runtimeCount: deletedRuntimeCount
        })
    }

    async rename(args: {
        id: string
        userId: string
        name: string
    }): Promise<RuntimeHostRow> {
        const [updated] = await this.db
            .update(runtimeHosts)
            .set({ name: args.name, updatedAt: new Date() })
            .where(
                and(
                    eq(runtimeHosts.id, args.id),
                    eq(runtimeHosts.userId, args.userId),
                    eq(runtimeHosts.kind, 'daemon')
                )
            )
            .returning()
        if (!updated) throw new NotFoundException('daemon host not found')
        return updated
    }

    isOnline(host: RuntimeHostRow): boolean {
        if (host.status !== 'active') return false
        if (!host.rpcLastSeenAt) return false
        return Date.now() - host.rpcLastSeenAt.getTime() < ONLINE_THRESHOLD_MS
    }

    async resolveNeedsUpgradeMap(
        daemonIds: Array<string | null | undefined>
    ): Promise<Map<string, boolean>> {
        const result = new Map<string, boolean>()
        const uniqueIds = Array.from(
            new Set(
                daemonIds.filter(
                    (id): id is string => typeof id === 'string' && id.length > 0
                )
            )
        )
        if (uniqueIds.length === 0) return result
        const { minVersion } =
            await this.adminSettings.getCachedCliMinimumVersion()
        if (!minVersion) {
            for (const id of uniqueIds) result.set(id, false)
            return result
        }
        const rows = await this.db
            .select({ id: runtimeHosts.id, cliVersion: runtimeHosts.cliVersion })
            .from(runtimeHosts)
            .where(inArray(runtimeHosts.id, uniqueIds))
        const cliVersionById = new Map<string, string | null>()
        for (const row of rows) cliVersionById.set(row.id, row.cliVersion)
        for (const id of uniqueIds) {
            const cliVersion = cliVersionById.get(id) ?? null
            result.set(id, isCliVersionTooOld(cliVersion, minVersion))
        }
        return result
    }

    async toSummary(
        host: RuntimeHostRow,
        runtimes: Array<{
            runtimeId: string
            framework: DetectedFramework['framework']
            name: string
        }>,
        agentCount: number
    ): Promise<DaemonHostSummary> {
        const { minVersion } =
            await this.adminSettings.getCachedCliMinimumVersion()
        const { version: latestCliVersion, channel } =
            await this.cliVersion.getCachedLatest()
        return {
            id: host.id,
            name: host.name,
            // daemon-only summary (callers filter kind='daemon'), so daemonUuid
            // is always set; coerce for the now-nullable column type.
            daemonUuid: host.daemonUuid ?? '',
            hostname: host.hostname,
            os: host.os,
            arch: host.arch,
            cliVersion: host.cliVersion,
            needsUpgrade: isCliVersionTooOld(host.cliVersion, minVersion),
            latestCliVersion,
            updateAvailable: isCliUpdateAvailable(
                channel,
                host.cliVersion,
                latestCliVersion
            ),
            canRemoteUpgrade:
                this.isOnline(host) &&
                isInitUnitStartup(host.startupMethod) &&
                host.clientFeatures.includes(DAEMON_FEATURE_DAEMON_UPDATE),
            canCrossChannelUpgrade: this.crossChannelAllowed(host),
            startupMethod: host.startupMethod,
            homeDir: host.homeDir,
            workspaceBaseDir: host.workspaceBaseDir,
            detectedFrameworks: host.detectedFrameworks,
            status: host.status,
            online: this.isOnline(host),
            lastSeenAt: host.lastSeenAt?.toISOString() ?? null,
            createdAt: host.createdAt.toISOString(),
            agentCount,
            runtimes
        }
    }

    private async resolveDaemonTarget(
        host: RuntimeHostRow,
        requested: string | undefined
    ): Promise<{ version: string | null; channel?: MfCliChannel }> {
        if (!requested)
            return { version: (await this.cliVersion.getCachedLatest()).version }
        if (!(await this.cliCatalog.isInstallableVersion(requested)))
            throw new BadRequestException(
                `unknown mf CLI version ${requested}`
            )
        const requestedChannel = cliChannelOfVersion(requested)
        const daemonChannel = cliChannelOfVersion(host.cliVersion)
        if (requestedChannel === daemonChannel) return { version: requested }
        // Different channel than the daemon was installed from: only allowed in
        // local/staging on a capable daemon, and we must tell it which CDN to
        // pull from via the channel override.
        if (!this.crossChannelAllowed(host))
            throw new BadRequestException(
                `${requested} is on the ${requestedChannel} channel but this daemon is on ${daemonChannel}; cross-channel upgrades are only available in local/staging on a daemon new enough to support them`
            )
        return { version: requested, channel: requestedChannel }
    }

    async upgrade(args: {
        host: RuntimeHostRow
        actorId: string
        targetVersion?: string
    }): Promise<UpgradeDaemonHostResponse> {
        const { host, actorId } = args
        if (host.status === 'revoked')
            throw new BadRequestException('daemon host has been revoked')
        if (!this.isOnline(host))
            throw new BadRequestException('daemon is offline')
        if (!isInitUnitStartup(host.startupMethod))
            throw new BadRequestException(
                'this daemon is not managed by an init unit (launchd/systemd); run `mf update` then restart it on the machine'
            )
        this.rateLimit.consume({
            key: `daemon:upgrade:${actorId}`,
            limit: UPGRADE_RATE_LIMIT,
            windowMs: UPGRADE_RATE_WINDOW_MS
        })
        // A daemon self-updates from its OWN installed channel (baked into the
        // binary). A pinned target on the same channel needs nothing extra; a
        // cross-channel target (gated above) rides a `channel` override that
        // tells the daemon which CDN to pull from. No target = latest.
        const { version: targetVersion, channel } =
            await this.resolveDaemonTarget(host, args.targetVersion)
        const payload: Record<string, unknown> = {}
        if (targetVersion) payload.targetVersion = targetVersion
        // The wire value stays `staging` for the dev channel: daemons built
        // before the rename only accept `staging`/`stable` and would silently
        // drop `dev`, then fetch the pinned version from their own CDN and 404.
        // New daemons normalize both. Flip this once no pre-rename daemon can
        // reach a cross-channel upgrade.
        if (channel) payload.channel = channel === 'dev' ? 'staging' : channel
        let ack: Record<string, unknown> | undefined
        try {
            ack = await this.registry.rpc({
                daemonId: host.id,
                method: 'daemon.update',
                payload,
                timeoutMs: UPGRADE_RPC_TIMEOUT_MS
            })
        } catch (err) {
            const detail = (err as Error).message
            if (/not_implemented/i.test(detail))
                throw new ConflictException(
                    `${host.name} is running CLI ${host.cliVersion ?? 'an older version'}, which is too old to upgrade remotely. On that machine, reinstall the CLI and run \`mf daemon start\` (this also migrates an older \`nca\` install and keeps the same agents); afterwards you can upgrade from here.`
                )
            throw new ServiceUnavailableException(
                `daemon upgrade failed: ${detail}`
            )
        }
        const toVersion =
            typeof ack?.toVersion === 'string' ? ack.toVersion : targetVersion
        const deferred = ack?.deferred === true
        const result: UpgradeDaemonHostResponse = {
            ok: true,
            fromVersion: host.cliVersion,
            toVersion: toVersion ?? null,
            restarting:
                typeof ack?.restarting === 'boolean'
                    ? ack.restarting
                    : undefined,
            ...(deferred ? { deferred: true } : {}),
            ...(typeof ack?.activeSessions === 'number'
                ? { activeSessions: ack.activeSessions }
                : {})
        }
        await this.audit(
            actorId,
            auditAction.DAEMON_UPGRADE_REQUESTED,
            host.id,
            {
                fromVersion: host.cliVersion,
                toVersion: result.toVersion,
                ...(deferred ? { deferred: true } : {})
            }
        )
        return result
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
        } catch {}
    }
}
