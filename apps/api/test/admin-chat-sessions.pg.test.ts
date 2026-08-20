import { createObjectId } from '@manyfold/shared'
import 'tsconfig-paths/register'
import 'reflect-metadata'
import 'dotenv/config'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import test from 'node:test'
import { eq, inArray } from 'drizzle-orm'
import { BadRequestException, ForbiddenException } from '@nestjs/common'
import type { ExecutionContext } from '@nestjs/common'
import {
    agentRuntimes,
    agents,
    agentUsageEvents,
    chatMessages,
    chatSessions,
    chatStreamEvents,
    createDb,
    turnExecutions,
    users,
    type Database
} from '@manyfold/db'
import { AdminGuard } from '../src/common/guards/admin.guard'
import { ChatRepository } from '../src/modules/chat/chat.repository'
import { AdminChatSessionsService } from '../src/modules/chat/admin-chat-sessions.service'

// Real-Postgres proof of the admin session observability surface: an admin sees
// sessions across every user ordered by last activity, keyset paging neither
// skips nor repeats a row, bigserial event ids survive JSON serialization,
// event filters are honoured, a failed turn surfaces its error on the summary,
// and ILIKE metacharacters in the search box stay literal. Env-gated:
//   RUN_PG_E2E=1 DATABASE_URL=postgres://postgres:postgres@localhost:5432/nca \
//     node --import tsx --test test/admin-chat-sessions.pg.test.ts
const RUN = process.env.RUN_PG_E2E === '1'

interface Harness {
    db: Database
    suffix: string
    adminId: string
    memberId: string
    adminAgentId: string
    memberAgentId: string
    repo: ChatRepository
    service: AdminChatSessionsService
    guard: AdminGuard
    close: () => Promise<void>
}

const buildHarness = async (): Promise<Harness> => {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL must be set in .env')
    const db = createDb(url)
    const suffix = randomBytes(6).toString('hex')
    const adminId = `user_pgadmses_a_${suffix}`
    const memberId = `user_pgadmses_m_${suffix}`
    await db.insert(users).values([
        {
            id: adminId,
            email: `admin-${suffix}@pgtest.local`,
            role: 'admin'
        },
        { id: memberId, email: `member-${suffix}@pgtest.local` }
    ])

    const mkAgent = async (
        ownerId: string,
        tag: string
    ): Promise<string> => {
        const runtimeId = `art_pgadmses_${tag}_${suffix}`
        await db.insert(agentRuntimes).values({
            id: runtimeId,
            userId: ownerId,
            name: `pgadmses-runtime-${tag}-${suffix}`,
            framework: 'codex',
            kind: 'sprites'
        })
        const agentId = `agt_pgadmses_${tag}_${suffix}`
        await db.insert(agents).values({
            id: agentId,
            userId: ownerId,
            name: `pgadmses-agent-${tag}-${suffix}`,
            framework: 'codex',
            runtime: 'sprites',
            runtimeId,
            internalId: `pgadmses-${tag}-${suffix}`
        })
        return agentId
    }

    const adminAgentId = await mkAgent(adminId, 'a')
    const memberAgentId = await mkAgent(memberId, 'm')
    const repo = new ChatRepository(db)
    return {
        db,
        suffix,
        adminId,
        memberId,
        adminAgentId,
        memberAgentId,
        repo,
        service: new AdminChatSessionsService(repo),
        guard: new AdminGuard(db),
        close: async (): Promise<void> => {
            await db.delete(users).where(inArray(users.id, [adminId, memberId]))
        }
    }
}

// The admin list is global and ordered by last activity, so fixtures have to
// outrank whatever sessions the target database already holds.
let clock = Date.parse('2099-03-01T00:00:00Z')
const tick = (): Date => {
    clock += 60_000
    return new Date(clock)
}

const createSession = async (
    h: Harness,
    opts: {
        userId: string
        agentId: string
        title?: string | null
        updatedAt?: Date
        inflightMessageId?: string | null
    }
): Promise<string> => {
    const id = createObjectId('chatSession')
    const at = opts.updatedAt ?? tick()
    await h.db.insert(chatSessions).values({
        id,
        userId: opts.userId,
        agentId: opts.agentId,
        title: opts.title ?? null,
        createdAt: at,
        updatedAt: at,
        inflightMessageId: opts.inflightMessageId ?? null
    })
    return id
}

const addAssistantMessage = async (
    h: Harness,
    sessionId: string
): Promise<string> => {
    const id = `msg_${randomUUID()}`
    await h.db.insert(chatMessages).values({
        id,
        sessionId,
        role: 'assistant',
        contentBlocksJson: [{ type: 'text', text: 'hi' }],
        createdAt: tick()
    })
    return id
}

