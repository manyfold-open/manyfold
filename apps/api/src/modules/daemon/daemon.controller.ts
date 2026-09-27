import {
    DaemonHostSummary,
    DaemonTokenSummary,
    DetectedFramework,
    HeartbeatRequest,
    HeartbeatResponse,
    IssueDaemonTokenBody,
    IssueDaemonTokenResponse,
    RegisterDaemonRequest,
    RegisterDaemonResponse,
    UpgradeDaemonHostResponse,
    auditAction,
    type UpgradeHerdrResponse
} from '@manyfold/shared'
import {
    BadRequestException,
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    Inject,
    NotFoundException,
    Param,
    Patch,
    Post,
    Req,
    UseGuards
} from '@nestjs/common'
import { count, eq, inArray } from 'drizzle-orm'
import type { FastifyRequest } from 'fastify'
import {
    agents,
    agentRuntimes,
    auditLogs,
    type Database,
    type RuntimeHostRow
} from '@manyfold/db'
import { AuthGuard, type AuthPrincipal } from '@/common/guards/auth.guard'
import { CurrentUser } from '@/common/decorators/current-user.decorator'
import { DRIZZLE } from '@/db/tokens'
import { HostDaemonsService } from '@/modules/hosts/host-daemons.service'
import { DaemonAuthGuard } from './daemon-auth.guard'
import { CurrentDaemon } from './current-daemon.decorator'
import {
    DaemonTokenService,
    type DaemonAuthContext
} from './daemon-token.service'
import { DaemonHostService, type DaemonSummaryRuntime } from './daemon-host.service'
import { CliUpgradeDto } from './dto/cli-upgrade.dto'
import { RenameDaemonHostDto } from './dto/rename-host.dto'
import { DaemonRuntimeSyncService } from './daemon-runtime-sync.service'
import { DaemonRateLimitService } from './daemon-rate-limit.service'
import { DaemonRegistryService } from './daemon-registry.service'
import { randomUUID } from 'node:crypto'

const REGISTER_LIMIT = 10
const HEARTBEAT_LIMIT = 60
const TOKEN_ISSUE_LIMIT = 5
const RATE_WINDOW_MS = 60_000

