import { createObjectId } from '@manyfold/shared'
import { createHash, randomBytes } from 'node:crypto'
import { ForbiddenException, Inject, Injectable, Logger } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { and, eq, isNotNull, isNull, lt, ne, or } from 'drizzle-orm'
import { userSessions, users, type Database } from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import type { AuthPrincipal } from './auth-principal'

const SESSION_TOKEN_PREFIX = 'mfs_'
const SESSION_TOKEN_BYTES = 32
const DEFAULT_SESSION_TTL_DAYS = 30

export type SessionProvider = 'email' | 'google' | 'oidc' | 'netmind'

// Session tokens never start with `nca_`, so isApiToken() stays false and the
// bearer chokepoint routes them here; the OpenAI /v1 surface (which only accepts
// `nca_`) rejects them by construction.
export const isSessionToken = (value: string): boolean =>
    value.startsWith(SESSION_TOKEN_PREFIX)

export const hashSessionToken = (plaintext: string): string =>
    createHash('sha256').update(plaintext).digest('hex')

@Injectable()
export class SessionService {
    private readonly log = new Logger(SessionService.name)

    constructor(@Inject(DRIZZLE) private readonly db: Database) {}

    async mint(args: {
        userId: string
        provider: SessionProvider
        subject: string
        userAgent?: string | null
        ip?: string | null
        ttlDays?: number
    }): Promise<{ token: string; expiresAt: Date }> {
        // ADR-0023: one chokepoint blocks sign-in on every provider — a
        // deletion-pending account mints no new sessions until restored.
        const [owner] = await this.db
            .select({ deactivatedAt: users.deactivatedAt })
            .from(users)
            .where(eq(users.id, args.userId))
            .limit(1)
        if (owner?.deactivatedAt)
            throw new ForbiddenException({
                code: 'ACCOUNT_DEACTIVATED',
                message: 'this account is scheduled for deletion'
            })
        const plaintext = `${SESSION_TOKEN_PREFIX}${randomBytes(
            SESSION_TOKEN_BYTES
        ).toString('base64url')}`
        const ttlDays =
            args.ttlDays && args.ttlDays > 0
                ? args.ttlDays
                : DEFAULT_SESSION_TTL_DAYS
        const now = new Date()
        const expiresAt = new Date(now.getTime() + ttlDays * 86_400_000)
        await this.db.insert(userSessions).values({
            id: createObjectId('userSession'),
            userId: args.userId,
            tokenHash: hashSessionToken(plaintext),
            provider: args.provider,
            subject: args.subject,
            userAgent: args.userAgent ?? null,
            ip: args.ip ?? null,
            expiresAt
        })
        return { token: plaintext, expiresAt }
    }

    async verify(plaintext: string): Promise<AuthPrincipal | null> {
        if (!isSessionToken(plaintext)) return null
        const hash = hashSessionToken(plaintext)
        const [row] = await this.db
            .select({
                id: userSessions.id,
                userId: userSessions.userId,
                provider: userSessions.provider,
                subject: userSessions.subject,
                expiresAt: userSessions.expiresAt,
                revokedAt: userSessions.revokedAt,
                createdAt: userSessions.createdAt,
                email: users.email,
                deactivatedAt: users.deactivatedAt
            })
            .from(userSessions)
            .innerJoin(users, eq(userSessions.userId, users.id))
            .where(eq(userSessions.tokenHash, hash))
            .limit(1)
        if (!row || row.revokedAt) return null
        // ADR-0023: deletion-pending accounts hold no live sessions.
        if (row.deactivatedAt) return null
        const now = new Date()
        if (row.expiresAt <= now) return null
        // Sliding renewal: every authenticated request pushes the TTL window
        // forward, so an actively-used session never trips the absolute expiry
        // and forces a surprise re-login. Folded into the existing lastUsedAt
        // write — no extra query. Expired/revoked sessions already returned
        // above, so a dead token can never be resurrected here.
        const expiresAt = new Date(
            now.getTime() + DEFAULT_SESSION_TTL_DAYS * 86_400_000
        )
        await this.db
            .update(userSessions)
            .set({ lastUsedAt: now, expiresAt })
            .where(eq(userSessions.id, row.id))
        return {
            userId: row.userId,
            email: row.email,
            kind: 'human-session',
            provider: row.provider,
            subject: row.subject,
            sessionId: row.id,
            sessionCreatedAt: row.createdAt
        }
    }

    async revoke(plaintext: string): Promise<void> {
        if (!isSessionToken(plaintext)) return
        await this.db
            .update(userSessions)
            .set({ revokedAt: new Date() })
            .where(
                and(
                    eq(userSessions.tokenHash, hashSessionToken(plaintext)),
                    isNull(userSessions.revokedAt)
                )
            )
    }

    // `exceptSessionId` spares the caller's own session: password set/change
    // evicts every other session without logging the owner out mid-request.
    async revokeAllForUser(
        userId: string,
        opts?: { exceptSessionId?: string }
    ): Promise<void> {
        await this.db
            .update(userSessions)
            .set({ revokedAt: new Date() })
            .where(
                and(
                    eq(userSessions.userId, userId),
                    isNull(userSessions.revokedAt),
                    opts?.exceptSessionId
                        ? ne(userSessions.id, opts.exceptSessionId)
                        : undefined
                )
            )
    }

    // Drop long-dead rows (expired or revoked over a day ago). Live sessions are
    // never touched; the day of slack keeps a just-expired token resolvable as a
    // clean 401 rather than vanishing.
    @Cron(CronExpression.EVERY_HOUR, { name: 'user-session-reaper' })
    async reapExpired(): Promise<void> {
        const cutoff = new Date(Date.now() - 86_400_000)
        const deleted = await this.db
            .delete(userSessions)
            .where(
                or(
                    lt(userSessions.expiresAt, cutoff),
                    and(
                        isNotNull(userSessions.revokedAt),
                        lt(userSessions.revokedAt, cutoff)
                    )
                )
            )
            .returning({ id: userSessions.id })
        if (deleted.length > 0)
            this.log.log(`reaped ${deleted.length} expired session(s)`)
    }
}