const addEvent = async (
    h: Harness,
    sessionId: string,
    messageId: string,
    seq: number,
    eventType: 'token' | 'tool_call' | 'error' | 'done',
    payloadJson: Record<string, unknown>
): Promise<void> => {
    await h.db.insert(chatStreamEvents).values({
        sessionId,
        messageId,
        seq,
        eventType,
        payloadJson,
        createdAt: tick()
    })
}

const fakeContext = (userId: string): ExecutionContext =>
    ({
        switchToHttp: () => ({
            getRequest: () => ({ auth: { userId } })
        })
    }) as unknown as ExecutionContext

test('admin sees every user’s sessions, newest activity first', {
    skip: !RUN && 'RUN_PG_E2E!=1'
}, async () => {
    const h = await buildHarness()
    try {
        const older = await createSession(h, {
            userId: h.memberId,
            agentId: h.memberAgentId,
            title: 'member session'
        })
        const newer = await createSession(h, {
            userId: h.adminId,
            agentId: h.adminAgentId,
            title: 'admin session'
        })

        const page = await h.service.list({
            limit: 50,
            cursor: null,
            agentId: null,
            userId: null,
            running: false,
            hasError: false,
            q: null
        })
        const ids = page.items.map((s) => s.id)
        assert.ok(ids.includes(older), 'member-owned session must be visible')
        assert.ok(ids.includes(newer), 'admin-owned session must be visible')
        assert.ok(
            ids.indexOf(newer) < ids.indexOf(older),
            'more recently active session sorts first'
        )

        const memberRow = page.items.find((s) => s.id === older)
        assert.equal(memberRow?.userEmail, `member-${h.suffix}@pgtest.local`)
        assert.equal(memberRow?.agentFramework, 'codex')
    } finally {
        await h.close()
    }
})

test('AdminGuard admits admins and rejects members', {
    skip: !RUN && 'RUN_PG_E2E!=1'
}, async () => {
    const h = await buildHarness()
    try {
        assert.equal(await h.guard.canActivate(fakeContext(h.adminId)), true)
        await assert.rejects(
            () => h.guard.canActivate(fakeContext(h.memberId)),
            ForbiddenException
        )
    } finally {
        await h.close()
    }
})

test('cursor paging covers each session exactly once', {
    skip: !RUN && 'RUN_PG_E2E!=1'
}, async () => {
    const h = await buildHarness()
    try {
        const seeded = [
            await createSession(h, {
                userId: h.memberId,
                agentId: h.memberAgentId
            }),
            await createSession(h, {
                userId: h.adminId,
                agentId: h.adminAgentId
            }),
            await createSession(h, {
                userId: h.memberId,
                agentId: h.memberAgentId
            })
        ]

        const seen: string[] = []
        let cursor: string | null = null
        for (let i = 0; i < 3; i++) {
            const page: Awaited<
                ReturnType<AdminChatSessionsService['list']>
            > = await h.service.list({
                limit: 1,
                cursor,
                agentId: null,
                userId: h.memberId,
                running: false,
                hasError: false,
                q: null
            })
            seen.push(...page.items.map((s) => s.id))
            cursor = page.nextCursor
            if (!cursor) break
        }
        const mine = seeded.filter((id) => seen.includes(id))
        assert.equal(mine.length, 2, 'both member sessions paged through')
        assert.equal(
            new Set(seen).size,
            seen.length,
            'no session repeats across pages'
        )

        await assert.rejects(
            () =>
                h.service.list({
                    limit: 50,
                    cursor: 'garbage',
                    agentId: null,
                    userId: null,
                    running: false,
                    hasError: false,
                    q: null
                }),
            BadRequestException
        )
    } finally {
        await h.close()
    }
})

