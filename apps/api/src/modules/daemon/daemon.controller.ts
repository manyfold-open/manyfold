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
    auditAction
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
import { agents, agentRuntimes, auditLogs, type Database } from '@manyfold/db'
import { AuthGuard, type AuthPrincipal } from '@/common/guards/auth.guard'
import { CurrentUser } from '@/common/decorators/current-user.decorator'
import { DRIZZLE } from '@/db/tokens'
import { DaemonAuthGuard } from './daemon-auth.guard'
import { CurrentDaemon } from './current-daemon.decorator'
import {
    DaemonTokenService,
    type DaemonAuthContext
} from './daemon-token.service'
import { DaemonHostService } from './daemon-host.service'
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

        const host = await this.hosts.upsertOnRegister({
            tokenId: auth.tokenId,
            request: body,
            lastIp
        })
        const runtimes = await this.runtimeSync.syncForDaemon({
            host,
            detectedFrameworks: body.detectedFrameworks
        })
        await this.audit(host.userId, auditAction.DAEMON_REGISTERED, host.id, {
            daemonUuid: body.daemonUuid,
            detectedFrameworks: body.detectedFrameworks.map((d) => d.framework)
        })
        return {
            daemonId: host.id,
            runtimes: runtimes.map((r) => ({
                runtimeId: r.id,
                framework: r.framework as DetectedFramework['framework']
            })),
            wsUrl: '/api/daemon/ws'
        }
    }

    @Post('heartbeat')
    @UseGuards(DaemonAuthGuard)
    async heartbeat(
        @CurrentDaemon() auth: DaemonAuthContext,
        @Body() body: HeartbeatRequest
    ): Promise<HeartbeatResponse> {
        if (!auth.daemonId)
            throw new BadRequestException(
                'token not bound to a daemon; call /register first'
            )
        this.rateLimit.consume({
            key: `daemon:heartbeat:${auth.tokenId}`,
            limit: HEARTBEAT_LIMIT,
            windowMs: RATE_WINDOW_MS
        })
        const host = await this.hosts.heartbeat({
            daemonId: auth.daemonId,
            detectedFrameworks: body.detectedFrameworks,
            cliVersion: body.cliVersion,
            startupMethod: body.startupMethod,
            terminalPty:
                typeof body.terminalPty === 'boolean'
                    ? body.terminalPty
                    : undefined,
            clientFeatures: Array.isArray(body.clientFeatures)
                ? body.clientFeatures
                : undefined
        })
        if (host)
            await this.runtimeSync.syncForDaemon({
                host,
                detectedFrameworks: body.detectedFrameworks
            })
        return { ok: true, actions: [] }
    }

    @Get('me')
    @UseGuards(DaemonAuthGuard)
    async me(
        @CurrentDaemon() auth: DaemonAuthContext
    ): Promise<DaemonHostSummary> {
        if (!auth.daemonId)
            throw new BadRequestException(
                'token not bound to a daemon; call /register first'
            )
        const host = await this.hosts.findById(auth.daemonId)
        if (!host) throw new NotFoundException('daemon host not found')
        const runtimes = await this.db
            .select()
            .from(agentRuntimes)
            .where(eq(agentRuntimes.daemonId, host.id))
        const [{ count: agentCount }] = await this.db
            .select({ count: count() })
            .from(agents)
            .where(eq(agents.daemonId, host.id))
        return this.hosts.toSummary(
            host,
            runtimes.map((r) => ({
                runtimeId: r.id,
                framework: r.framework as DetectedFramework['framework'],
                name: r.name
            })),
            Number(agentCount)
        )
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
                daemonId: null,
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
            daemonId: r.daemonId,
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
        const daemonId = await this.tokens.revoke({
            tokenId: id,
            userId: user.userId
        })
        if (daemonId) this.registry.disconnect(daemonId, 'daemon token revoked')
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
        const [countsRaw, runtimeRows] = await Promise.all([
            this.db
                .select({ daemonId: agents.daemonId, count: count() })
                .from(agents)
                .where(inArray(agents.daemonId, hostIds))
                .groupBy(agents.daemonId),
            this.db
                .select({
                    id: agentRuntimes.id,
                    daemonId: agentRuntimes.daemonId,
                    framework: agentRuntimes.framework,
                    name: agentRuntimes.name
                })
                .from(agentRuntimes)
                .where(inArray(agentRuntimes.daemonId, hostIds))
        ])
        const countByHost = new Map(
            countsRaw.map((r) => [r.daemonId, Number(r.count)])
        )
        const runtimesByDaemon = new Map<
            string,
            Array<{
                runtimeId: string
                framework: DetectedFramework['framework']
                name: string
            }>
        >()
        for (const r of runtimeRows) {
            if (!r.daemonId) continue
            const list = runtimesByDaemon.get(r.daemonId) ?? []
            list.push({
                runtimeId: r.id,
                framework: r.framework as DetectedFramework['framework'],
                name: r.name
            })
            runtimesByDaemon.set(r.daemonId, list)
        }
        const out: DaemonHostSummary[] = []
        for (const host of hosts) {
            out.push(
                await this.hosts.toSummary(
                    host,
                    runtimesByDaemon.get(host.id) ?? [],
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
        this.registry.disconnect(id, 'daemon host revoked')
        await this.audit(user.userId, auditAction.DAEMON_REVOKED, id, {})
    }

    @Delete('hosts/:id/permanent')
    @HttpCode(204)
    @UseGuards(AuthGuard)
    async deleteHost(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<void> {
        await this.hosts.deleteRevoked({
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
        const runtimes = await this.db
            .select()
            .from(agentRuntimes)
            .where(eq(agentRuntimes.daemonId, host.id))
        const [agentCountRow] = await this.db
            .select({ value: count() })
            .from(agents)
            .where(eq(agents.daemonId, host.id))
        return this.hosts.toSummary(
            host,
            runtimes.map((r) => ({
                runtimeId: r.id,
                framework: r.framework as DetectedFramework['framework'],
                name: r.name
            })),
            Number(agentCountRow?.value ?? 0)
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
