import { randomBytes, createHash, randomUUID } from 'node:crypto'
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common'
import { and, eq, isNull, notExists } from 'drizzle-orm'
import {
    daemonTokens,
    runtimeHosts,
    type DaemonToken,
    type Database
} from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'

const TOKEN_PREFIX = 'ldt_'
const TOKEN_BYTES = 32

// The column's own union, so the trust boundary has exactly one spelling.
export type DaemonTokenPurpose = DaemonToken['purpose']

export interface DaemonAuthContext {
    tokenId: string
    userId: string
    daemonId: string | null
    // Server-side claim from the token row. The only input to the register
    // path that the daemon presenting the token cannot influence.
    purpose: DaemonTokenPurpose
}

export interface MintedToken {
    tokenId: string
    plaintext: string
    name: string
    expiresAt: Date | null
    createdAt: Date
}

@Injectable()
export class DaemonTokenService {
    constructor(@Inject(DRIZZLE) private readonly db: Database) {}

    async mint(args: {
        userId: string
        name: string
        expiresInDays?: number
        // Callers that take the name from a request must leave this alone.
        purpose?: DaemonTokenPurpose
    }): Promise<MintedToken> {
        const raw = randomBytes(TOKEN_BYTES)
            .toString('base64')
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '')
        const plaintext = `${TOKEN_PREFIX}${raw}`
        const tokenHash = hashToken(plaintext)
        const tokenId = `ldt_${randomUUID()}`
        const now = new Date()
        const expiresAt = args.expiresInDays
            ? new Date(now.getTime() + args.expiresInDays * 86_400_000)
            : null

        await this.db.insert(daemonTokens).values({
            id: tokenId,
            userId: args.userId,
            daemonId: null,
            name: args.name,
            purpose: args.purpose ?? 'user',
            tokenHash,
            expiresAt,
            createdAt: now
        })

        return {
            tokenId,
            plaintext,
            name: args.name,
            expiresAt,
            createdAt: now
        }
    }

    async verify(plaintext: string): Promise<DaemonAuthContext> {
        if (!plaintext.startsWith(TOKEN_PREFIX))
            throw new UnauthorizedException('invalid token prefix')
        const tokenHash = hashToken(plaintext)
        const [row] = await this.db
            .select()
            .from(daemonTokens)
            .where(eq(daemonTokens.tokenHash, tokenHash))
            .limit(1)
        if (!row) throw new UnauthorizedException('token not found')
        if (row.revokedAt) throw new UnauthorizedException('token revoked')
        if (row.expiresAt && row.expiresAt < new Date())
            throw new UnauthorizedException('token expired')

        await this.db
            .update(daemonTokens)
            .set({ lastUsedAt: new Date() })
            .where(eq(daemonTokens.id, row.id))

        return {
            tokenId: row.id,
            userId: row.userId,
            daemonId: row.daemonId,
            purpose: row.purpose
        }
    }

    // Drop a token whose register never bound it. Reports whether a row went.
    //
    // `daemon_id IS NULL` is the whole safety property, not a filter for
    // tidiness: a register can succeed and still look failed to the caller (the
    // exec times out after the API has already bound the token), and this token
    // authenticates EVERY websocket connect the runner makes, so deleting a
    // bound one bricks a live runner for the 90 days it would otherwise have.
    // Postgres re-evaluates the predicate against the committed row version
    // after taking the row lock, so a bind that commits mid-delete wins.
    async deleteUnbound(args: {
        tokenId: string
        userId: string
    }): Promise<boolean> {
        const deleted = await this.db
            .delete(daemonTokens)
            .where(
                and(
                    eq(daemonTokens.id, args.tokenId),
                    eq(daemonTokens.userId, args.userId),
                    isNull(daemonTokens.daemonId)
                )
            )
            .returning({ id: daemonTokens.id })
        return deleted.length > 0
    }

    async revoke(args: {
        tokenId: string
        userId: string
    }): Promise<string | null> {
        const [row] = await this.db
            .select()
            .from(daemonTokens)
            .where(
                and(
                    eq(daemonTokens.id, args.tokenId),
                    eq(daemonTokens.userId, args.userId)
                )
            )
            .limit(1)
        await this.db
            .update(daemonTokens)
            .set({ revokedAt: new Date() })
            .where(
                and(
                    eq(daemonTokens.id, args.tokenId),
                    eq(daemonTokens.userId, args.userId)
                )
            )
        return row?.daemonId ?? null
    }

    async listForUser(userId: string) {
        return this.db
            .select()
            .from(daemonTokens)
            .where(
                and(
                    eq(daemonTokens.userId, userId),
                    eq(daemonTokens.purpose, 'user'),
                    notExists(
                        this.db
                            .select({ id: runtimeHosts.id })
                            .from(runtimeHosts)
                            .where(
                                and(
                                    eq(runtimeHosts.id, daemonTokens.daemonId),
                                    eq(runtimeHosts.managed, true)
                                )
                            )
                    )
                )
            )
    }
}

export const hashToken = (plaintext: string): string =>
    createHash('sha256').update(plaintext).digest('hex')
