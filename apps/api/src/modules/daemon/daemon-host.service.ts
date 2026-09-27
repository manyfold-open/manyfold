import {
    DAEMON_FEATURE_DAEMON_UPDATE,
    DAEMON_FEATURE_MANUAL_UPDATE,
    DAEMON_FEATURE_PTY_COMMAND,
    DAEMON_MIN_CLI_VERSION,
    DaemonHostSummary,
    DaemonOwnedTerminal,
    DaemonStartupMethod,
    DetectedFramework,
    MfCliChannel,
    RegisterDaemonRequest,
    UpgradeDaemonHostResponse,
    auditAction,
    cliChannelOfVersion,
    createObjectId,
    daemonOnline,
    isCliUpdateAvailable,
    isCliVersionTooOld,
    isObjectId,
    runtimeAvailability,
    DAEMON_FEATURE_HERDR_TERMINAL,
    herdrFrameworksFor,
    type UpgradeHerdrResponse
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
    UnauthorizedException,
    Optional
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { and, count, eq, inArray } from 'drizzle-orm'
import {
    agents,
    agentRuntimes,
    auditLogs,
    daemonTokens,
    hostDaemons,
    runtimeHosts,
    serviceLeases,
    type AgentRuntimeInstallStatus,
    type Database,
    type HostDaemonRow,
    type RuntimeHostRow
} from '@manyfold/db'
import {
    cliDevAllowedForDeployEnv,
    resolveMfDeployEnv
} from '@/common/deploy-env'
import { DRIZZLE } from '@/db/tokens'
import { AdminSettingsService } from '@/modules/admin-settings/admin-settings.service'
import { RuntimeAccessService } from '@/modules/runtime-access/runtime-access.service'
import { HostsService } from '@/modules/hosts/hosts.service'
import { HostDaemonsService } from '@/modules/hosts/host-daemons.service'
import { DaemonRegistryService } from './daemon-registry.service'
import { DaemonRateLimitService } from './daemon-rate-limit.service'
import { DaemonTokenService } from './daemon-token.service'
import { HerdrVersionService } from '@/modules/daemon/herdr-version.service'
import { DaemonCliVersionService } from './daemon-cli-version.service'
import { CliVersionCatalogService } from './cli-version-catalog.service'

const UPGRADE_RATE_LIMIT = 5
const UPGRADE_RATE_WINDOW_MS = 60_000
const UPGRADE_RPC_TIMEOUT_MS = 180_000
// herdr's updater downloads a binary; give it the room of an install.
const HERDR_UPGRADE_RPC_TIMEOUT_MS = 200_000

const isInitUnitStartup = (
    method: DaemonStartupMethod | null
): method is Exclude<DaemonStartupMethod, 'manual'> =>
    method !== null && method !== 'manual'

// Who brings the daemon back after the swap: its init unit or a pod host's
// boot loop (ADR-0035), or — for a manual start that says so (ADR-0029 §5) —
// the daemon itself, by handing off to a successor it starts and rolling back
// if that never comes up.
const canRestartAfterUpdate = (daemon: {
    startupMethod: DaemonStartupMethod | null
    clientFeatures: string[]
}): boolean =>
    isInitUnitStartup(daemon.startupMethod) ||
    daemon.clientFeatures.includes(DAEMON_FEATURE_MANUAL_UPDATE)

// The host a daemon registered onto, with the connection row the register
// or heartbeat just wrote.
export interface RegisteredDaemon {
    host: RuntimeHostRow
    daemon: HostDaemonRow
}

export interface DaemonSummaryRuntime {
    runtimeId: string
    framework: DetectedFramework['framework']
    name: string
    status: AgentRuntimeInstallStatus
}

const isUsableHost = (host: RuntimeHostRow): boolean =>
    host.status !== 'retired' && host.status !== 'deleting'

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
        private readonly config: ConfigService,
        private readonly hosts: HostsService,
        private readonly hostDaemons: HostDaemonsService,
        private readonly tokens: DaemonTokenService,
        // Appended last + @Optional so positional test construction keeps
        // working; absent, no herdr update is ever offered.
        @Optional()
        private readonly herdrVersions?: HerdrVersionService
    ) {}

    // The terminals a daemon owns (ADR-0029 §6), as its hello and heartbeat
    // list them. Fanned out to whoever holds terminal rows; nothing is kept
    // here, since the list changes with every shell that opens or exits.
    private readonly inventoryListeners = new Set<
        (daemonId: string, terminals: DaemonOwnedTerminal[]) => void
    >()

    onTerminalInventory(
        listener: (daemonId: string, terminals: DaemonOwnedTerminal[]) => void
    ): () => void {
        this.inventoryListeners.add(listener)
        return () => {
            this.inventoryListeners.delete(listener)
        }
    }

    // A list with one malformed entry is no list at all: a listener would
    // read the missing entry as a terminal that ended.
    reportTerminalInventory(daemonId: string, terminals: unknown): void {
        if (!Array.isArray(terminals) || terminals.length > 256) return
        const parsed: DaemonOwnedTerminal[] = []
        for (const entry of terminals) {
            const record =
                entry && typeof entry === 'object'
                    ? (entry as Record<string, unknown>)
                    : null
            if (
                !record ||
                typeof record.terminalId !== 'string' ||
                !isObjectId(record.terminalId, 'terminalSession') ||
                typeof record.attached !== 'boolean' ||
                typeof record.startedAt !== 'string'
            ) {
                this.log.warn(
                    `daemon.terminals.invalid daemonId=${daemonId}; inventory ignored`
                )
                return
            }
            parsed.push({
                terminalId: record.terminalId,
                attached: record.attached,
                startedAt: record.startedAt
            })
        }
        for (const listener of this.inventoryListeners) {
            try {
                listener(daemonId, parsed)
            } catch (err) {
                this.log.warn(
                    `daemon.terminals.listener_failed daemonId=${daemonId}: ${(err as Error).message}`
                )
            }
        }
    }

    private assertSupportedVersion(version: string): void {
        if (isCliVersionTooOld(version, DAEMON_MIN_CLI_VERSION))
            throw new BadRequestException({
                code: 'DAEMON_UPGRADE_REQUIRED',
                message: `daemon CLI ${DAEMON_MIN_CLI_VERSION} or newer is required; run mf update`
            })
    }

    // Cross-channel upgrades are limited to local/staging deployments.
    private crossChannelAllowed(daemon: HostDaemonRow | null): boolean {
        return (
            cliDevAllowedForDeployEnv(
                resolveMfDeployEnv(this.config.get<string>('MF_DEPLOY_ENV'))
            ) &&
            !isCliVersionTooOld(daemon?.cliVersion ?? null, DAEMON_MIN_CLI_VERSION)
        )
    }

    // Registration (ADR-0037 R1/R2/R5). A token bound to a host registers
    // onto that host and nothing else; an unbound token is the user's own
    // and its first register creates the `local` host it then binds to. In
    // both cases the daemon's connection row is upserted for the host.
    async upsertOnRegister(args: {
        tokenId: string
        request: RegisterDaemonRequest
        lastIp: string | null
    }): Promise<RegisteredDaemon> {
        const { tokenId, request, lastIp } = args
        this.assertSupportedVersion(request.cliVersion)
        return this.db.transaction(async (tx) => {
            const assertUsable = <T extends { revokedAt: Date | null; expiresAt: Date | null }>(
                row: T | undefined
            ): T => {
                if (!row) throw new UnauthorizedException('token not found')
                if (row.revokedAt)
                    throw new UnauthorizedException('token revoked')
                if (row.expiresAt && row.expiresAt < new Date())
                    throw new UnauthorizedException('token expired')
                return row
            }
            // Lock order host → token, the same as a host deletion's (host
            // row, then its tokens through the cascade), so a registration
            // racing the cleanup of its host waits instead of deadlocking.
            const [peek] = await tx
                .select()
                .from(daemonTokens)
                .where(eq(daemonTokens.id, tokenId))
                .limit(1)
            const boundHostId = assertUsable(peek).hostId
            let boundRow: RuntimeHostRow | undefined
            if (boundHostId) {
                ;[boundRow] = await tx
                    .select()
                    .from(runtimeHosts)
                    .where(eq(runtimeHosts.id, boundHostId))
                    .for('update')
                    .limit(1)
            }
            const [locked] = await tx
                .select()
                .from(daemonTokens)
                .where(eq(daemonTokens.id, tokenId))
                .for('update')
                .limit(1)
            const token = assertUsable(locked)
            if (token.hostId !== boundHostId)
                throw new ForbiddenException('token binding changed')

            const userId = token.userId
            const now = new Date()
            // The machine's filesystem contract, declared by its daemon
            // (ADR-0014). Its display name is the user's once it exists.
            const declared = {
                homeDir: request.homeDir,
                workspaceBaseDir: request.workspaceBaseDir,
                skillsDir: request.skillsDir ?? null
            }
            let host: RuntimeHostRow
            if (token.hostId) {
                const bound = boundRow
                if (!bound || bound.userId !== userId)
                    throw new ForbiddenException(
                        'token is bound to a host that no longer exists'
                    )
                if (!isUsableHost(bound))
                    throw new ForbiddenException(
                        `host ${bound.id} is ${bound.status}`
                    )
                const becomesReady =
                    bound.kind === 'hosted' &&
                    (bound.status === 'provisioning' ||
                        bound.status === 'failed')
                const [updated] = await tx
                    .update(runtimeHosts)
                    .set({
                        ...declared,
                        ...(becomesReady
                            ? { status: 'ready' as const, failureReason: null }
                            : {}),
                        updatedAt: now
                    })
                    .where(eq(runtimeHosts.id, bound.id))
                    .returning()
                host = updated
            } else {
                await this.runtimeAccess.lockDaemonHostRegistrationInTx(
                    tx,
                    userId
                )
                // The computer may already be one of the user's local
                // hosts (a new token for the same machine): the persisted
                // daemon uuid finds it again.
                const [known] = await tx
                    .select({ host: runtimeHosts, daemon: hostDaemons })
                    .from(hostDaemons)
                    .innerJoin(
                        runtimeHosts,
                        eq(runtimeHosts.id, hostDaemons.hostId)
                    )
                    .where(
                        and(
                            eq(hostDaemons.userId, userId),
                            eq(hostDaemons.daemonUuid, request.daemonUuid)
                        )
                    )
                    .for('update')
                    .limit(1)
                if (known && known.host.kind !== 'local')
                    throw new ForbiddenException(
                        'an ordinary token cannot register a hosted machine'
                    )
                if (known && known.host.status === 'deleting')
                    throw new ForbiddenException(
                        `host ${known.host.id} is deleting`
                    )
                if (known && known.host.status === 'retired') {
                    // A retired host is never reactivated: the same machine
                    // registering again becomes a new host, and the retired
                    // one gives up the uuid it can no longer use.
                    await tx
                        .delete(hostDaemons)
                        .where(eq(hostDaemons.hostId, known.host.id))
                }
                if (known && known.host.status !== 'retired') {
                    const [updated] = await tx
                        .update(runtimeHosts)
                        .set({ ...declared, updatedAt: now })
                        .where(eq(runtimeHosts.id, known.host.id))
                        .returning()
                    host = updated
                } else {
                    await this.runtimeAccess.assertDaemonHostSlotAvailableInTx(
                        tx,
                        userId
                    )
                    const [inserted] = await tx
                        .insert(runtimeHosts)
                        .values({
                            id: createObjectId('daemonHost'),
                            userId,
                            kind: 'local',
                            name: request.name,
                            status: 'ready',
                            ...declared
                        })
                        .returning()
                    host = inserted
                }
                await tx
                    .update(daemonTokens)
                    .set({ hostId: host.id })
                    .where(eq(daemonTokens.id, token.id))
            }

            const daemon = await this.hostDaemons.upsert(
                host.id,
                {
                    userId,
                    daemonUuid: request.daemonUuid,
                    tokenId: token.id,
                    hostname: request.hostname,
                    os: request.os,
                    arch: request.arch,
                    cliVersion: request.cliVersion,
                    herdrVersion: request.herdrVersion ?? null,
                    terminalPty: request.terminalPty ?? null,
                    detectedFrameworks: request.detectedFrameworks,
                    lastSeenAt: now,
                    lastIp
                },
                tx
            )
            return { host, daemon }
        })
    }

    // Fires every 15s per online daemon and writes host_daemons only: the
    // host row never sees a heartbeat. The steady-state SET is trimmed to
    // the presence column alone; the reported metadata (including the
    // detectedFrameworks JSONB) is only re-written when it actually differs.
    // lastSeenAt always advances — presence is derived from it (#629).
    async heartbeat(args: {
        daemonId: string
        detectedFrameworks: DetectedFramework[]
        cliVersion: string
        startupMethod: DaemonStartupMethod
        terminalPty?: boolean
        clientFeatures?: string[]
        // undefined = an older daemon that does not report it (kept as is);
        // null = looked and found nothing.
        herdrVersion?: string | null
    }): Promise<RegisteredDaemon | null> {
        this.assertSupportedVersion(args.cliVersion)
        const host = await this.hosts.findById(args.daemonId)
        if (!host) throw new NotFoundException('daemon host not found')
        if (!isUsableHost(host))
            throw new ForbiddenException(`daemon host is ${host.status}`)
        const daemon = await this.hostDaemons.findByHostId(host.id)
        if (!daemon)
            throw new NotFoundException(
                'daemon not registered on this host; call /register first'
            )
        const now = new Date()
        const terminalPty = args.terminalPty ?? null
        const changed: Partial<HostDaemonRow> = {}
        // JSONB does not preserve object-key order; array order still matters.
        if (
            !isDeepStrictEqual(daemon.detectedFrameworks, args.detectedFrameworks)
        )
            changed.detectedFrameworks = args.detectedFrameworks
        if (daemon.cliVersion !== args.cliVersion)
            changed.cliVersion = args.cliVersion
        if (daemon.startupMethod !== args.startupMethod)
            changed.startupMethod = args.startupMethod
        if (daemon.terminalPty !== terminalPty) changed.terminalPty = terminalPty
        if (
            args.clientFeatures &&
            !isDeepStrictEqual(daemon.clientFeatures, args.clientFeatures)
        )
            changed.clientFeatures = args.clientFeatures
        if (
            args.herdrVersion !== undefined &&
            daemon.herdrVersion !== args.herdrVersion
        )
            changed.herdrVersion = args.herdrVersion
        const patch: Partial<HostDaemonRow> = {
            ...changed,
            ...(Object.keys(changed).length > 0 ? { updatedAt: now } : {}),
            lastSeenAt: now
        }
        const updated = await this.hostDaemons.patch(host.id, patch)
        return { host, daemon: updated ?? { ...daemon, ...patch } }
    }

    async touchLastSeen(daemonId: string): Promise<void> {
        await this.hostDaemons.patch(daemonId, { lastSeenAt: new Date() })
    }

    async findById(id: string): Promise<RuntimeHostRow | null> {
        return this.hosts.findById(id)
    }

    async findDaemon(hostId: string): Promise<HostDaemonRow | null> {
        return this.hostDaemons.findByHostId(hostId)
    }

    // User-facing: "the computers you connected". Hosted hosts are the
    // platform's machines and live under sandboxes / cloud computers.
    async listForUser(userId: string): Promise<RuntimeHostRow[]> {
        return this.hosts.listForUser(userId, 'local')
    }

    // Retire a local host (ADR-0037 R5): its tokens are revoked in the same
    // transaction, its connection dropped, and nothing can reactivate it —
    // only permanent deletion is left.
    async revoke(args: { id: string; userId: string }): Promise<void> {
        const retired = await this.db.transaction(async (tx) => {
            const [row] = await tx
                .update(runtimeHosts)
                .set({ status: 'retired', updatedAt: new Date() })
                .where(
                    and(
                        eq(runtimeHosts.id, args.id),
                        eq(runtimeHosts.userId, args.userId),
                        eq(runtimeHosts.kind, 'local')
                    )
                )
                .returning({ id: runtimeHosts.id })
            if (!row) return false
            await this.tokens.revokeForHost(args.id, tx)
            return true
        })
        if (!retired) throw new NotFoundException('daemon host not found')
        this.registry.disconnect(args.id, 'daemon host revoked')
    }

    // Permanent deletion of a retired local host: database only, in one
    // transaction, refused while any agent still lives on it (R8).
    async deleteRetired(args: {
        id: string
        actorId: string
        userId?: string
    }): Promise<void> {
        const host = await this.hosts.findById(args.id)
        if (
            !host ||
            host.kind !== 'local' ||
            (args.userId !== undefined && host.userId !== args.userId)
        ) {
            throw new NotFoundException('daemon host not found')
        }
        if (host.status !== 'retired')
            throw new ConflictException(
                'daemon host must be retired before deletion'
            )
        const agentCount = await this.agentCount(host.id)
        if (agentCount > 0)
            throw new ConflictException({
                code: 'HOST_NOT_EMPTY',
                message: `daemon host still has ${agentCount} agent(s); delete them first`,
                count: agentCount
            })
        const deletedRuntimeCount = await this.db.transaction(async (tx) => {
            const deletedRuntimes = await tx
                .delete(agentRuntimes)
                .where(eq(agentRuntimes.hostId, args.id))
                .returning({ id: agentRuntimes.id })
            await this.hostDaemons.deleteByHostId(args.id, tx)
            const [deleted] = await tx
                .delete(runtimeHosts)
                .where(
                    and(
                        eq(runtimeHosts.id, args.id),
                        eq(runtimeHosts.kind, 'local'),
                        eq(runtimeHosts.status, 'retired'),
                        args.userId === undefined
                            ? undefined
                            : eq(runtimeHosts.userId, args.userId)
                    )
                )
                .returning({ id: runtimeHosts.id })
            if (!deleted)
                throw new ConflictException(
                    'daemon host must be retired before deletion'
                )
            await tx
                .delete(serviceLeases)
                .where(eq(serviceLeases.name, `daemon-config:${args.id}`))
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
                    eq(runtimeHosts.kind, 'local')
                )
            )
            .returning()
        if (!updated) throw new NotFoundException('daemon host not found')
        return updated
    }

    // Presence is derived (ADR-0037): the daemon's last heartbeat inside the
    // window, nothing stored and nothing swept.
    isOnline(daemon: HostDaemonRow | null | undefined): boolean {
        return daemonOnline(daemon)
    }

    async agentCount(hostId: string): Promise<number> {
        const [row] = await this.db
            .select({ value: count() })
            .from(agents)
            .innerJoin(agentRuntimes, eq(agentRuntimes.id, agents.runtimeId))
            .where(eq(agentRuntimes.hostId, hostId))
        return Number(row?.value ?? 0)
    }

    async resolveNeedsUpgradeMap(
        hostIds: Array<string | null | undefined>
    ): Promise<Map<string, boolean>> {
        const result = new Map<string, boolean>()
        const uniqueIds = Array.from(
            new Set(
                hostIds.filter(
                    (id): id is string => typeof id === 'string' && id.length > 0
                )
            )
        )
        if (uniqueIds.length === 0) return result
        const { minVersion } =
            await this.adminSettings.getCachedCliMinimumVersion()
        const rows = await this.db
            .select({ hostId: hostDaemons.hostId, cliVersion: hostDaemons.cliVersion })
            .from(hostDaemons)
            .where(inArray(hostDaemons.hostId, uniqueIds))
        const cliVersionById = new Map<string, string | null>()
        for (const row of rows) cliVersionById.set(row.hostId, row.cliVersion)
        for (const id of uniqueIds) {
            const cliVersion = cliVersionById.get(id) ?? null
            result.set(id,
                isCliVersionTooOld(cliVersion, DAEMON_MIN_CLI_VERSION) ||
                isCliVersionTooOld(cliVersion, minVersion)
            )
        }
        return result
    }

    async toSummary(
        host: RuntimeHostRow,
        daemon: HostDaemonRow | null,
        runtimes: DaemonSummaryRuntime[],
        agentCount: number
    ): Promise<DaemonHostSummary> {
        const { minVersion } =
            await this.adminSettings.getCachedCliMinimumVersion()
        const { version: latestCliVersion, channel } =
            await this.cliVersion.getCachedLatest()
        const latestHerdrVersion =
            (await this.herdrVersions?.getCachedLatest())?.version ?? null
        const online = this.isOnline(daemon)
        const features = daemon?.clientFeatures ?? []
        const cliVersion = daemon?.cliVersion ?? null
        return {
            id: host.id,
            name: host.name,
            kind: host.kind,
            registered: daemon !== null,
            daemonUuid: daemon?.daemonUuid ?? '',
            hostname: daemon?.hostname ?? null,
            os: daemon?.os ?? null,
            arch: daemon?.arch ?? null,
            cliVersion,
            needsUpgrade:
                isCliVersionTooOld(cliVersion, DAEMON_MIN_CLI_VERSION) ||
                isCliVersionTooOld(cliVersion, minVersion),
            latestCliVersion,
            updateAvailable: isCliUpdateAvailable(
                channel,
                cliVersion,
                latestCliVersion
            ),
            canRemoteUpgrade:
                online &&
                daemon !== null &&
                canRestartAfterUpdate(daemon) &&
                features.includes(DAEMON_FEATURE_DAEMON_UPDATE),
            canCrossChannelUpgrade: this.crossChannelAllowed(daemon),
            canResumeInTerminal: features.includes(DAEMON_FEATURE_PTY_COMMAND),
            canOpenInHerdr:
                features.includes(DAEMON_FEATURE_HERDR_TERMINAL) &&
                features.includes(DAEMON_FEATURE_PTY_COMMAND),
            herdrFrameworks: features.includes(DAEMON_FEATURE_PTY_COMMAND)
                ? herdrFrameworksFor(features)
                : [],
            herdrVersion: daemon?.herdrVersion ?? null,
            latestHerdrVersion,
            herdrUpdateAvailable: HerdrVersionService.updateAvailable(
                daemon?.herdrVersion ?? null,
                latestHerdrVersion
            ),
            startupMethod: daemon?.startupMethod ?? null,
            homeDir: host.homeDir,
            workspaceBaseDir: host.workspaceBaseDir,
            detectedFrameworks: daemon?.detectedFrameworks ?? [],
            status: host.status,
            online,
            lastSeenAt: daemon?.lastSeenAt?.toISOString() ?? null,
            createdAt: host.createdAt.toISOString(),
            agentCount,
            runtimes: runtimes.map((r) => ({
                runtimeId: r.runtimeId,
                framework: r.framework,
                name: r.name,
                status: r.status,
                availability: runtimeAvailability({
                    runtime: { status: r.status },
                    host: { kind: host.kind, status: host.status },
                    daemonOnline: online
                })
            }))
        }
    }

    private async requireOnlineDaemon(host: RuntimeHostRow): Promise<HostDaemonRow> {
        if (!isUsableHost(host))
            throw new BadRequestException(`daemon host is ${host.status}`)
        const daemon = await this.hostDaemons.findByHostId(host.id)
        if (!this.isOnline(daemon) || !daemon)
            throw new BadRequestException('daemon is offline')
        return daemon
    }

    // herdr on the machine (ADR-0031): herdr's own updater, run by the daemon,
    // which reports the version it left behind.
    async upgradeHerdr(args: {
        host: RuntimeHostRow
        actorId: string
    }): Promise<UpgradeHerdrResponse> {
        const { host, actorId } = args
        const daemon = await this.requireOnlineDaemon(host)
        if (!daemon.clientFeatures.includes(DAEMON_FEATURE_HERDR_TERMINAL))
            throw new BadRequestException(
                'herdr is not installed on this machine, or its Manyfold CLI is too old to update it from here'
            )
        this.rateLimit.consume({
            key: `daemon:upgrade:${actorId}`,
            limit: UPGRADE_RATE_LIMIT,
            windowMs: UPGRADE_RATE_WINDOW_MS
        })
        let ack: Record<string, unknown> | undefined
        try {
            ack = await this.registry.rpc({
                daemonId: host.id,
                method: 'herdr.update',
                payload: {},
                timeoutMs: HERDR_UPGRADE_RPC_TIMEOUT_MS
            })
        } catch (err) {
            throw new ServiceUnavailableException(
                `herdr upgrade failed: ${(err as Error).message}`
            )
        }
        const toVersion =
            typeof ack?.toVersion === 'string' ? ack.toVersion : null
        if (toVersion && toVersion !== daemon.herdrVersion)
            await this.hostDaemons.patch(host.id, {
                herdrVersion: toVersion,
                updatedAt: new Date()
            })
        this.log.log(
            `daemon.herdr.upgraded daemonId=${host.id} from=${daemon.herdrVersion ?? 'none'} to=${toVersion ?? 'unknown'}`
        )
        return { ok: true, fromVersion: daemon.herdrVersion, toVersion }
    }

    private async resolveDaemonTarget(
        daemon: HostDaemonRow,
        requested: string | undefined
    ): Promise<{ version: string | null; channel?: MfCliChannel }> {
        if (!requested) {
            const { version } = await this.cliVersion.getCachedLatest()
            if (version) this.assertSupportedVersion(version)
            return { version }
        }
        this.assertSupportedVersion(requested)
        if (!(await this.cliCatalog.isInstallableVersion(requested)))
            throw new BadRequestException(
                `unknown mf CLI version ${requested}`
            )
        const requestedChannel = cliChannelOfVersion(requested)
        const daemonChannel = cliChannelOfVersion(daemon.cliVersion)
        if (requestedChannel === daemonChannel) return { version: requested }
        // The channel override must accompany a cross-channel target.
        if (!this.crossChannelAllowed(daemon))
            throw new BadRequestException(
                `${requested} is on the ${requestedChannel} channel but this daemon is on ${daemonChannel}; cross-channel upgrades are only available in local/staging`
            )
        return { version: requested, channel: requestedChannel }
    }

    async upgrade(args: {
        host: RuntimeHostRow
        actorId: string
        targetVersion?: string
    }): Promise<UpgradeDaemonHostResponse> {
        const { host, actorId } = args
        const daemon = await this.requireOnlineDaemon(host)
        if (!canRestartAfterUpdate(daemon))
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
            await this.resolveDaemonTarget(daemon, args.targetVersion)
        const payload: Record<string, unknown> = {}
        if (targetVersion) payload.targetVersion = targetVersion
        if (channel) payload.channel = channel
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
                    `${host.name} is running CLI ${daemon.cliVersion ?? 'an older version'}, which is too old to upgrade remotely. On that machine, reinstall the CLI and run \`mf daemon start\` (this also migrates an older \`nca\` install and keeps the same agents); afterwards you can upgrade from here.`
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
            fromVersion: daemon.cliVersion,
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
                fromVersion: daemon.cliVersion,
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
