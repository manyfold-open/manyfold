import 'tsconfig-paths/register'
import 'reflect-metadata'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { and, eq, inArray, sql } from 'drizzle-orm'
import {
    agentRuntimes,
    agents,
    agentUsageEvents,
    chatMessages,
    chatMessageSources,
    chatSessions,
    chatStreamEvents,
    createDb,
    plans,
    users,
    type Database
} from '@manyfold/db'
import {
    inheritedAuditScratchUrl,
    SCRATCH_PREFIX,
    validateScratchAdminEnv,
    withScratchDatabase
} from '../scripts/scratch-db'
import { ChatRetentionService } from '../src/modules/chat-retention/chat-retention.service'

// Real-Postgres proof of the retention sweep's survivor set: SQL-side
// candidate filtering (NULL retention untouched), the inflight exemption,
// the chat_stream_events cascade, billing rows (agent_usage_events has no FK
// to messages) surviving with message_id intact, and chat_message_sources
// keeping the row while raw payloads are cleared.
//
// runOnce() enumerates every retention-plan user in the database it is given
// and deletes for real; the fixture's random ids do not narrow that scope by
// one row (#722). So the destructive target never comes from DATABASE_URL:
// each test creates, migrates and drops a throwaway database of its own, and
// the same-invocation neighbour below proves the sweep cannot reach out of it.
// The neighbour reuses DATABASE_URL only for the exact audit-generated URL on
// the validated admin authority; every other invocation creates another
// throwaway database. This file never loads .env. Run per-file:
//   RUN_PG_E2E=1 PG_TEST_SCRATCH=1 \
//     PG_TEST_ADMIN_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
//     node --import tsx --test test/chat-retention.pg.test.ts
const RUN = process.env.RUN_PG_E2E === '1'

const DAY_MS = 24 * 60 * 60 * 1000

interface Fixture {
    ids: Record<string, string>
}

interface Harness extends Fixture {
    db: Database
    service: ChatRetentionService
}

interface Digest {
    rows: number
    digest: string
}

