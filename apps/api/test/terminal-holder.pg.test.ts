import 'tsconfig-paths/register'
import 'reflect-metadata'
import 'dotenv/config'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { eq, sql } from 'drizzle-orm'
import {
    agentRuntimes,
    agents,
    apiTokens,
    chatSessions,
    createDb,
    terminalSessions,
    tokenCredentials,
    users,
    type Database
} from '@manyfold/db'
import { ChatRepository } from '../src/modules/chat/chat.repository'
import { TerminalSessionsRepository } from '../src/modules/terminal/terminal-sessions.repository'
import { TerminalSessionRefsRepository } from '../src/modules/terminal/terminal-session-refs.repository'

// Real-Postgres proof for session ownership by terminals (ADR-0029 §1, §2).
//
// The in-memory chat and terminal tests stub these methods, so only live PG
// exercises the actual SQL: the acquire compare-and-set and its three
// predicates, the release that stamps the import pending in the same
// statement, the fenced clear, the turn claim refusing a held or pending
// session, the CHECK that makes a double occupancy unwritable even for older
// code, and the terminal row's lease and end compare-and-sets.
//
// Env-gated like the other *.pg.test.ts:
//   RUN_PG_E2E=1 DATABASE_URL=postgres://postgres:postgres@localhost:5432/nca \
//     pnpm --filter @manyfold/api test
// against a migrated DB (`just db-migrate`).
const RUN = process.env.RUN_PG_E2E === '1'

interface Harness {
    db: Database
    repo: ChatRepository
    terminals: TerminalSessionsRepository
    refs: TerminalSessionRefsRepository
    userId: string
    agentId: string
    runtimeId: string
    sessionId: string
    close: () => Promise<void>
}

const buildHarness = async (): Promise<Harness> => {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL must be set in .env')
    const db = createDb(url)
    const suffix = randomBytes(8).toString('hex')
    const userId = `user_pgtest_${suffix}`
    const runtimeId = `art_pgtest_${suffix}`
    const agentId = `agt_pgtest_${suffix}`
    const sessionId = `cts_pgtest_${suffix}`

    await db
        .insert(users)
        .values({ id: userId, email: `${suffix}@pgtest.local` })
    await db.insert(agentRuntimes).values({
        id: runtimeId,
        userId,
        name: `pgtest-runtime-${suffix}`,
        framework: 'claude-code',
        kind: 'sprites'
    })
    await db.insert(agents).values({
        id: agentId,
        userId,
        name: 'pgtest-agent',
        framework: 'claude-code',
        runtime: 'sprites',
        runtimeId,
        internalId: `internal-${agentId}`
    })
    await db.insert(chatSessions).values({
        id: sessionId,
        userId,
        agentId,
        frameworkSessionRef: 'ref-1'
    })

    return {
        db,
        repo: new ChatRepository(db),
        terminals: new TerminalSessionsRepository(db),
        refs: new TerminalSessionRefsRepository(db),
        userId,
        agentId,
        runtimeId,
        sessionId,
        close: async (): Promise<void> => {
            await db.delete(users).where(eq(users.id, userId))
            const client = (
                db as unknown as { $client?: { end?: () => Promise<void> } }
            ).$client
            if (client?.end) await client.end()
        }
    }
}

const newTerminal = (h: Harness) =>
    h.terminals.create({
        userId: h.userId,
        agentId: h.agentId,
        runtime: 'sprites',
        hostId: null,
        runtimeId: h.runtimeId
    })

const readSession = async (h: Harness) =>
    (
        await h.db
            .select({
                inflightMessageId: chatSessions.inflightMessageId,
                holderTerminalId: chatSessions.holderTerminalId,
                holderAcquiredAt: chatSessions.holderAcquiredAt,
                importPendingSince: chatSessions.importPendingSince
            })
            .from(chatSessions)
            .where(eq(chatSessions.id, h.sessionId))
    )[0]

