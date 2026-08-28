import { DEFAULT_WEB_BASE_URL } from '@/common/brand'
import {
    CliLoginApproveResponse,
    CliLoginExchangeResponse,
    CliLoginPollResponse,
    CliLoginSessionResponse,
    CliLoginStartResponse
} from '@manyfold/shared'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
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
import { and, eq, gt, inArray, isNotNull, lt } from 'drizzle-orm'
import {
    agents,
    cliAuthSessions,
    type CliAuthSession,
    type Database
} from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { configString } from '@/common/config-alias'
import { API_TOKEN_SCOPE_FULL, ApiTokenService } from './api-token.service'
import { CliAuthRateLimitService } from './cli-auth-rate-limit.service'

// Chat-delivered consent links are often opened minutes later; resumable
// poll-mode logins (mf login --resume) stay redeemable for this window.
const LOGIN_TTL_MS = 15 * 60_000
const CLI_TOKEN_EXPIRES_DAYS = 90
const AUTH_CODE_PREFIX = 'mf_auth_'
const USER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const CLEANUP_INTERVAL_MS = 60_000
const CLEANUP_RETENTION_MS = 60 * 60_000
const CLEANUP_STATUSES: Array<CliAuthSession['status']> = [
    'pending',
    'approved',
    'exchanged',
    'expired'
]

type CliAuthStore = Pick<Database, 'select' | 'update'>

