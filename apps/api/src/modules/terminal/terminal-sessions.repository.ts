import { Inject, Injectable } from '@nestjs/common'
import { and, asc, eq, inArray, isNull, lt, sql } from 'drizzle-orm'
import {
    agents,
    terminalSessions,
    type Database,
    type TerminalSessionRow
} from '@manyfold/db'
import { createObjectId, type TerminalClient } from '@manyfold/shared'
import { DRIZZLE } from '@/db/tokens'

// The tunnel that owns a terminal renews its lease every minute; the reaper
// reclaims a terminal whose lease is five minutes stale. The TTL is at least
// three renewal intervals so a slow API instance never loses a live terminal
// to the reaper (ADR-0029 §1).
export const TERMINAL_LEASE_TTL_SECONDS = 300
export const TERMINAL_LEASE_RENEW_MS = 60_000

export type TerminalEndReason = NonNullable<TerminalSessionRow['endedReason']>

const leaseFromNow = sql`now() + make_interval(secs => ${TERMINAL_LEASE_TTL_SECONDS})`

@Injectable()
export class TerminalSessionsRepository {
    constructor(@Inject(DRIZZLE) private readonly db: Database) {}

    async create(input: {
        userId: string
        agentId: string
        runtime: 'sprites' | 'daemon'
        hostId: string | null
        runtimeId: string | null
        // Absent, the browser terminal; `herdr` for a pane on the agent's
        // machine (ADR-0031).
        client?: TerminalClient
    }): Promise<TerminalSessionRow> {
        const [row] = await this.db
            .insert(terminalSessions)
            .values({
                id: createObjectId('terminalSession'),
                ...input,
                leaseExpiresAt: leaseFromNow
            })
            .returning()
        return row
    }

    async bindToken(id: string, tokenId: string): Promise<void> {
        await this.db
            .update(terminalSessions)
            .set({ tokenId })
            .where(eq(terminalSessions.id, id))
    }

    async setHandle(id: string, processHandle: string): Promise<void> {
        await this.db
            .update(terminalSessions)
            .set({ processHandle })
            .where(eq(terminalSessions.id, id))
    }

    async markHeld(id: string, sessionId: string): Promise<void> {
        await this.db
            .update(terminalSessions)
            .set({ heldSessionId: sessionId })
            .where(eq(terminalSessions.id, id))
    }

    // Renewed by primary key on the database clock, never touching
    // updated_at-style columns. Zero rows means the row was ended under the
    // tunnel (superseded or reclaimed): the tunnel must stop, not keep writing.
    async renewLease(id: string): Promise<boolean> {
        const rows = await this.db
            .update(terminalSessions)
            .set({ leaseExpiresAt: leaseFromNow })
            .where(
                and(
                    eq(terminalSessions.id, id),
                    isNull(terminalSessions.endedAt)
                )
            )
            .returning({ id: terminalSessions.id })
        return rows.length > 0
    }

    // Compare-and-set on the live row so that of two instances trying to end
    // the same terminal (its own tunnel closing, a takeover, the reaper)
    // exactly one proceeds to kill and release.
    async end(
        id: string,
        reason: TerminalEndReason
    ): Promise<TerminalSessionRow | null> {
        const [row] = await this.db
            .update(terminalSessions)
            .set({ endedAt: new Date(), endedReason: reason })
            .where(
                and(
                    eq(terminalSessions.id, id),
                    isNull(terminalSessions.endedAt)
                )
            )
            .returning()
        return row ?? null
    }

    // The terminal a CLI hook reports from is whichever live one the token
    // that authenticated the report was minted for (ADR-0029 §3): the body
    // and the shell's env are never trusted for it. The token is hard-deleted
    // when the terminal closes, so a late report finds nothing.
    async findLiveByTokenId(
        tokenId: string
    ): Promise<TerminalSessionRow | null> {
        const [row] = await this.db
            .select()
            .from(terminalSessions)
            .where(
                and(
                    eq(terminalSessions.tokenId, tokenId),
                    isNull(terminalSessions.endedAt)
                )
            )
            .limit(1)
        return row ?? null
    }

    // Renewal on the daemon's word (ADR-0029 §6): the live rows a daemon's
    // inventory named, in one statement.
    async renewLeases(ids: string[]): Promise<number> {
        if (ids.length === 0) return 0
        const rows = await this.db
            .update(terminalSessions)
            .set({ leaseExpiresAt: leaseFromNow })
            .where(
                and(
                    inArray(terminalSessions.id, ids),
                    isNull(terminalSessions.endedAt)
                )
            )
            .returning({ id: terminalSessions.id })
        return rows.length
    }

    // The live terminals a daemon owns: daemon-arm rows addressed by their
    // own id (the handle an owned terminal gets at creation), reached through
    // the agent's current daemon.
    async listLiveOwnedByDaemon(
        daemonId: string
    ): Promise<TerminalSessionRow[]> {
        const rows = await this.db
            .select({ row: terminalSessions })
            .from(terminalSessions)
            .innerJoin(agents, eq(agents.id, terminalSessions.agentId))
            .where(
                and(
                    eq(agents.daemonId, daemonId),
                    eq(terminalSessions.runtime, 'daemon'),
                    isNull(terminalSessions.endedAt),
                    eq(terminalSessions.processHandle, terminalSessions.id)
                )
            )
        return rows.map((r) => r.row)
    }

    async findById(id: string): Promise<TerminalSessionRow | null> {
        const [row] = await this.db
            .select()
            .from(terminalSessions)
            .where(eq(terminalSessions.id, id))
            .limit(1)
        return row ?? null
    }

    // Ended rows are history the audit log already keeps; only the latest
    // holder of a session is ever read back (for the import's identity
    // check), so rows past the retention window are pruned in bounded
    // batches.
    async deleteEndedBefore(cutoff: Date, limit: number): Promise<number> {
        const rows = await this.db
            .delete(terminalSessions)
            .where(
                inArray(
                    terminalSessions.id,
                    this.db
                        .select({ id: terminalSessions.id })
                        .from(terminalSessions)
                        .where(lt(terminalSessions.endedAt, cutoff))
                        .orderBy(asc(terminalSessions.endedAt))
                        .limit(limit)
                )
            )
            .returning({ id: terminalSessions.id })
        return rows.length
    }

    async listExpiredLive(limit: number): Promise<TerminalSessionRow[]> {
        return this.db
            .select()
            .from(terminalSessions)
            .where(
                and(
                    isNull(terminalSessions.endedAt),
                    lt(terminalSessions.leaseExpiresAt, sql`now()`)
                )
            )
            .orderBy(asc(terminalSessions.leaseExpiresAt))
            .limit(limit)
    }
}