test('event ids serialize as strings and honour filters', {
    skip: !RUN && 'RUN_PG_E2E!=1'
}, async () => {
    const h = await buildHarness()
    try {
        const sessionId = await createSession(h, {
            userId: h.memberId,
            agentId: h.memberAgentId
        })
        const first = await addAssistantMessage(h, sessionId)
        const second = await addAssistantMessage(h, sessionId)
        await addEvent(h, sessionId, first, 1, 'token', { text: 'a' })
        await addEvent(h, sessionId, first, 2, 'tool_call', { toolName: 'ls' })
        await addEvent(h, sessionId, first, 3, 'done', { finalMessageId: first })
        await addEvent(h, sessionId, second, 1, 'token', { text: 'b' })

        const all = await h.service.listEvents(sessionId, {
            limit: 100,
            afterId: null,
            order: 'desc',
            types: null,
            messageId: null
        })
        assert.equal(all.items.length, 4)
        assert.ok(
            all.items.every((e) => typeof e.id === 'string'),
            'bigserial id must cross the wire as a string'
        )
        assert.doesNotThrow(() => JSON.stringify(all))
        const descIds = all.items.map((e) => BigInt(e.id))
        for (let i = 1; i < descIds.length; i++)
            assert.ok(descIds[i - 1]! > descIds[i]!, 'desc order is strict')

        const asc = await h.service.listEvents(sessionId, {
            limit: 100,
            afterId: null,
            order: 'asc',
            types: null,
            messageId: null
        })
        assert.deepEqual(
            asc.items.map((e) => e.id),
            [...all.items].reverse().map((e) => e.id)
        )

        const filtered = await h.service.listEvents(sessionId, {
            limit: 100,
            afterId: null,
            order: 'desc',
            types: ['tool_call', 'done'],
            messageId: null
        })
        assert.deepEqual(
            [...new Set(filtered.items.map((e) => e.eventType))].sort(),
            ['done', 'tool_call']
        )

        const scoped = await h.service.listEvents(sessionId, {
            limit: 100,
            afterId: null,
            order: 'desc',
            types: null,
            messageId: second
        })
        assert.equal(scoped.items.length, 1)
        assert.equal(scoped.items[0]?.messageId, second)
    } finally {
        await h.close()
    }
})

test('status derives from the turn lock and the last turn outcome', {
    skip: !RUN && 'RUN_PG_E2E!=1'
}, async () => {
    const h = await buildHarness()
    try {
        const failed = await createSession(h, {
            userId: h.memberId,
            agentId: h.memberAgentId,
            title: 'failed session'
        })
        const failedMessage = await addAssistantMessage(h, failed)
        await h.db.insert(turnExecutions).values({
            messageId: failedMessage,
            sessionId: failed,
            agentId: h.memberAgentId,
            runtime: 'sprites',
            ownerId: 'api-test',
            leaseExpiresAt: tick(),
            state: 'failed'
        })
        await addEvent(h, failed, failedMessage, 1, 'error', {
            error: {
                code: 'EXEC_FAILED',
                message: 'sprite died mid-turn',
                retryable: true
            }
        })
        await h.db.insert(agentUsageEvents).values({
            id: `aue_pgadmses_${randomUUID().replaceAll('-', '')}`,
            userId: h.memberId,
            agentId: h.memberAgentId,
            sessionId: failed,
            messageId: failedMessage,
            framework: 'codex',
            runtimeKind: 'sprites',
            model: 'gpt-5-codex',
            inputTokens: 120,
            outputTokens: 34,
            costUsd: '0.001234',
            firstTokenMs: 850,
            totalMs: 4200,
            costSource: 'upstream'
        })

        const runningMessage = `msg_${randomUUID()}`
        const running = await createSession(h, {
            userId: h.memberId,
            agentId: h.memberAgentId,
            title: 'running session'
        })
        await h.db.insert(chatMessages).values({
            id: runningMessage,
            sessionId: running,
            role: 'assistant',
            contentBlocksJson: [],
            createdAt: tick()
        })
        await h.db
            .update(chatSessions)
            .set({ inflightMessageId: runningMessage })
            .where(inArray(chatSessions.id, [running]))

        const idle = await createSession(h, {
            userId: h.memberId,
            agentId: h.memberAgentId,
            title: 'idle 100%_session'
        })
        const idleMessage = await addAssistantMessage(h, idle)
        await addEvent(h, idle, idleMessage, 1, 'done', {
            finalMessageId: idleMessage
        })

        const recovered = await createSession(h, {
            userId: h.memberId,
            agentId: h.memberAgentId,
            title: 'recovered session'
        })
        const recoveredFailedMessage = await addAssistantMessage(h, recovered)
        await h.db.insert(turnExecutions).values({
            messageId: recoveredFailedMessage,
            sessionId: recovered,
            agentId: h.memberAgentId,
            runtime: 'sprites',
            ownerId: 'api-test',
            leaseExpiresAt: tick(),
            state: 'failed',
            createdAt: tick()
        })
        await addEvent(h, recovered, recoveredFailedMessage, 1, 'error', {
            error: {
                code: 'TRANSIENT_FAILURE',
                message: 'recovered after retry',
                retryable: true
            }
        })
        const recoveredDoneMessage = await addAssistantMessage(h, recovered)
        await h.db.insert(turnExecutions).values({
            messageId: recoveredDoneMessage,
            sessionId: recovered,
            agentId: h.memberAgentId,
            runtime: 'sprites',
            ownerId: 'api-test',
            leaseExpiresAt: tick(),
            state: 'done',
            createdAt: tick()
        })
        await addEvent(h, recovered, recoveredDoneMessage, 1, 'done', {
            finalMessageId: recoveredDoneMessage
        })

        const page = await h.service.list({
            limit: 50,
            cursor: null,
            agentId: null,
            userId: h.memberId,
            running: false,
            hasError: false,
            q: null
        })
        const byId = new Map(page.items.map((s) => [s.id, s]))
        assert.equal(byId.get(failed)?.status, 'failed')
        assert.equal(byId.get(failed)?.lastTurnState, 'failed')
        assert.equal(
            byId.get(failed)?.lastError?.message,
            'sprite died mid-turn'
        )
        assert.equal(byId.get(failed)?.inputTokens, 120)
        assert.equal(byId.get(failed)?.costUsd, 0.001234)
        assert.equal(byId.get(running)?.status, 'running')
        assert.equal(byId.get(idle)?.status, 'idle')
        assert.equal(byId.get(recovered)?.status, 'idle')

        const exact = await h.service.list({
            limit: 50,
            cursor: null,
            agentId: null,
            userId: null,
            running: false,
            hasError: false,
            q: failed
        })
        assert.deepEqual(
            exact.items.map((s) => s.id),
            [failed],
            'a full cts_ id searches by exact id'
        )

        // `%` and `_` must match literally, not as ILIKE wildcards.
        const literal = await h.service.list({
            limit: 50,
            cursor: null,
            agentId: null,
            userId: h.memberId,
            running: false,
            hasError: false,
            q: '100%_session'
        })
        assert.deepEqual(
            literal.items.map((s) => s.id),
            [idle]
        )

        const runningOnly = await h.service.list({
            limit: 50,
            cursor: null,
            agentId: null,
            userId: h.memberId,
            running: true,
            hasError: false,
            q: null
        })
        assert.deepEqual(
            runningOnly.items.map((s) => s.id),
            [running]
        )

        const withErrors = await h.service.list({
            limit: 50,
            cursor: null,
            agentId: null,
            userId: h.memberId,
            running: false,
            hasError: true,
            q: null
        })
        assert.deepEqual(
            new Set(withErrors.items.map((s) => s.id)),
            new Set([failed, recovered]),
            'error filter includes historical failures after a later successful turn'
        )

        const detail = await h.service.get(failed)
        assert.equal(detail.turns.length, 1)
        assert.equal(detail.turns[0]?.execution?.state, 'failed')
        assert.equal(detail.turns[0]?.model, 'gpt-5-codex')
        assert.equal(detail.turns[0]?.firstTokenMs, 850)
        assert.equal(detail.turns[0]?.totalMs, 4200)
        assert.equal(detail.turns[0]?.error?.code, 'EXEC_FAILED')
        assert.equal(detail.eventCounts.error, 1)
    } finally {
        await h.close()
    }
})

