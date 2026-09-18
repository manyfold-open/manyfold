import { Inject, Injectable } from '@nestjs/common'
import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import {
    terminalSessionRefs,
    type Database,
    type TerminalSessionRefRow
} from '@manyfold/db'
import { createObjectId } from '@manyfold/shared'
import { DRIZZLE } from '@/db/tokens'

export type TerminalRefSettledOutcome = NonNullable<
    TerminalSessionRefRow['settledOutcome']
>

// The framework sessions a terminal's CLI hooks reported (ADR-0029 §3): one
// row per (terminal, ref), bound to a chat session when the API knows which
// one it is, unbound until the terminal's end turns it into one.
@Injectable()
export class TerminalSessionRefsRepository {
    constructor(@Inject(DRIZZLE) private readonly db: Database) {}

    // A repeated start for the same ref (a compaction that kept the id, a
    // resume of a session this terminal started) refreshes the event, keeps
    // the first source, and never unbinds a session already bound.
    async recordStart(input: {
        terminalId: string
        framework: string
        sessionRef: string
        source: string
        cwd: string | null
        chatSessionId: string | null
    }): Promise<TerminalSessionRefRow> {
        const now = new Date()
        const [row] = await this.db
            .insert(terminalSessionRefs)
            .values({
                id: createObjectId('terminalSessionRef'),
                terminalId: input.terminalId,
                framework: input.framework,
                sessionRef: input.sessionRef,
                source: input.source,
                cwd: input.cwd,
                chatSessionId: input.chatSessionId,
                firstSeenAt: now,
                lastEvent: 'start',
                lastEventAt: now
            })
            .onConflictDoUpdate({
                target: [
                    terminalSessionRefs.terminalId,
                    terminalSessionRefs.sessionRef
                ],
                set: {
                    lastEvent: 'start',
                    lastEventAt: now,
                    chatSessionId: sql`coalesce(${terminalSessionRefs.chatSessionId}, ${input.chatSessionId})`
                }
            })
            .returning()
        return row
    }

    async recordEnd(terminalId: string, sessionRef: string): Promise<boolean> {
        const rows = await this.db
            .update(terminalSessionRefs)
            .set({ lastEvent: 'end', lastEventAt: new Date() })
            .where(
                and(
                    eq(terminalSessionRefs.terminalId, terminalId),
                    eq(terminalSessionRefs.sessionRef, sessionRef)
                )
            )
            .returning({ id: terminalSessionRefs.id })
        return rows.length > 0
    }

    async bind(
        terminalId: string,
        sessionRef: string,
        chatSessionId: string
    ): Promise<void> {
        await this.db
            .update(terminalSessionRefs)
            .set({ chatSessionId })
            .where(
                and(
                    eq(terminalSessionRefs.terminalId, terminalId),
                    eq(terminalSessionRefs.sessionRef, sessionRef)
                )
            )
    }

    async find(
        terminalId: string,
        sessionRef: string
    ): Promise<TerminalSessionRefRow | null> {
        const [row] = await this.db
            .select()
            .from(terminalSessionRefs)
            .where(
                and(
                    eq(terminalSessionRefs.terminalId, terminalId),
                    eq(terminalSessionRefs.sessionRef, sessionRef)
                )
            )
            .limit(1)
        return row ?? null
    }

    async countForTerminal(terminalId: string): Promise<number> {
        const [row] = await this.db
            .select({ count: sql<number>`count(*)::int` })
            .from(terminalSessionRefs)
            .where(eq(terminalSessionRefs.terminalId, terminalId))
        return row?.count ?? 0
    }

    // Refs that started in the terminal and were never tied to a chat
    // session: what the terminal's end has to decide about.
    async listUnboundUnsettled(
        terminalId: string
    ): Promise<TerminalSessionRefRow[]> {
        return this.db
            .select()
            .from(terminalSessionRefs)
            .where(
                and(
                    eq(terminalSessionRefs.terminalId, terminalId),
                    isNull(terminalSessionRefs.chatSessionId),
                    isNull(terminalSessionRefs.settledAt)
                )
            )
            .orderBy(asc(terminalSessionRefs.firstSeenAt))
    }

    async settle(
        id: string,
        outcome: TerminalRefSettledOutcome,
        chatSessionId: string | null
    ): Promise<void> {
        await this.db
            .update(terminalSessionRefs)
            .set({
                settledAt: new Date(),
                settledOutcome: outcome,
                ...(chatSessionId ? { chatSessionId } : {})
            })
            .where(eq(terminalSessionRefs.id, id))
    }
}