const seedRetentionFixture = async (db: Database): Promise<Fixture> => {
    const sfx = randomBytes(8).toString('hex')
    const ids: Record<string, string> = {
        planFree: `plan_pgtest_free_${sfx}`,
        planPro: `plan_pgtest_pro_${sfx}`,
        userFree: `user_pgtest_free_${sfx}`,
        userPro: `user_pgtest_pro_${sfx}`,
        runtime: `art_pgtest_${sfx}`,
        agentFree: `agt_pgtest_free_${sfx}`,
        agentPro: `agt_pgtest_pro_${sfx}`,
        sessionFree: `ses_pgtest_free_${sfx}`,
        sessionInflight: `ses_pgtest_infl_${sfx}`,
        sessionPro: `ses_pgtest_pro_${sfx}`,
        msgOldUser: `msg_pgtest_oldu_${sfx}`,
        msgOldAssistant: `msg_pgtest_olda_${sfx}`,
        msgFresh: `msg_pgtest_new_${sfx}`,
        msgInflight: `msg_pgtest_infl_${sfx}`,
        msgProOld: `msg_pgtest_pro_${sfx}`,
        usage: `aue_pgtest_${sfx}`,
        source: `cms_pgtest_${sfx}`
    }
    const old = new Date(Date.now() - 40 * DAY_MS)
    const fresh = new Date(Date.now() - 1 * DAY_MS)

    await db.insert(plans).values([
        {
            id: ids.planFree,
            name: `pgtest-free-${sfx}`,
            maxAgentsProvisioned: 3,
            maxConcurrentActive: 1,
            maxStorageGb: 3,
            messageHistoryRetentionDays: 30
        },
        {
            id: ids.planPro,
            name: `pgtest-pro-${sfx}`,
            maxAgentsProvisioned: 3,
            maxConcurrentActive: 1,
            maxStorageGb: 3,
            messageHistoryRetentionDays: null
        }
    ])
    await db.insert(users).values([
        {
            id: ids.userFree,
            email: `${sfx}-free@pgtest.local`,
            planId: ids.planFree
        },
        {
            id: ids.userPro,
            email: `${sfx}-pro@pgtest.local`,
            planId: ids.planPro
        }
    ])
    await db.insert(agentRuntimes).values({
        id: ids.runtime,
        userId: ids.userFree,
        name: `pgtest-rt-${sfx}`,
        framework: 'codex',
        kind: 'sprites',
        status: 'ready'
    })
    const agentRows: Array<typeof agents.$inferInsert> = [
        {
            id: ids.agentFree,
            userId: ids.userFree,
            name: `pgtest-agent-free-${sfx}`,
            framework: 'codex',
            runtime: 'sprites',
            status: 'running',
            runtimeId: ids.runtime,
            internalId: `int-free-${sfx}`
        },
        {
            id: ids.agentPro,
            userId: ids.userPro,
            name: `pgtest-agent-pro-${sfx}`,
            framework: 'codex',
            runtime: 'sprites',
            status: 'running',
            runtimeId: ids.runtime,
            internalId: `int-pro-${sfx}`
        }
    ]
    await db.insert(agents).values(agentRows)
    await db.insert(chatSessions).values([
        { id: ids.sessionFree, userId: ids.userFree, agentId: ids.agentFree },
        {
            id: ids.sessionInflight,
            userId: ids.userFree,
            agentId: ids.agentFree,
            // a stuck-old turn lock pointing at an expired message: the sweep
            // must leave that message alone
            inflightMessageId: ids.msgInflight
        },
        { id: ids.sessionPro, userId: ids.userPro, agentId: ids.agentPro }
    ])
    await db.insert(chatMessages).values([
        {
            id: ids.msgOldUser,
            sessionId: ids.sessionFree,
            role: 'user',
            contentBlocksJson: [],
            createdAt: old
        },
        {
            id: ids.msgOldAssistant,
            sessionId: ids.sessionFree,
            role: 'assistant',
            contentBlocksJson: [],
            createdAt: old
        },
        {
            id: ids.msgFresh,
            sessionId: ids.sessionFree,
            role: 'user',
            contentBlocksJson: [],
            createdAt: fresh
        },
        {
            id: ids.msgInflight,
            sessionId: ids.sessionInflight,
            role: 'assistant',
            contentBlocksJson: [],
            createdAt: old
        },
        {
            id: ids.msgProOld,
            sessionId: ids.sessionPro,
            role: 'user',
            contentBlocksJson: [],
            createdAt: old
        }
    ])
    await db.insert(chatStreamEvents).values({
        sessionId: ids.sessionFree,
        messageId: ids.msgOldAssistant,
        seq: 1,
        eventType: 'done',
        payloadJson: {}
    })
    await db.insert(agentUsageEvents).values({
        id: ids.usage,
        userId: ids.userFree,
        sessionId: ids.sessionFree,
        messageId: ids.msgOldAssistant,
        framework: 'codex',
        runtimeKind: 'sprites',
        costSource: 'unknown'
    })
    await db.insert(chatMessageSources).values({
        id: ids.source,
        sessionId: ids.sessionFree,
        messageId: ids.msgOldAssistant,
        sourceKind: 'live_stream',
        framework: 'codex',
        runtime: 'sprites',
        sourceSeq: 1,
        sourceEventKey: `pgtest-${sfx}-1`,
        rawFormat: 'jsonl',
        rawText: '{"secret":"raw payload"}',
        rawJson: { secret: 'raw payload' },
        rawSha256: 'x',
        rawBytes: 24,
        parserName: 'pgtest',
        parserVersion: '1',
        parsedAt: old,
        createdAt: old
    })
    return { ids }
}

const closeDb = async (db: Database): Promise<void> => {
    const client = (
        db as unknown as { $client?: { end?: () => Promise<void> } }
    ).$client
    if (client?.end) await client.end()
}

const withCleanups = async <T>(
    body: () => Promise<T>,
    cleanups: Array<() => Promise<void>>
): Promise<T> => {
    let result!: T
    const errors: unknown[] = []
    try {
        result = await body()
    } catch (error) {
        errors.push(error)
    }
    for (const cleanup of cleanups)
        try {
            await cleanup()
        } catch (error) {
            errors.push(error)
        }
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1)
        throw new AggregateError(
            errors,
            `retention harness cleanup failed: ${errors.map((error) => (error instanceof Error ? error.message : String(error))).join('; ')}`
        )
    return result
}

const dropFixture = async (
    db: Database,
    ids: Record<string, string>
): Promise<void> => {
    await db.delete(users).where(inArray(users.id, [ids.userFree, ids.userPro]))
    await db.delete(plans).where(inArray(plans.id, [ids.planFree, ids.planPro]))
}

// create → migrate → connect → fixture → service → body → close → drop. The
// close and the drop are in the unwind path, so an assertion failure and a
// throw out of the fixture inserts or the service constructor land in the same
// place a passing run does.
const withRetentionHarness = async (
    body: (harness: Harness) => Promise<void>
): Promise<void> =>
    withScratchDatabase('ret', async ({ url }) => {
        const db = createDb(url)
        await withCleanups(async () => {
            const fixture = await seedRetentionFixture(db)
            const service = new ChatRetentionService(
                db as never,
                { get: () => undefined } as never,
                undefined as never
            )
            await body({ db, service, ...fixture })
        }, [() => closeDb(db)])
    })

