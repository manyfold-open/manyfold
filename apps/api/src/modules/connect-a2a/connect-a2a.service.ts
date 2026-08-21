import { DEFAULT_WEB_BASE_URL } from '@/common/brand'
import {
    A2aExposure,
    ConnectA2aApproveResponse,
    ConnectA2aDenyResponse,
    ConnectA2aPollAgent,
    ConnectA2aPollResponse,
    ConnectA2aSessionResponse,
    ConnectA2aStartResponse,
    apiPaths,
    auditAction,
    createObjectId
} from '@manyfold/shared'
import { randomBytes, randomUUID } from 'node:crypto'
import {
    BadRequestException,
    GoneException,
    Inject,
    Injectable,
    Logger,
    NotFoundException
} from '@nestjs/common'
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { and, eq, gt, inArray, lt } from 'drizzle-orm'
import {
    a2aConnectSessions,
    agents,
    auditLogs,
    users,
    type A2aConnectSession,
    type Database
} from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { configString } from '@/common/config-alias'
import { A2aService } from '../a2a/a2a.service'
import { ApiTokenService } from '../auth/api-token.service'
import { generateUserCode, hashSecret } from '../auth/cli-auth.service'

// Same TTL as CLI logins: the consent link is often opened minutes later.
const SESSION_TTL_MS = 15 * 60_000
// mf_cnx_ is disjoint from the CLI's mf_dvc_ on purpose — together with the
// separate table it makes cross-flow device-code redemption impossible.
const DEVICE_CODE_PREFIX = 'mf_cnx_'
const MAX_AGENTS_PER_APPROVE = 20
const MAX_CLIENT_NAME_LENGTH = 60
const MAX_CLIENT_URL_LENGTH = 200
const CLEANUP_INTERVAL_MS = 60_000
// Measured from expires_at across ALL statuses (same semantics as the CLI
// sweep), so terminal rows including `denied` are reclaimed too.
const CLEANUP_RETENTION_MS = 60 * 60_000
const CLEANUP_STATUSES: Array<A2aConnectSession['status']> = [
    'pending',
    'approved',
    'exchanged',
    'expired',
    'denied'
]