test(
    'acquire is a compare-and-set against a live turn, another holder and the ref',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            const t1 = await newTerminal(h)
            const t2 = await newTerminal(h)
            // The ref the argv was built from must still be the row's ref.
            assert.equal(
                await h.repo.acquireSessionHolder(
                    h.sessionId,
                    t1.id,
                    'ref-moved'
                ),
                false
            )
            assert.equal(
                await h.repo.acquireSessionHolder(h.sessionId, t1.id, 'ref-1'),
                true
            )
            assert.equal((await readSession(h)).holderTerminalId, t1.id)
            assert.ok((await readSession(h)).holderAcquiredAt)
            // A second terminal cannot take a held session.
            assert.equal(
                await h.repo.acquireSessionHolder(h.sessionId, t2.id, 'ref-1'),
                false
            )
            assert.equal((await readSession(h)).holderTerminalId, t1.id)
            // Nor can a turn claim it: the refusal names the terminal.
            assert.deepEqual(
                await h.repo.claimInflightTurn(h.sessionId, 'm1'),
                {
                    ok: false,
                    blockedBy: 'terminal'
                }
            )
            assert.equal((await readSession(h)).inflightMessageId, null)
            // And the database itself refuses a double occupancy, whoever writes.
            await assert.rejects(
                h.db
                    .update(chatSessions)
                    .set({ inflightMessageId: 'm-raw' })
                    .where(eq(chatSessions.id, h.sessionId)),
                /chat_sessions_turn_xor_holder/
            )
        } finally {
            await h.close()
        }
    }
)

test(
    'a live turn refuses the acquire, and a pending import does not',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            const t1 = await newTerminal(h)
            assert.equal(
                (await h.repo.claimInflightTurn(h.sessionId, 'm1')).ok,
                true
            )
            assert.equal(
                await h.repo.acquireSessionHolder(h.sessionId, t1.id, 'ref-1'),
                false
            )
            assert.equal(
                await h.repo.releaseInflightTurn(h.sessionId, 'm1'),
                true
            )
            await h.db
                .update(chatSessions)
                .set({ importPendingSince: new Date() })
                .where(eq(chatSessions.id, h.sessionId))
            assert.equal(
                await h.repo.acquireSessionHolder(h.sessionId, t1.id, 'ref-1'),
                true
            )
        } finally {
            await h.close()
        }
    }
)

test(
    'release stamps the import pending in the same statement and the clear is fenced',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            const t1 = await newTerminal(h)
            const t2 = await newTerminal(h)
            assert.equal(
                await h.repo.acquireSessionHolder(h.sessionId, t1.id, 'ref-1'),
                true
            )
            // Only the holder's own id releases.
            assert.deepEqual(
                await h.repo.releaseSessionHolder(h.sessionId, t2.id),
                {
                    released: false,
                    importPendingSince: null
                }
            )
            const released = await h.repo.releaseSessionHolder(
                h.sessionId,
                t1.id
            )
            assert.equal(released.released, true)
            assert.ok(released.importPendingSince)
            const after = await readSession(h)
            assert.equal(after.holderTerminalId, null)
            assert.equal(after.holderAcquiredAt, null)
            assert.equal(
                after.importPendingSince?.getTime(),
                released.importPendingSince?.getTime()
            )
            // A turn is refused while the import is pending, naming the import.
            assert.deepEqual(
                await h.repo.claimInflightTurn(h.sessionId, 'm1'),
                {
                    ok: false,
                    blockedBy: 'import'
                }
            )
            // The clear is fenced on the stamp the importer observed...
            assert.equal(
                await h.repo.clearImportPending(
                    h.sessionId,
                    new Date(released.importPendingSince!.getTime() - 1)
                ),
                false
            )
            // ...and refused while a terminal holds the session again.
            assert.equal(
                await h.repo.acquireSessionHolder(h.sessionId, t2.id, 'ref-1'),
                true
            )
            assert.equal(
                await h.repo.clearImportPending(
                    h.sessionId,
                    released.importPendingSince!
                ),
                false
            )
            const rereleased = await h.repo.releaseSessionHolder(
                h.sessionId,
                t2.id
            )
            assert.equal(rereleased.released, true)
            assert.equal(
                await h.repo.clearImportPending(
                    h.sessionId,
                    rereleased.importPendingSince!
                ),
                true
            )
            assert.equal((await readSession(h)).importPendingSince, null)
            assert.equal(
                (await h.repo.claimInflightTurn(h.sessionId, 'm1')).ok,
                true
            )
        } finally {
            await h.close()
        }
    }
)

test(
    'the idle writers and the deletes refuse a held session',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            const t1 = await newTerminal(h)
            assert.equal(
                await h.repo.acquireSessionHolder(h.sessionId, t1.id, 'ref-1'),
                true
            )
            assert.deepEqual(
                await h.repo.upsertMessageSourcesForIdleSession(
                    h.sessionId,
                    [],
                    'x'
                ),
                { upserted: 0, conflicted: true }
            )
            assert.deepEqual(
                await h.repo.replaceSessionMessages(h.sessionId, []),
                {
                    replaced: 0,
                    conflicted: true,
                    upsertedSources: 0
                }
            )
            assert.equal(
                await h.repo.advanceRuntimeSyncCursor(h.sessionId, null, 3),
                false
            )
            assert.equal(await h.repo.deleteSession(h.sessionId), false)
            assert.equal(await h.repo.deleteSessionIfEmpty(h.sessionId), false)
            assert.equal(
                (await h.repo.releaseSessionHolder(h.sessionId, t1.id))
                    .released,
                true
            )
            assert.equal(await h.repo.deleteSession(h.sessionId), true)
        } finally {
            await h.close()
        }
    }
)