const messageDigest = async (db: Database, userId: string): Promise<Digest> => {
    const rows = (await db.execute(sql`
        select
            count(*)::int as rows,
            md5(coalesce(string_agg(
                m.id || '|' || m.created_at::text || '|'
                    || m.content_blocks_json::text,
                ',' order by m.id
            ), '')) as digest
        from ${chatMessages} m
        join ${chatSessions} s on s.id = m.session_id
        where s.user_id = ${userId}
    `)) as Array<{ rows: number; digest: string }>
    return {
        rows: Number(rows[0]?.rows ?? -1),
        digest: String(rows[0]?.digest)
    }
}

// These are all three columns the sweep writes on a source row, so a digest
// over them covers every mutable part of the neighbour sentinel.
const sourceDigest = async (db: Database, userId: string): Promise<Digest> => {
    const rows = (await db.execute(sql`
        select
            count(*)::int as rows,
            md5(coalesce(string_agg(
                src.id || '|' || coalesce(src.raw_text, '<cleared>') || '|'
                    || coalesce(src.raw_json::text, '<cleared>') || '|'
                    || coalesce(src.raw_cleared_at::text, 'null'),
                ',' order by src.id
            ), '')) as digest
        from ${chatMessageSources} src
        join ${chatSessions} s on s.id = src.session_id
        where s.user_id = ${userId}
    `)) as Array<{ rows: number; digest: string }>
    return {
        rows: Number(rows[0]?.rows ?? -1),
        digest: String(rows[0]?.digest)
    }
}

const withNeighbourDatabase = async (
    body: (url: string) => Promise<void>
): Promise<void> => {
    const inherited = inheritedAuditScratchUrl(process.env)
    if (inherited) return body(inherited)
    return withScratchDatabase('nbr', ({ url }) => body(url))
}

const databaseExists = async (
    admin: Database,
    name: string
): Promise<boolean> => {
    const rows = (await admin.execute(
        sql`select 1 as present from pg_database where datname = ${name}`
    )) as Array<{ present: number }>
    return rows.length > 0
}

test(
    'retention sweep prunes expired history and preserves the survivor set',
    { skip: !RUN },
    async () => {
        await withRetentionHarness(async (h) => {
            const result = await h.service.runOnce()

            assert.equal(
                result.messagesDeleted,
                2,
                'the two old free-plan messages'
            )
            assert.equal(result.sourcesCleared, 1)
            assert.equal(result.capped, false)
            // Only meaningful on a database this run owns: the sweep walked
            // every retention-plan user there is and found exactly the seeded
            // one, so the count proves the scope stayed global.
            assert.equal(result.usersProcessed, 1)

            const survivors = await h.db
                .select({ id: chatMessages.id })
                .from(chatMessages)
                .innerJoin(
                    chatSessions,
                    eq(chatSessions.id, chatMessages.sessionId)
                )
                .where(
                    inArray(chatSessions.userId, [
                        h.ids.userFree,
                        h.ids.userPro
                    ])
                )
            assert.deepEqual(
                survivors.map((r) => r.id).sort(),
                [h.ids.msgFresh, h.ids.msgInflight, h.ids.msgProOld].sort(),
                'fresh, inflight-locked and unlimited-plan messages survive'
            )

            const events = await h.db
                .select({ id: chatStreamEvents.id })
                .from(chatStreamEvents)
                .where(eq(chatStreamEvents.messageId, h.ids.msgOldAssistant))
            assert.equal(events.length, 0, 'stream events die with the message')

            const [usage] = await h.db
                .select({
                    id: agentUsageEvents.id,
                    messageId: agentUsageEvents.messageId
                })
                .from(agentUsageEvents)
                .where(eq(agentUsageEvents.id, h.ids.usage))
            assert.ok(usage, 'billing row survives message deletion')
            assert.equal(
                usage.messageId,
                h.ids.msgOldAssistant,
                'no FK: message_id text stays intact'
            )

            const [source] = await h.db
                .select({
                    rawText: chatMessageSources.rawText,
                    rawJson: chatMessageSources.rawJson,
                    rawClearedAt: chatMessageSources.rawClearedAt,
                    sourceEventKey: chatMessageSources.sourceEventKey
                })
                .from(chatMessageSources)
                .where(eq(chatMessageSources.id, h.ids.source))
            assert.ok(source, 'source row survives (recovery dedup anchor)')
            assert.equal(source.rawText, null)
            assert.equal(source.rawJson, null)
            assert.ok(source.rawClearedAt instanceof Date)
            assert.equal(
                source.sourceEventKey,
                `pgtest-${h.ids.source.slice(-16)}-1`
            )

            const sessions = await h.db
                .select({ id: chatSessions.id })
                .from(chatSessions)
                .where(
                    and(
                        inArray(chatSessions.userId, [
                            h.ids.userFree,
                            h.ids.userPro
                        ])
                    )
                )
            assert.equal(sessions.length, 3, 'sessions are never deleted')

            const again = await h.service.runOnce()
            assert.equal(again.messagesDeleted, 0, 'idempotent second run')
            assert.equal(again.sourcesCleared, 0)
        })
    }
)