@Injectable()
export class ConnectA2aService implements OnModuleInit, OnModuleDestroy {
    private readonly log = new Logger(ConnectA2aService.name)
    private cleanupTimer: NodeJS.Timeout | null = null

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly config: ConfigService,
        private readonly apiTokens: ApiTokenService,
        private readonly a2a: A2aService
    ) {}

    onModuleInit(): void {
        this.cleanupTimer = setInterval(() => {
            void this.maintenanceTick()
        }, CLEANUP_INTERVAL_MS)
        this.cleanupTimer.unref?.()
        void this.maintenanceTick()
    }

    onModuleDestroy(): void {
        if (this.cleanupTimer) clearInterval(this.cleanupTimer)
    }

    async start(input: {
        clientName: string
        clientUrl?: string
    }): Promise<ConnectA2aStartResponse> {
        const clientName = input.clientName?.trim()
        if (!clientName) throw new BadRequestException('clientName is required')
        if (clientName.length > MAX_CLIENT_NAME_LENGTH)
            throw new BadRequestException(
                `clientName must be at most ${MAX_CLIENT_NAME_LENGTH} characters`
            )
        const clientUrl = input.clientUrl?.trim() || null
        if (clientUrl) {
            if (clientUrl.length > MAX_CLIENT_URL_LENGTH)
                throw new BadRequestException(
                    `clientUrl must be at most ${MAX_CLIENT_URL_LENGTH} characters`
                )
            if (!isHttpsUrl(clientUrl))
                throw new BadRequestException('clientUrl must be an https URL')
        }

        const id = createObjectId('a2aConnectSession')
        const userCode = generateUserCode()
        const deviceCode = `${DEVICE_CODE_PREFIX}${randomBytes(32).toString(
            'base64url'
        )}`
        const expiresAt = new Date(Date.now() + SESSION_TTL_MS)

        await this.db.insert(a2aConnectSessions).values({
            id,
            userCode,
            deviceCodeHash: hashSecret(deviceCode),
            clientName,
            clientUrl,
            expiresAt
        })

        return {
            requestId: id,
            userCode,
            authUrl: buildAuthUrl(this.webUrl(), id, userCode),
            deviceCode,
            expiresAt: expiresAt.toISOString()
        }
    }

    async getSession(args: {
        requestId: string
        userCode: string
    }): Promise<ConnectA2aSessionResponse> {
        const requestId = args.requestId?.trim()
        const userCode = args.userCode?.trim().toUpperCase()
        if (!requestId || !userCode)
            throw new BadRequestException('requestId and userCode are required')

        const [row] = await this.db
            .select()
            .from(a2aConnectSessions)
            .where(
                and(
                    eq(a2aConnectSessions.id, requestId),
                    eq(a2aConnectSessions.userCode, userCode)
                )
            )
            .limit(1)
        if (!row) throw new NotFoundException('connect session not found')

        const now = new Date()
        const status =
            row.status === 'pending' && row.expiresAt < now
                ? 'expired'
                : row.status

        return {
            clientName: row.clientName,
            clientUrl: row.clientUrl,
            status,
            expiresAt: row.expiresAt.toISOString()
        }
    }

    async approve(input: {
        requestId: string
        userCode: string
        userId: string
        agentIds: string[]
        enableExposure: boolean
        expiresInDays?: number
    }): Promise<ConnectA2aApproveResponse> {
        const requestId = input.requestId?.trim()
        if (!requestId) throw new BadRequestException('requestId is required')
        const userCode = input.userCode?.trim().toUpperCase()
        if (!userCode) throw new BadRequestException('userCode is required')

        const agentIds = [
            ...new Set(
                (input.agentIds ?? []).map((id) => id.trim()).filter(Boolean)
            )
        ]
        if (agentIds.length === 0)
            throw new BadRequestException('agentIds must be non-empty')
        if (agentIds.length > MAX_AGENTS_PER_APPROVE)
            throw new BadRequestException(
                `at most ${MAX_AGENTS_PER_APPROVE} agents per approval`
            )

        let expiresInDays: number | null = null
        if (input.expiresInDays !== undefined) {
            if (
                !Number.isInteger(input.expiresInDays) ||
                input.expiresInDays <= 0
            )
                throw new BadRequestException(
                    'expiresInDays must be a positive integer'
                )
            expiresInDays = input.expiresInDays
        }

        const now = new Date()
        const session = await this.find(requestId)
        if (userCode !== session.userCode)
            throw new BadRequestException('user code does not match')
        ensurePending(session)
        await this.ensureNotExpired(session, now)

        return this.db.transaction(async (tx) => {
            const owned = await tx
                .select({ id: agents.id, extras: agents.extras })
                .from(agents)
                .where(
                    and(
                        inArray(agents.id, agentIds),
                        eq(agents.userId, input.userId)
                    )
                )
            if (owned.length !== agentIds.length)
                throw new BadRequestException(
                    'agent not owned by approving user'
                )

            const unexposed = owned.filter(
                (agent) =>
                    !(agent.extras as { a2aExposure?: A2aExposure } | null)
                        ?.a2aExposure?.enabled
            )
            if (input.enableExposure) {
                for (const agent of unexposed)
                    await this.a2a.setExposure(
                        agent.id,
                        { enabled: true },
                        tx
                    )
            } else if (unexposed.length > 0) {
                throw new BadRequestException('agent not exposed')
            }

            const [row] = await tx
                .update(a2aConnectSessions)
                .set({
                    userId: input.userId,
                    approvedAgentIds: agentIds,
                    expiresInDays,
                    status: 'approved',
                    approvedAt: now,
                    updatedAt: now
                })
                .where(
                    and(
                        eq(a2aConnectSessions.id, requestId),
                        eq(a2aConnectSessions.status, 'pending'),
                        eq(a2aConnectSessions.userCode, userCode),
                        gt(a2aConnectSessions.expiresAt, now)
                    )
                )
                .returning()
            if (!row)
                throw new BadRequestException('connect session is not pending')

            await this.writeAuditInTx(tx, {
                actorId: input.userId,
                action: auditAction.A2A_CONNECT_APPROVED,
                subject: requestId,
                meta: {
                    clientName: session.clientName,
                    agentIds,
                    requestId
                }
            })

            return { status: 'approved', agentCount: agentIds.length }
        })
    }

    async poll(
        input: { deviceCode: string },
        apiOrigin: string
    ): Promise<ConnectA2aPollResponse> {
        const deviceCode = input.deviceCode?.trim()
        if (!deviceCode || !deviceCode.startsWith(DEVICE_CODE_PREFIX))
            throw new BadRequestException('invalid deviceCode')

        const hash = hashSecret(deviceCode)
        const now = new Date()

        return this.db.transaction(async (tx) => {
            const [row] = await tx
                .select()
                .from(a2aConnectSessions)
                .where(eq(a2aConnectSessions.deviceCodeHash, hash))
                .limit(1)
            if (!row) throw new NotFoundException('deviceCode not found')

            if (row.expiresAt < now) {
                if (row.status !== 'expired') {
                    await tx
                        .update(a2aConnectSessions)
                        .set({ status: 'expired', updatedAt: now })
                        .where(eq(a2aConnectSessions.id, row.id))
                }
                return { status: 'expired' }
            }

            if (row.status === 'pending') {
                await tx
                    .update(a2aConnectSessions)
                    .set({ polledAt: now })
                    .where(eq(a2aConnectSessions.id, row.id))
                return { status: 'pending' }
            }

            if (row.status === 'denied') return { status: 'denied' }

            if (row.status === 'approved') {
                // Atomic single-consumption: only the poll that flips
                // approved → exchanged mints; every later or concurrent
                // poll sees no matching row and gets `expired`.
                const [claimed] = await tx
                    .update(a2aConnectSessions)
                    .set({
                        status: 'exchanged',
                        exchangedAt: now,
                        updatedAt: now
                    })
                    .where(
                        and(
                            eq(a2aConnectSessions.id, row.id),
                            eq(a2aConnectSessions.status, 'approved')
                        )
                    )
                    .returning()
                if (!claimed) return { status: 'expired' }

                if (!row.userId || !row.approvedAgentIds?.length)
                    throw new BadRequestException(
                        'connect session is incomplete'
                    )

                const minted = await this.apiTokens.mintExternalA2aGrantsInTx(
                    tx,
                    {
                        userId: row.userId,
                        targetAgentIds: row.approvedAgentIds,
                        name: row.clientName,
                        expiresInDays: row.expiresInDays ?? undefined
                    }
                )

                const [userRow] = await tx
                    .select({ email: users.email })
                    .from(users)
                    .where(eq(users.id, row.userId))
                    .limit(1)

                const grantedAgents: ConnectA2aPollAgent[] = minted.map(
                    (grant) => ({
                        agentId: grant.agentId,
                        name: grant.agentName,
                        rpcUrl: `${apiOrigin}/a2a/agents/${grant.agentId}/rpc`,
                        cardUrl: `${apiOrigin}${apiPaths.A2A_AGENT_CARD(grant.agentId)}`,
                        token: grant.plaintext,
                        expiresAt: grant.expiresAt?.toISOString() ?? null
                    })
                )

                return {
                    status: 'approved',
                    userEmail: userRow?.email ?? null,
                    agents: grantedAgents
                }
            }

            return { status: 'expired' }
        })
    }

    async deny(input: {
        requestId: string
        userCode: string
    }): Promise<ConnectA2aDenyResponse> {
        const requestId = input.requestId?.trim()
        if (!requestId) throw new BadRequestException('requestId is required')
        const userCode = input.userCode?.trim().toUpperCase()
        if (!userCode) throw new BadRequestException('userCode is required')

        const now = new Date()
        const session = await this.find(requestId)
        if (userCode !== session.userCode)
            throw new BadRequestException('user code does not match')
        ensurePending(session)
        await this.ensureNotExpired(session, now)

        const [row] = await this.db
            .update(a2aConnectSessions)
            .set({ status: 'denied', updatedAt: now })
            .where(
                and(
                    eq(a2aConnectSessions.id, requestId),
                    eq(a2aConnectSessions.status, 'pending'),
                    eq(a2aConnectSessions.userCode, userCode),
                    gt(a2aConnectSessions.expiresAt, now)
                )
            )
            .returning()
        if (!row)
            throw new BadRequestException('connect session is not pending')

        return { status: 'denied' }
    }

    async cleanupExpiredSessions(now: Date = new Date()): Promise<number> {
        const cutoff = new Date(now.getTime() - CLEANUP_RETENTION_MS)
        const deleted = await this.db
            .delete(a2aConnectSessions)
            .where(
                and(
                    inArray(a2aConnectSessions.status, CLEANUP_STATUSES),
                    lt(a2aConnectSessions.expiresAt, cutoff)
                )
            )
            .returning({ id: a2aConnectSessions.id })
        return deleted.length
    }

    private async find(id: string): Promise<A2aConnectSession> {
        const [row] = await this.db
            .select()
            .from(a2aConnectSessions)
            .where(eq(a2aConnectSessions.id, id))
            .limit(1)
        if (!row) throw new NotFoundException('connect session not found')
        return row
    }

    private async ensureNotExpired(
        row: A2aConnectSession,
        now: Date
    ): Promise<void> {
        if (row.expiresAt > now) return
        await this.db
            .update(a2aConnectSessions)
            .set({ status: 'expired', updatedAt: now })
            .where(eq(a2aConnectSessions.id, row.id))
        throw new GoneException('connect session expired')
    }

    private async writeAuditInTx(
        tx: Pick<Database, 'insert'>,
        entry: {
            actorId: string
            action: string
            subject: string
            meta: Record<string, unknown>
        }
    ): Promise<void> {
        try {
            await tx.insert(auditLogs).values({
                id: randomUUID(),
                actorId: entry.actorId,
                action: entry.action,
                subject: entry.subject,
                meta: entry.meta
            })
        } catch (error) {
            this.log.warn(
                `failed to write audit_logs for ${entry.action}/${entry.subject}: ${(error as Error).message}`
            )
        }
    }

    private webUrl(): string {
        return (
            configString(this.config, [
                'MF_WEB_URL',
                'NCA_WEB_URL',
                'WEB_BASE_URL'
            ]) ?? DEFAULT_WEB_BASE_URL
        ).replace(/\/+$/, '')
    }

    // The shared CliAuthRateLimitService buckets are already swept by
    // CliAuthService's tick; this one only reclaims connect sessions.
    private async maintenanceTick(): Promise<void> {
        try {
            const deleted = await this.cleanupExpiredSessions()
            if (deleted > 0)
                this.log.log(
                    `a2a connect cleanup deleted ${deleted} session(s)`
                )
        } catch (err) {
            if (isUndefinedTableError(err)) {
                this.log.warn(
                    'a2a connect sessions table is missing; skipping cleanup until migrations run'
                )
                return
            }
            this.log.warn(
                `a2a connect cleanup failed: ${(err as Error).message}`
            )
        }
    }
}

const ensurePending = (row: A2aConnectSession): void => {
    if (row.status !== 'pending')
        throw new BadRequestException('connect session is not pending')
}

const isHttpsUrl = (value: string): boolean => {
    try {
        return new URL(value).protocol === 'https:'
    } catch {
        return false
    }
}

const buildAuthUrl = (
    webUrl: string,
    requestId: string,
    userCode: string
): string => {
    const url = new URL('/connect/a2a', webUrl)
    url.searchParams.set('request', requestId)
    url.searchParams.set('code', userCode)
    return url.toString()
}

const isUndefinedTableError = (err: unknown): boolean =>
    (err as { code?: string } | null)?.code === '42P01'