test(
    'the terminal row: lease renewal, ending once, and the expired scan',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            const row = await newTerminal(h)
            assert.equal(row.endedAt, null)
            assert.ok(row.leaseExpiresAt.getTime() > Date.now() + 200_000)
            await h.terminals.setHandle(row.id, 'exec-1')
            await h.terminals.markHeld(row.id, h.sessionId)
            assert.equal(await h.terminals.renewLease(row.id), true)
            // Not expired yet: the scan does not list it.
            assert.equal(
                (await h.terminals.listExpiredLive(50)).some(
                    (r) => r.id === row.id
                ),
                false
            )
            await h.db
                .update(terminalSessions)
                .set({ leaseExpiresAt: sql`now() - interval '1 second'` })
                .where(eq(terminalSessions.id, row.id))
            const expired = await h.terminals.listExpiredLive(50)
            assert.ok(expired.some((r) => r.id === row.id))
            // Exactly one ender wins; the loser sees the row already ended.
            const ended = await h.terminals.end(row.id, 'reclaimed')
            assert.equal(ended?.processHandle, 'exec-1')
            assert.equal(ended?.heldSessionId, h.sessionId)
            assert.equal(await h.terminals.end(row.id, 'closed'), null)
            // An ended row renews nothing: its tunnel must stop.
            assert.equal(await h.terminals.renewLease(row.id), false)
            assert.equal(
                (await h.terminals.listExpiredLive(50)).some(
                    (r) => r.id === row.id
                ),
                false
            )
            // ended_at and ended_reason travel together.
            await assert.rejects(
                h.db
                    .update(terminalSessions)
                    .set({ endedReason: null })
                    .where(eq(terminalSessions.id, row.id)),
                /terminal_sessions_ended_pair/
            )
        } finally {
            await h.close()
        }
    }
)

test(
    'ended rows past the retention window are pruned in bounded batches',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            const live = await newTerminal(h)
            const recent = await newTerminal(h)
            const old1 = await newTerminal(h)
            const old2 = await newTerminal(h)
            await h.terminals.end(recent.id, 'closed')
            for (const row of [old1, old2]) {
                await h.terminals.end(row.id, 'closed')
                await h.db
                    .update(terminalSessions)
                    .set({
                        endedAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
                    })
                    .where(eq(terminalSessions.id, row.id))
            }
            const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
            assert.equal(await h.terminals.deleteEndedBefore(cutoff, 1), 1)
            assert.equal(await h.terminals.deleteEndedBefore(cutoff, 10), 1)
            assert.equal(await h.terminals.deleteEndedBefore(cutoff, 10), 0)
            assert.ok(
                await h.terminals.findById(live.id),
                'a live row is never pruned'
            )
            assert.ok(
                await h.terminals.findById(recent.id),
                'a recently ended row is kept'
            )
        } finally {
            await h.close()
        }
    }
)

// ADR-0029 §3: what the CLI session hooks add on top.
test(
    'a hook-reported ref upserts per (terminal, ref) and never unbinds a session',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            const t1 = await newTerminal(h)
            assert.equal(await h.refs.countForTerminal(t1.id), 0)
            const first = await h.refs.recordStart({
                terminalId: t1.id,
                framework: 'claude-code',
                sessionRef: 'ref-new',
                source: 'startup',
                cwd: '/home/me',
                chatSessionId: null
            })
            assert.equal(first.lastEvent, 'start')
            assert.equal(first.chatSessionId, null)
            const again = await h.refs.recordStart({
                terminalId: t1.id,
                framework: 'claude-code',
                sessionRef: 'ref-new',
                source: 'resume',
                cwd: null,
                chatSessionId: h.sessionId
            })
            assert.equal(again.id, first.id)
            assert.equal(again.source, 'startup', 'the first source is kept')
            assert.equal(again.chatSessionId, h.sessionId)
            const third = await h.refs.recordStart({
                terminalId: t1.id,
                framework: 'claude-code',
                sessionRef: 'ref-new',
                source: 'compact',
                cwd: null,
                chatSessionId: null
            })
            assert.equal(third.chatSessionId, h.sessionId, 'null never unbinds')
            assert.equal(await h.refs.countForTerminal(t1.id), 1)
            assert.equal(await h.refs.recordEnd(t1.id, 'ref-new'), true)
            assert.equal(await h.refs.recordEnd(t1.id, 'ref-never'), false)
            assert.equal(
                (await h.refs.find(t1.id, 'ref-new'))?.lastEvent,
                'end'
            )
            // Unbound refs are what the terminal's end settles.
            const unbound = await h.refs.recordStart({
                terminalId: t1.id,
                framework: 'claude-code',
                sessionRef: 'ref-fresh',
                source: 'clear',
                cwd: null,
                chatSessionId: null
            })
            assert.deepEqual(
                (await h.refs.listUnboundUnsettled(t1.id)).map((r) => r.id),
                [unbound.id]
            )
            await h.refs.settle(unbound.id, 'empty', null)
            assert.deepEqual(await h.refs.listUnboundUnsettled(t1.id), [])
            // The refs go with their terminal.
            await h.db
                .delete(terminalSessions)
                .where(eq(terminalSessions.id, t1.id))
            assert.equal(await h.refs.countForTerminal(t1.id), 0)
        } finally {
            await h.close()
        }
    }
)