// #722. The sweep is global by design, so the isolation has to come from the
// database boundary: a neighbour holding rows that ARE retention candidates —
// expired messages on a 30-day plan and an uncleared raw payload — must come
// out byte-for-byte identical, because the sweep never had a connection to it.
test(
    'a neighbouring database keeps every row the sweep would have deleted',
    { skip: !RUN },
    async () => {
        await withNeighbourDatabase(async (neighbourUrl) => {
            const neighbour = createDb(neighbourUrl)
            let planted: Record<string, string> | null = null
            await withCleanups(async () => {
                const sentinel = await seedRetentionFixture(neighbour)
                planted = sentinel.ids
                const before = {
                    messages: await messageDigest(
                        neighbour,
                        sentinel.ids.userFree
                    ),
                    sources: await sourceDigest(
                        neighbour,
                        sentinel.ids.userFree
                    )
                }
                assert.equal(
                    before.messages.rows,
                    4,
                    'three expired, one fresh'
                )
                assert.equal(before.sources.rows, 1)

                await withRetentionHarness(async (h) => {
                    const result = await h.service.runOnce()
                    assert.equal(
                        result.messagesDeleted,
                        2,
                        'the sweep really ran destructively'
                    )
                    assert.equal(result.sourcesCleared, 1)
                })

                assert.deepEqual(
                    await messageDigest(neighbour, sentinel.ids.userFree),
                    before.messages,
                    'the neighbour lost no message row'
                )
                assert.deepEqual(
                    await sourceDigest(neighbour, sentinel.ids.userFree),
                    before.sources,
                    'the neighbour kept its raw payload uncleared'
                )
            }, [
                async () => {
                    if (planted) await dropFixture(neighbour, planted)
                },
                () => closeDb(neighbour)
            ])
        })
    }
)

// #722. Cleanup is the safety property, so it is asserted against pg_database
// rather than trusted: a normal return, a throw out of the harness body (the
// path a fixture insert or a service constructor takes) and a migration
// failure must all leave the database gone.
test(
    'the destructive target is a unique throwaway database on every path',
    { skip: !RUN },
    async () => {
        const admin = createDb(validateScratchAdminEnv(process.env).toString())
        const seen: string[] = []
        try {
            const passed = await withScratchDatabase('ret', async (target) => {
                seen.push(target.name)
                assert.ok(
                    target.name.startsWith(SCRATCH_PREFIX),
                    'the target is a scratch database'
                )
                assert.notEqual(
                    target.url,
                    process.env.DATABASE_URL,
                    'never the inherited application database'
                )
                assert.equal(await databaseExists(admin, target.name), true)
                return target.name
            })
            assert.equal(
                await databaseExists(admin, passed),
                false,
                'dropped after a normal return'
            )

            const constructionFailure = new Error('fixture insert failed')
            await assert.rejects(
                withScratchDatabase('ret', async (target) => {
                    seen.push(target.name)
                    throw constructionFailure
                }),
                (err: unknown) => err === constructionFailure
            )
            assert.equal(
                await databaseExists(admin, seen[1]),
                false,
                'dropped after a construction failure'
            )

            const migrationFailure = new Error('migrate exited 1')
            await assert.rejects(
                withScratchDatabase(
                    'ret',
                    async () => {
                        throw new Error('body must not run')
                    },
                    {
                        migrate: async (url) => {
                            seen.push(
                                decodeURIComponent(
                                    new URL(url).pathname.replace(/^\//, '')
                                )
                            )
                            throw migrationFailure
                        }
                    }
                ),
                (err: unknown) => err === migrationFailure
            )
            assert.equal(
                await databaseExists(admin, seen[2]),
                false,
                'dropped after a migration failure'
            )

            assert.equal(
                new Set(seen).size,
                seen.length,
                'every run owns a database no other run can name'
            )
        } finally {
            await closeDb(admin)
        }
    }
)