@Controller('daemon')
export class DaemonController {
    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly tokens: DaemonTokenService,
        private readonly hosts: DaemonHostService,
        private readonly hostDaemons: HostDaemonsService,
        private readonly runtimeSync: DaemonRuntimeSyncService,
        private readonly rateLimit: DaemonRateLimitService,
        private readonly registry: DaemonRegistryService
    ) {}

    @Post('register')
    @UseGuards(DaemonAuthGuard)
    async register(
        @CurrentDaemon() auth: DaemonAuthContext,
        @Body() body: RegisterDaemonRequest,
        @Req() req: FastifyRequest
    ): Promise<RegisterDaemonResponse> {
        validateRegisterRequest(body)
        const lastIp =
            (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ??
            req.ip ??
            null

        this.rateLimit.consume({
            key: `daemon:register:${lastIp ?? 'unknown'}`,
            limit: REGISTER_LIMIT,
            windowMs: RATE_WINDOW_MS
        })

        const { host } = await this.hosts.upsertOnRegister({
            tokenId: auth.tokenId,
            request: body,
            lastIp
        })
        await this.runtimeSync.syncForDaemon({
            host,
            detectedFrameworks: body.detectedFrameworks
        })
        await this.audit(host.userId, auditAction.DAEMON_REGISTERED, host.id, {
            daemonUuid: body.daemonUuid,
            kind: host.kind,
            detectedFrameworks: body.detectedFrameworks.map((d) => d.framework)
        })
        return { daemonId: host.id, wsUrl: '/api/daemon/ws' }
    }

    @Post('heartbeat')
    @UseGuards(DaemonAuthGuard)
    async heartbeat(
        @CurrentDaemon() auth: DaemonAuthContext,
        @Body() body: HeartbeatRequest
    ): Promise<HeartbeatResponse> {
        if (!auth.hostId)
            throw new BadRequestException(
                'token not bound to a host; call /register first'
            )
        this.rateLimit.consume({
            key: `daemon:heartbeat:${auth.tokenId}`,
            limit: HEARTBEAT_LIMIT,
            windowMs: RATE_WINDOW_MS
        })
        const registered = await this.hosts.heartbeat({
            daemonId: auth.hostId,
            detectedFrameworks: body.detectedFrameworks,
            cliVersion: body.cliVersion,
            startupMethod: body.startupMethod,
            terminalPty:
                typeof body.terminalPty === 'boolean'
                    ? body.terminalPty
                    : undefined,
            clientFeatures: Array.isArray(body.clientFeatures)
                ? body.clientFeatures
                : undefined,
            // Absent from an older daemon (kept), null from a daemon that
            // looked and found nothing (cleared).
            herdrVersion:
                body.herdrVersion === undefined
                    ? undefined
                    : typeof body.herdrVersion === 'string'
                      ? body.herdrVersion
                      : null
        })
        if (registered)
            await this.runtimeSync.syncForDaemon({
                host: registered.host,
                detectedFrameworks: body.detectedFrameworks
            })
        if (registered && body.terminals !== undefined)
            this.hosts.reportTerminalInventory(auth.hostId, body.terminals)
        return { ok: true, actions: [] }
    }

    @Get('me')
    @UseGuards(DaemonAuthGuard)
    async me(
        @CurrentDaemon() auth: DaemonAuthContext
    ): Promise<DaemonHostSummary> {
        if (!auth.hostId)
            throw new BadRequestException(
                'token not bound to a host; call /register first'
            )
        const host = await this.hosts.findById(auth.hostId)
        if (!host) throw new NotFoundException('daemon host not found')
        return this.summarize(host)
    }

    @Post('tokens')
    @UseGuards(AuthGuard)
    async issueToken(
        @CurrentUser() user: AuthPrincipal,
        @Body() body: IssueDaemonTokenBody
    ): Promise<IssueDaemonTokenResponse> {
        if (!body.name?.trim())
            throw new BadRequestException('name is required')
        this.rateLimit.consume({
            key: `daemon:token-issue:${user.userId}`,
            limit: TOKEN_ISSUE_LIMIT,
            windowMs: RATE_WINDOW_MS
        })
        const minted = await this.tokens.mint({
            userId: user.userId,
            name: body.name.trim(),
            expiresInDays: body.expiresInDays ?? 90
        })
        await this.audit(
            user.userId,
            auditAction.DAEMON_TOKEN_ISSUED,
            minted.tokenId,
            { name: body.name }
        )
        return {
            token: minted.plaintext,
            summary: {
                id: minted.tokenId,
                name: minted.name,
                hostId: null,
                lastUsedAt: null,
                expiresAt: minted.expiresAt?.toISOString() ?? null,
                revokedAt: null,
                createdAt: minted.createdAt.toISOString()
            }
        }
    }

    @Get('tokens')
    @UseGuards(AuthGuard)
    async listTokens(
        @CurrentUser() user: AuthPrincipal
    ): Promise<DaemonTokenSummary[]> {
        const rows = await this.tokens.listForUser(user.userId)
        return rows.map((r) => ({
            id: r.id,
            name: r.name,
            hostId: r.hostId,
            lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
            expiresAt: r.expiresAt?.toISOString() ?? null,
            revokedAt: r.revokedAt?.toISOString() ?? null,
            createdAt: r.createdAt.toISOString()
        }))
    }

    @Delete('tokens/:id')
    @HttpCode(204)
    @UseGuards(AuthGuard)
    async revokeToken(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<void> {
        const hostId = await this.tokens.revoke({
            tokenId: id,
            userId: user.userId
        })
        if (hostId) this.registry.disconnect(hostId, 'daemon token revoked')
        await this.audit(user.userId, auditAction.DAEMON_TOKEN_REVOKED, id, {})
    }

    @Get('hosts')
    @UseGuards(AuthGuard)
    async listHosts(
        @CurrentUser() user: AuthPrincipal
    ): Promise<DaemonHostSummary[]> {
        const hosts = await this.hosts.listForUser(user.userId)
        if (hosts.length === 0) return []
        const hostIds = hosts.map((h) => h.id)
        const [daemons, countsRaw, runtimeRows] = await Promise.all([
            this.hostDaemons.findByHostIds(hostIds),
            this.db
                .select({ hostId: agentRuntimes.hostId, count: count() })
                .from(agents)
                .innerJoin(agentRuntimes, eq(agentRuntimes.id, agents.runtimeId))
                .where(inArray(agentRuntimes.hostId, hostIds))
                .groupBy(agentRuntimes.hostId),
            this.db
                .select({
                    id: agentRuntimes.id,
                    hostId: agentRuntimes.hostId,
                    framework: agentRuntimes.framework,
                    name: agentRuntimes.name,
                    status: agentRuntimes.status
                })
                .from(agentRuntimes)
                .where(inArray(agentRuntimes.hostId, hostIds))
        ])
        const countByHost = new Map(
            countsRaw.map((r) => [r.hostId, Number(r.count)])
        )
        const runtimesByHost = new Map<string, DaemonSummaryRuntime[]>()
        for (const r of runtimeRows) {
            if (!r.hostId) continue
            const list = runtimesByHost.get(r.hostId) ?? []
            list.push({
                runtimeId: r.id,
                framework: r.framework as DetectedFramework['framework'],
                name: r.name,
                status: r.status
            })
            runtimesByHost.set(r.hostId, list)
        }
        const out: DaemonHostSummary[] = []
        for (const host of hosts) {
            out.push(
                await this.hosts.toSummary(
                    host,
                    daemons.get(host.id) ?? null,
                    runtimesByHost.get(host.id) ?? [],
                    countByHost.get(host.id) ?? 0
                )
            )
        }
        return out
    }

    @Delete('hosts/:id')
    @HttpCode(204)
    @UseGuards(AuthGuard)
    async revokeHost(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<void> {
        await this.hosts.revoke({ id, userId: user.userId })
        await this.audit(user.userId, auditAction.DAEMON_REVOKED, id, {})
    }

    @Delete('hosts/:id/permanent')
    @HttpCode(204)
    @UseGuards(AuthGuard)
    async deleteHost(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<void> {
        await this.hosts.deleteRetired({
            id,
            actorId: user.userId,
            userId: user.userId
        })
    }

    @Post('hosts/:id/upgrade')
    @UseGuards(AuthGuard)
    async upgradeHost(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Body() body?: CliUpgradeDto
    ): Promise<UpgradeDaemonHostResponse> {
        const host = await this.hosts.findById(id)
        if (!host || host.userId !== user.userId)
            throw new NotFoundException('daemon host not found')
        return this.hosts.upgrade({
            host,
            actorId: user.userId,
            targetVersion: body?.targetVersion
        })
    }

    // herdr on the machine, through herdr's own updater (ADR-0031).
    @Post('hosts/:id/herdr/upgrade')
    @UseGuards(AuthGuard)
    async upgradeHerdr(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<UpgradeHerdrResponse> {
        const host = await this.hosts.findById(id)
        if (!host || host.userId !== user.userId)
            throw new NotFoundException('daemon host not found')
        return this.hosts.upgradeHerdr({ host, actorId: user.userId })
    }

    @Patch('hosts/:id/name')
    @UseGuards(AuthGuard)
    async renameHost(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Body() body: RenameDaemonHostDto
    ): Promise<DaemonHostSummary> {
        const host = await this.hosts.rename({
            id,
            userId: user.userId,
            name: body.name
        })
        return this.summarize(host)
    }

    private async summarize(host: RuntimeHostRow): Promise<DaemonHostSummary> {
        const [daemon, runtimes, agentCount] = await Promise.all([
            this.hostDaemons.findByHostId(host.id),
            this.db
                .select()
                .from(agentRuntimes)
                .where(eq(agentRuntimes.hostId, host.id)),
            this.hosts.agentCount(host.id)
        ])
        return this.hosts.toSummary(
            host,
            daemon,
            runtimes.map((r) => ({
                runtimeId: r.id,
                framework: r.framework as DetectedFramework['framework'],
                name: r.name,
                status: r.status
            })),
            agentCount
        )
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

const validateRegisterRequest = (body: RegisterDaemonRequest): void => {
    if (!body.daemonUuid?.trim())
        throw new BadRequestException('daemonUuid required')
    if (!body.name?.trim()) throw new BadRequestException('name required')
    if (!body.os?.trim()) throw new BadRequestException('os required')
    if (!body.homeDir?.trim()) throw new BadRequestException('homeDir required')
    if (!Array.isArray(body.detectedFrameworks))
        throw new BadRequestException('detectedFrameworks required')
    if (body.terminalPty !== undefined && typeof body.terminalPty !== 'boolean')
        throw new BadRequestException('terminalPty must be a boolean')
}