test(
    'the ref move and the tail import are fenced on the hold; the token names the live terminal',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            const t1 = await newTerminal(h)
            const t2 = await newTerminal(h)
            assert.equal(
                await h.repo.moveHeldSessionRef(h.sessionId, t1.id, 'ref-2'),
                false,
                'no hold, no move'
            )
            assert.equal(
                await h.repo.acquireSessionHolder(h.sessionId, t1.id, 'ref-1'),
                true
            )
            await h.repo
                .advanceRuntimeSyncCursor(h.sessionId, null, 4)
                .catch(() => {})
            assert.equal(
                await h.repo.moveHeldSessionRef(h.sessionId, t2.id, 'ref-2'),
                false,
                'another terminal cannot redirect the session'
            )
            // The holder may append under its own hold; nobody else may.
            const row = (sessionId: string, key: string) => ({
                id: randomBytes(8).toString('hex'),
                sessionId,
                role: 'assistant' as const,
                contentBlocksJson: [{ type: 'text' as const, text: key }],
                capabilityEventsJson: {},
                createdAt: new Date()
            })
            const m1 = row(h.sessionId, 'tail-1')
            assert.equal(
                (await h.repo.appendRecoveredMessages(h.sessionId, [m1], []))
                    .conflicted,
                true
            )
            assert.equal(
                (
                    await h.repo.appendRecoveredMessages(
                        h.sessionId,
                        [m1],
                        [],
                        { holderTerminalId: t2.id }
                    )
                ).conflicted,
                true
            )
            const appended = await h.repo.appendRecoveredMessages(
                h.sessionId,
                [m1],
                [],
                { holderTerminalId: t1.id }
            )
            assert.equal(appended.conflicted, false)
            assert.equal(appended.appended, 1)
            assert.equal(
                await h.repo.moveHeldSessionRef(h.sessionId, t1.id, 'ref-2'),
                true
            )
            const state = await h.repo.sessionHolderState(h.sessionId)
            assert.equal(state?.frameworkSessionRef, 'ref-2')
            assert.equal(state?.holderTerminalId, t1.id)
            assert.equal(
                (
                    await h.db
                        .select({ cursor: chatSessions.runtimeSyncCursor })
                        .from(chatSessions)
                        .where(eq(chatSessions.id, h.sessionId))
                )[0].cursor,
                null,
                'a moved ref starts the covered prefix over'
            )
            // The hook endpoint resolves the terminal from the token id it
            // authenticated with, and only while the terminal is live.
            const tokenHash = randomBytes(16).toString('hex')
            await h.db
                .insert(tokenCredentials)
                .values({ tokenHash, kind: 'external' })
            const [token] = await h.db
                .insert(apiTokens)
                .values({
                    id: `tok_pgtest_${randomBytes(4).toString('hex')}`,
                    userId: h.userId,
                    name: 'terminal',
                    tokenHash,
                    scopes: ['api.full'],
                    tokenKind: 'terminal'
                })
                .returning({ id: apiTokens.id })
            await h.terminals.bindToken(t1.id, token.id)
            assert.equal(
                (await h.terminals.findLiveByTokenId(token.id))?.id,
                t1.id
            )
            await h.terminals.end(t1.id, 'closed')
            assert.equal(await h.terminals.findLiveByTokenId(token.id), null)
            await h.db
                .delete(tokenCredentials)
                .where(eq(tokenCredentials.tokenHash, tokenHash))
        } finally {
            await h.close()
        }
    }
)