// #672: eventCounts and the events list are counts of rows still stored, so a
// compacted turn and a turn that never said much read identically here. The
// turn carries its own answer, and a turn nobody compacted has to keep saying
// so — including every turn written before the columns existed, which take the
// default rather than a backfill.
test('a turn reports the stream rows retention has already deleted', {
    skip: !RUN && 'RUN_PG_E2E!=1'
}, async () => {
    const h = await buildHarness()
    try {
        const sessionId = await createSession(h, {
            userId: h.memberId,
            agentId: h.memberAgentId,
            title: 'compacted session'
        })
        const quiet = await addAssistantMessage(h, sessionId)
        const compacted = await addAssistantMessage(h, sessionId)
        await addEvent(h, sessionId, quiet, 1, 'done', {})
        await addEvent(h, sessionId, compacted, 1, 'done', {})
        const at = new Date('2099-04-02T03:04:05.000Z')
        await h.db
            .update(chatMessages)
            .set({ compactedStreamRows: 1420, streamCompactedAt: at })
            .where(eq(chatMessages.id, compacted))

        const detail = await h.service.get(sessionId)
        const byId = new Map(detail.turns.map((t) => [t.messageId, t]))

        assert.equal(byId.get(compacted)?.compactedStreamRows, 1420)
        assert.equal(
            byId.get(compacted)?.streamCompactedAt,
            at.toISOString(),
            'the timestamp crosses the DTO as ISO-8601, not a Date'
        )
        assert.equal(byId.get(quiet)?.compactedStreamRows, 0)
        assert.equal(
            byId.get(quiet)?.streamCompactedAt,
            null,
            'a turn nothing compacted must not look compacted'
        )
        assert.equal(
            detail.eventCounts.done,
            2,
            'the event counts still report only what is stored'
        )
    } finally {
        await h.close()
    }
})
