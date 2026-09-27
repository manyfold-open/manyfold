import { randomBytes, createHash, randomUUID } from 'node:crypto'
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common'
import { and, eq, isNull, notExists } from 'drizzle-orm'
import { daemonTokens, runtimeHosts, type Database } from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'

const TOKEN_PREFIX = 'ldt_'
const TOKEN_BYTES = 32

// The host a token is bound to is the whole trust boundary (ADR-0037): a
// token minted by the user-facing API has none until its first register
// creates a `local` host; a token provisioning minted for a hosted host is
// bound at mint and can only ever register onto that host.
export interface DaemonAuthContext {
    tokenId: string
    userId: string
    hostId: string | null
}

export interface MintedToken {
    tokenId: string
    plaintext: string
    name: string
    hostId: string | null
    expiresAt: Date | null
    createdAt: Date
}

@Injectable()
export class DaemonTokenService {
    constructor(@Inject(DRIZZLE) private readonly db: Database) {}

    async mint(
        args: {
            userId: string
            name: string
            expiresInDays?: number
            // Provisioning code only: binds the token to the hosted host it
            // is bringing up. A request-driven caller must leave this alone.
            hostId?: string | null
        },
        db: Pick<Database, 'insert'> = this.db
    ): Promise<MintedToken> {
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
        const hostId = args.hostId ?? null

        await db.insert(daemonTokens).values({
            id: tokenId,
            userId: args.userId,
            hostId,
            name: args.name,
            tokenHash,
            expiresAt,
            createdAt: now
        })

        return {
            tokenId,
            plaintext,
            name: args.name,
            hostId,
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
            hostId: row.hostId
        }
    }

    // Drop a token whose register never bound it. Reports whether a row went.
    //
    // `host_id IS NULL` is the whole safety property, not a filter for
    // tidiness: a register can succeed and still look failed to the caller
    // (the exec times out after the API has already bound the token), and
    // this token authenticates EVERY websocket connect the daemon makes, so
    // deleting a bound one bricks a live daemon for the 90 days it would
    // otherwise have. Postgres re-evaluates the predicate against the
    // committed row version after taking the row lock, so a bind that commits
    // mid-delete wins.
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
                    isNull(daemonTokens.hostId)
                )
            )
            .returning({ id: daemonTokens.id })
        return deleted.length > 0
    }

    // Returns the host the token was bound to, so the caller can drop its
    // live connection.
    async revoke(args: {
        tokenId: string
        userId: string
    }): Promise<string | null> {
        const [row] = await this.db
            .update(daemonTokens)
            .set({ revokedAt: new Date() })
            .where(
                and(
                    eq(daemonTokens.id, args.tokenId),
                    eq(daemonTokens.userId, args.userId)
                )
            )
            .returning({ hostId: daemonTokens.hostId })
        return row?.hostId ?? null
    }

    // Every credential a host's daemon could present, revoked together —
    // the retire and delete paths run this inside their own transaction.
    async revokeForHost(
        hostId: string,
        db: Pick<Database, 'update'> = this.db
    ): Promise<number> {
        const rows = await db
            .update(daemonTokens)
            .set({ revokedAt: new Date() })
            .where(
                and(eq(daemonTokens.hostId, hostId), isNull(daemonTokens.revokedAt))
            )
            .returning({ id: daemonTokens.id })
        return rows.length
    }

    // The user's own tokens: the ones they minted, whether or not a local
    // host has claimed them. A token bound to a hosted host is the platform's
    // (minted by provisioning) and is not theirs to see or revoke.
    async listForUser(userId: string) {
        return this.db
            .select()
            .from(daemonTokens)
            .where(
                and(
                    eq(daemonTokens.userId, userId),
                    notExists(
                        this.db
                            .select({ id: runtimeHosts.id })
                            .from(runtimeHosts)
                            .where(
                                and(
                                    eq(runtimeHosts.id, daemonTokens.hostId),
                                    eq(runtimeHosts.kind, 'hosted')
                                )
                            )
                    )
                )
            )
    }
}

export const hashToken = (plaintext: string): string =>
    createHash('sha256').update(plaintext).digest('hex')