@Injectable()
export class CliAuthService implements OnModuleInit, OnModuleDestroy {
    private readonly log = new Logger(CliAuthService.name)
    private cleanupTimer: NodeJS.Timeout | null = null

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly config: ConfigService,
        private readonly apiTokens: ApiTokenService,
        private readonly rateLimit: CliAuthRateLimitService
    ) {}

    onModuleInit(): void {
        this.cleanupTimer = setInterval(() => {
            void this.maintenanceTick()
        }, this.cleanupIntervalMs())
        this.cleanupTimer.unref?.()
        void this.maintenanceTick()
    }

    onModuleDestroy(): void {
        if (this.cleanupTimer) clearInterval(this.cleanupTimer)
    }

    async start(input: {
        redirectUri?: string
        requestedScopes?: string[]
        requestedAgentId?: string
    }): Promise<CliLoginStartResponse> {
        // The device-code grant flow is retired: only pre-removal CLI
        // binaries still send these fields, and the actionable refusal here
        // is what stops new unbound grants from being minted (Phase 8).
        if (input.requestedScopes || input.requestedAgentId)
            throw new GoneException(
                'the device-code grant flow (mf login --poll) is retired; ' +
                    'run `mf update`, then `mf auth ensure --scopes <list>`'
            )
        const redirectUri = input.redirectUri?.trim() || null
        if (redirectUri && !isLoopbackRedirectUri(redirectUri))
            throw new BadRequestException('redirectUri must be a loopback URL')

        const id = `cli_${randomUUID()}`
        const userCode = generateUserCode()
        const expiresAt = new Date(Date.now() + LOGIN_TTL_MS)
        const authUrl = buildAuthUrl(this.webUrl(), id, userCode)

        await this.db.insert(cliAuthSessions).values({
            id,
            userCode,
            redirectUri,
            expiresAt
        })

        return {
            requestId: id,
            userCode,
            authUrl,
            expiresAt: expiresAt.toISOString()
        }
    }

    async approve(input: {
        requestId: string
        userCode?: string
        userId: string
        approvedScopes?: string[]
    }): Promise<CliLoginApproveResponse> {
        const requestId = input.requestId?.trim()
        if (!requestId) throw new BadRequestException('requestId is required')
        const userCode = input.userCode?.trim().toUpperCase()
        const now = new Date()

        const session = await this.find(requestId)
        if (userCode && userCode !== session.userCode)
            throw new BadRequestException('user code does not match')
        ensurePending(session)
        await this.ensureNotExpired(session, this.db, now)

        // A grant-mode session can only come from a pre-retirement deploy
        // (they live 15 minutes); approving it as a browser login would mint
        // the wrong credential, so refuse with the fix in hand.
        if (session.requestedScopes != null)
            throw new GoneException(
                'the device-code grant flow (mf login --poll) is retired; ' +
                    'run `mf update`, then `mf auth ensure --scopes <list>`'
            )
        return this.approveBrowser({ session, input, userCode, now })
    }

    private async approveBrowser(args: {
        session: CliAuthSession
        input: { requestId: string; userId: string }
        userCode: string | undefined
        now: Date
    }): Promise<CliLoginApproveResponse> {
        const { input, userCode, now } = args
        const authCode = `${AUTH_CODE_PREFIX}${randomBytes(32).toString(
            'base64url'
        )}`
        const [row] = await this.db
            .update(cliAuthSessions)
            .set({
                userId: input.userId,
                authCodeHash: hashSecret(authCode),
                status: 'approved',
                approvedAt: now,
                updatedAt: now
            })
            .where(
                pendingLoginRequestWhere({
                    requestId: input.requestId,
                    userCode,
                    now
                })
            )
            .returning()
        if (!row) await this.rejectApproveConflict(input.requestId, userCode)

        return {
            authCode,
            redirectUrl: row.redirectUri
                ? appendAuthCode(row.redirectUri, authCode, row.id)
                : null,
            expiresAt: row.expiresAt.toISOString(),
            mode: 'browser'
        }
    }

    async exchange(authCode: string): Promise<CliLoginExchangeResponse> {
        const code = authCode.trim()
        if (!code.startsWith(AUTH_CODE_PREFIX))
            throw new BadRequestException('invalid auth code')

        const codeHash = hashSecret(code)
        return this.db.transaction(async (tx) => {
            const now = new Date()
            const [row] = await tx
                .update(cliAuthSessions)
                .set({
                    status: 'exchanged',
                    exchangedAt: now,
                    updatedAt: now
                })
                .where(
                    and(
                        eq(cliAuthSessions.authCodeHash, codeHash),
                        eq(cliAuthSessions.status, 'approved'),
                        isNotNull(cliAuthSessions.userId),
                        gt(cliAuthSessions.expiresAt, now)
                    )
                )
                .returning()
            if (!row) await this.rejectExchangeConflict(tx, codeHash, now)
            // Only a pre-retirement deploy could have written this (grant
            // sessions are no longer creatable and live 15 minutes).
            if (row.requestedScopes != null)
                throw new GoneException(
                    'the device-code grant flow (mf login --poll) is retired; ' +
                        'run `mf update`, then `mf auth ensure --scopes <list>`'
                )
            if (!row.userId)
                throw new BadRequestException('auth code already used')

            const minted = await this.apiTokens.mint(
                {
                    userId: row.userId,
                    name: `mf CLI ${now.toISOString().slice(0, 10)}`,
                    scopes: [API_TOKEN_SCOPE_FULL],
                    expiresInDays: CLI_TOKEN_EXPIRES_DAYS
                },
                tx
            )
            await tx
                .update(cliAuthSessions)
                .set({
                    tokenId: minted.tokenId,
                    updatedAt: new Date()
                })
                .where(eq(cliAuthSessions.id, row.id))

            return {
                token: minted.plaintext,
                expiresAt: minted.expiresAt?.toISOString() ?? null
            }
        })
    }

    // Tombstone for the retired device-code grant flow: pre-removal CLI
    // binaries poll this in a loop, so the refusal must carry the fix
    // instead of reading like an outage.
    async poll(input: { deviceCode: string }): Promise<CliLoginPollResponse> {
        void input
        throw new GoneException(
            'the device-code grant flow (mf login --poll) is retired; ' +
                'run `mf update`, then `mf auth ensure --scopes <list>`'
        )
    }

    async getSession(args: {
        requestId: string
        userCode: string
    }): Promise<CliLoginSessionResponse> {
        const requestId = args.requestId?.trim()
        const userCode = args.userCode?.trim().toUpperCase()
        if (!requestId || !userCode)
            throw new BadRequestException('requestId and userCode are required')

        const [row] = await this.db
            .select()
            .from(cliAuthSessions)
            .where(
                and(
                    eq(cliAuthSessions.id, requestId),
                    eq(cliAuthSessions.userCode, userCode)
                )
            )
            .limit(1)
        if (!row) throw new NotFoundException('login request not found')

        const requestedScopes = (row.requestedScopes as string[] | null) ?? null
        let requestedAgent: { id: string; name: string } | null = null
        if (row.requestedAgentId) {
            const [agent] = await this.db
                .select({ id: agents.id, name: agents.name })
                .from(agents)
                .where(eq(agents.id, row.requestedAgentId))
                .limit(1)
            requestedAgent = agent ?? null
        }

        const now = new Date()
        const status =
            row.status === 'pending' && row.expiresAt < now
                ? 'expired'
                : row.status

        return {
            requestId: row.id,
            status,
            expiresAt: row.expiresAt.toISOString(),
            isGrantMode: requestedScopes !== null,
            requestedScopes,
            requestedAgent,
            hasRedirect: row.redirectUri !== null
        }
    }

    async cleanupExpiredSessions(now: Date = new Date()): Promise<number> {
        const cutoff = new Date(now.getTime() - this.cleanupRetentionMs())
        const deleted = await this.db
            .delete(cliAuthSessions)
            .where(
                and(
                    inArray(cliAuthSessions.status, CLEANUP_STATUSES),
                    lt(cliAuthSessions.expiresAt, cutoff)
                )
            )
            .returning({ id: cliAuthSessions.id })
        return deleted.length
    }

    private async find(id: string): Promise<CliAuthSession> {
        if (!id?.trim()) throw new BadRequestException('requestId is required')
        const [row] = await this.db
            .select()
            .from(cliAuthSessions)
            .where(eq(cliAuthSessions.id, id.trim()))
            .limit(1)
        if (!row) throw new NotFoundException('login request not found')
        return row
    }

    private async ensureNotExpired(
        row: CliAuthSession,
        db: CliAuthStore = this.db,
        now: Date = new Date()
    ): Promise<void> {
        if (row.expiresAt > now) return
        await db
            .update(cliAuthSessions)
            .set({ status: 'expired', updatedAt: now })
            .where(eq(cliAuthSessions.id, row.id))
        throw new GoneException('login request expired')
    }

    private async rejectApproveConflict(
        requestId: string,
        userCode: string | undefined
    ): Promise<never> {
        const row = await this.find(requestId)
        ensurePending(row)
        await this.ensureNotExpired(row)
        if (userCode && userCode !== row.userCode)
            throw new BadRequestException('user code does not match')
        throw new BadRequestException('login request is not pending')
    }

    private async rejectExchangeConflict(
        db: CliAuthStore,
        codeHash: string,
        now: Date
    ): Promise<never> {
        const [row] = await db
            .select()
            .from(cliAuthSessions)
            .where(eq(cliAuthSessions.authCodeHash, codeHash))
            .limit(1)

        if (!row) throw new NotFoundException('auth code not found')
        if (row.status !== 'approved' || !row.userId)
            throw new BadRequestException('auth code already used')
        await this.ensureNotExpired(row, db, now)
        throw new BadRequestException('auth code already used')
    }

    private webUrl(): string {
        return trimTrailingSlash(
            configString(this.config, [
                'MF_WEB_URL',
                'NCA_WEB_URL',
                'WEB_BASE_URL'
            ]) ?? DEFAULT_WEB_BASE_URL
        )
    }

    private cleanupIntervalMs(): number {
        return configDurationMs(
            this.config,
            'CLI_AUTH_CLEANUP_INTERVAL_MS',
            CLEANUP_INTERVAL_MS,
            15_000
        )
    }

    private cleanupRetentionMs(): number {
        return configDurationMs(
            this.config,
            'CLI_AUTH_SESSION_RETENTION_MS',
            CLEANUP_RETENTION_MS,
            LOGIN_TTL_MS
        )
    }

    private async maintenanceTick(): Promise<void> {
        this.rateLimit.sweep()
        if (this.config.get<string>('CLI_AUTH_CLEANUP_ENABLED') === 'false')
            return
        try {
            const deleted = await this.cleanupExpiredSessions()
            if (deleted > 0)
                this.log.log(`cli auth cleanup deleted ${deleted} session(s)`)
        } catch (err) {
            if (isUndefinedTableError(err)) {
                this.log.warn(
                    'cli auth sessions table is missing; skipping cleanup until migrations run'
                )
                return
            }
            this.log.warn(`cli auth cleanup failed: ${(err as Error).message}`)
        }
    }
}

export const isLoopbackRedirectUri = (value: string): boolean => {
    try {
        const url = new URL(value)
        if (url.protocol !== 'http:') return false
        if (url.username || url.password || url.hash) return false
        if (!url.port) return false
        return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)
    } catch {
        return false
    }
}

export const hashSecret = (secret: string): string =>
    createHash('sha256').update(secret).digest('hex')


const ensurePending = (row: CliAuthSession): void => {
    if (row.status !== 'pending')
        throw new BadRequestException('login request is not pending')
}

const pendingLoginRequestWhere = (input: {
    requestId: string
    userCode?: string
    now: Date
}) => {
    const base = and(
        eq(cliAuthSessions.id, input.requestId),
        eq(cliAuthSessions.status, 'pending'),
        gt(cliAuthSessions.expiresAt, input.now)
    )
    if (!input.userCode) return base
    return and(base, eq(cliAuthSessions.userCode, input.userCode))
}

const buildAuthUrl = (
    webUrl: string,
    requestId: string,
    userCode: string
): string => {
    const url = new URL('/cli-login', webUrl)
    url.searchParams.set('request', requestId)
    url.searchParams.set('code', userCode)
    return url.toString()
}

const appendAuthCode = (
    redirectUri: string,
    authCode: string,
    requestId: string
): string => {
    const url = new URL(redirectUri)
    url.searchParams.set('code', authCode)
    url.searchParams.set('request_id', requestId)
    return url.toString()
}

export const generateUserCode = (): string => {
    const bytes = randomBytes(8)
    const chars = [...bytes].map(
        (byte) => USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length]
    )
    return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`
}

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, '')

const isUndefinedTableError = (err: unknown): boolean =>
    (err as { code?: string } | null)?.code === '42P01'

const configDurationMs = (
    config: ConfigService,
    key: string,
    fallback: number,
    min: number
): number => {
    const raw = config.get<string>(key)
    if (raw === undefined) return fallback
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? Math.max(min, parsed) : fallback
}
