import 'tsconfig-paths/register'
import 'reflect-metadata'
import 'dotenv/config'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { asc, eq, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import {
    agentRuntimes,
    agents,
    chatMessages,
    chatMessageSources,
    chatSessions,
    chatStreamEvents,
    createDb,
    plans,
    turnExecutions,
    users,
    type Database
} from '@manyfold/db'
import { ChatRetentionService } from '../src/modules/chat-retention/chat-retention.service'
import { RETENTION_WINDOW_MAX_DAYS } from '../src/modules/chat-retention/retention-window'
import { ChatRepository } from '../src/modules/chat/chat.repository'
import { ASSISTANT_BLOCKS_TRUNCATION_MARKER } from '../src/modules/chat/assistant-blocks'

// Age-based raw_text clearing is fleet-wide: it takes no user id, so pointing
// it at a shared database would clear real payloads. This suite builds and
// drops its OWN database — DATABASE_URL is borrowed only for host and
// credentials. Every exemption the sweep makes is a SQL predicate no fake db
// can express, so this is the only place the survivor set is really proven.
//
//   RUN_PG_E2E=1 DATABASE_URL=postgres://postgres:postgres@localhost:5432/x \
//     npx tsx --test test/source-raw-retention.pg.test.ts
const RUN = process.env.RUN_PG_E2E === '1'

const DAY_MS = 24 * 60 * 60 * 1000
// 200d is outside the 180d floor; 30d is well inside it.
const OLD = new Date(Date.now() - 200 * DAY_MS)
const YOUNG = new Date(Date.now() - 30 * DAY_MS)

// Big enough that pg_total_relation_size moves by more than page rounding.
const PAYLOAD = `{"type":"assistant","text":"${'x'.repeat(2048)}"}`

interface Harness {
    db: Database
    service: ChatRetentionService
    build: (config?: Record<string, string>) => ChatRetentionService
    events: Array<[string, Record<string, unknown>]>
    sessionId: string
    inflightSessionId: string
    // The plan-based route. Its user is on a FINITE retention plan, so
    // sweepRetention reaches these rows and the age-based sweep never has to.
    planSessionId: string
    planStuckSessionId: string
    drop: () => Promise<void>
}

const adminUrl = (url: URL): string => {
    const admin = new URL(url.toString())
    admin.pathname = '/postgres'
    return admin.toString()
}

const buildHarness = async (): Promise<Harness> => {
    const raw = process.env.DATABASE_URL
    if (!raw) throw new Error('DATABASE_URL must be set')
    const url = new URL(raw)
    const suffix = randomBytes(6).toString('hex')
    const dbName = `mf_rawclear_${suffix}`

    const admin = postgres(adminUrl(url), { max: 1 })
    await admin.unsafe(`create database "${dbName}"`)
    await admin.end()

    const target = new URL(url.toString())
    target.pathname = `/${dbName}`
    const migrationClient = postgres(target.toString(), { max: 1 })
    await migrate(drizzle(migrationClient), {
        migrationsFolder: path.resolve(process.cwd(), 'drizzle')
    })
    // §4.2 contract journal: this scratch database runs the current code,
    // which is switch-side by definition. The journal rides the private tree
    // (apps/api-cloud); a tree without it has nothing to apply (its baseline
    // never had the switched columns).
    const contractFolder = ['drizzle-contract', '../api-cloud/drizzle-contract']
        .map((candidate) => path.resolve(process.cwd(), candidate))
        .find((candidate) => existsSync(candidate))
    if (contractFolder)
        await migrate(drizzle(migrationClient), {
            migrationsFolder: contractFolder,
            migrationsTable: '__drizzle_migrations_contract'
        })
    await migrationClient.end()

    const db = createDb(target.toString())
    const events: Array<[string, Record<string, unknown>]> = []
    const build = (config: Record<string, string> = {}): ChatRetentionService =>
        new ChatRetentionService(
            db,
            { get: (key: string) => config[key] } as never,
            undefined,
            {
                event: (name: string, attrs: Record<string, unknown>) =>
                    events.push([name, attrs])
            } as never
        )
    const service = build()

    const planId = `plan_${suffix}`
    const userId = `user_${suffix}`
    const runtimeId = `art_${suffix}`
    const agentId = `agt_${suffix}`
    const sessionId = `cts_${suffix}`
    const inflightSessionId = `cts_infl_${suffix}`
    const planUserId = `user_plan_${suffix}`
    const planPlanId = `plan_finite_${suffix}`
    const planSessionId = `cts_plan_${suffix}`
    const planStuckSessionId = `cts_plan_stuck_${suffix}`
    // retention NULL keeps the plan-based sweep out of this run entirely, so
    // every cleared row is attributable to the age-based sweep — and it is
    // also the case the age-based sweep exists for.
    await db.insert(plans).values({
        id: planId,
        name: `pgtest-${suffix}`,
        maxAgentsProvisioned: 3,
        maxConcurrentActive: 1,
        maxStorageGb: 3,
        messageHistoryRetentionDays: null
    })
    // 30d, so the plan-based sweep runs for this user on the same tick. Kept
    // BELOW the age window on purpose: the age sweep widens itself to the
    // widest plan window, so a finite plan here must not move it.
    await db.insert(plans).values({
        id: planPlanId,
        name: `pgtest-finite-${suffix}`,
        maxAgentsProvisioned: 3,
        maxConcurrentActive: 1,
        maxStorageGb: 3,
        messageHistoryRetentionDays: 30
    })
    await db.insert(users).values([
        { id: userId, email: `${suffix}@pgtest.local`, planId },
        {
            id: planUserId,
            email: `${suffix}-plan@pgtest.local`,
            planId: planPlanId
        }
    ])
    await db.insert(agentRuntimes).values({
        id: runtimeId,
        userId,
        name: `rt-${suffix}`,
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
    await db.insert(chatSessions).values([
        { id: sessionId, userId, agentId },
        {
            id: inflightSessionId,
            userId,
            agentId,
            inflightMessageId: 'msg_inflight'
        },
        { id: planSessionId, userId: planUserId, agentId },
        {
            id: planStuckSessionId,
            userId: planUserId,
            agentId,
            // A turn orphaned while holding the lock. deleteMessageBatch
            // refuses to delete it, so it survives the plan cutoff — and
            // before the shared predicate, clearSourceBatch took its payload.
            inflightMessageId: 'msg_plan_stuck'
        }
    ])

    return {
        db,
        service,
        build,
        events,
        sessionId,
        inflightSessionId,
        planSessionId,
        planStuckSessionId,
        drop: async (): Promise<void> => {
            const client = (
                db as unknown as { $client?: { end?: () => Promise<void> } }
            ).$client
            if (client?.end) await client.end()
            const closer = postgres(adminUrl(url), { max: 1 })
            await closer.unsafe(`drop database if exists "${dbName}"`)
            await closer.end()
        }
    }
}

const seedMessage = async (
    h: Harness,
    id: string,
    opts: {
        sessionId?: string
        createdAt: Date
        truncated?: boolean
        terminal?: boolean
        execState?: 'running' | 'handoff' | 'adopting' | 'done' | 'failed'
    }
): Promise<void> => {
    const sessionId = opts.sessionId ?? h.sessionId
    await h.db.insert(chatMessages).values({
        id,
        sessionId,
        role: 'assistant',
        contentBlocksJson: opts.truncated
            ? [
                  {
                      type: 'text',
                      text: `${ASSISTANT_BLOCKS_TRUNCATION_MARKER}what survived`
                  }
              ]
            : [{ type: 'text', text: 'an ordinary answer' }],
        createdAt: opts.createdAt
    })
    if (opts.terminal)
        await h.db.insert(chatStreamEvents).values({
            sessionId,
            messageId: id,
            seq: 1,
            eventType: 'done',
            payloadJson: {},
            createdAt: opts.createdAt
        })
    if (opts.execState)
        await h.db.insert(turnExecutions).values({
            messageId: id,
            sessionId,
            agentId: `agt_${id}`,
            runtime: 'sprites',
            ownerId: 'gone-instance',
            // Lapsed: exactly the state listAdoptableTurnExecutions selects.
            leaseExpiresAt: opts.createdAt,
            state: opts.execState,
            createdAt: opts.createdAt,
            updatedAt: opts.createdAt
        })
}

const seedSource = async (
    h: Harness,
    id: string,
    opts: {
        sessionId?: string
        messageId: string | null
        createdAt: Date
        json?: boolean
        alreadyCleared?: boolean
    }
): Promise<void> => {
    await h.db.insert(chatMessageSources).values({
        id,
        sessionId: opts.sessionId ?? h.sessionId,
        messageId: opts.messageId,
        sourceKind: 'live_stream',
        framework: 'claude-code',
        runtime: 'sprites',
        sourceSeq: 1,
        sourceEventKey: `key-${id}`,
        externalId: `uuid-${id}`,
        rawFormat: opts.json ? 'json' : 'jsonl',
        rawText: opts.alreadyCleared || opts.json ? null : PAYLOAD,
        rawJson: opts.json ? { payload: PAYLOAD } : null,
        rawSha256: `sha-${id}`,
        rawBytes: PAYLOAD.length,
        parserName: 'pgtest',
        parserVersion: '1',
        parsedAt: opts.createdAt,
        rawClearedAt: opts.alreadyCleared ? opts.createdAt : null,
        createdAt: opts.createdAt,
        updatedAt: opts.createdAt
    })
}

const seedFixtures = async (h: Harness): Promise<void> => {
    await seedMessage(h, 'msg_done', { createdAt: OLD, terminal: true })
    await seedMessage(h, 'msg_no_terminal', { createdAt: OLD })
    await seedMessage(h, 'msg_exec_done', {
        createdAt: OLD,
        terminal: true,
        execState: 'done'
    })
    await seedMessage(h, 'msg_adoptable', {
        createdAt: OLD,
        execState: 'running'
    })
    await seedMessage(h, 'msg_handoff', {
        createdAt: OLD,
        execState: 'handoff'
    })
    await seedMessage(h, 'msg_adopting', {
        createdAt: OLD,
        execState: 'adopting'
    })
    await seedMessage(h, 'msg_truncated_marked', {
        createdAt: OLD,
        terminal: true,
        truncated: true
    })
    await seedMessage(h, 'msg_young', { createdAt: YOUNG, terminal: true })
    await seedMessage(h, 'msg_inflight', {
        sessionId: h.inflightSessionId,
        createdAt: OLD,
        terminal: true
    })

    // CLEARED: finished turn, well outside the window.
    await seedSource(h, 'cms_a_done', {
        messageId: 'msg_done',
        createdAt: OLD
    })
    // CLEARED: no terminal, but nothing can adopt it — no execution row.
    await seedSource(h, 'cms_b_no_terminal', {
        messageId: 'msg_no_terminal',
        createdAt: OLD
    })
    // CLEARED: the execution record exists but is closed.
    await seedSource(h, 'cms_c_exec_done', {
        messageId: 'msg_exec_done',
        createdAt: OLD
    })
    // CLEARED: rawJson is cleared on the same terms as rawText.
    await seedSource(h, 'cms_d_json', {
        messageId: 'msg_done',
        createdAt: OLD,
        json: true
    })
    // CLEARED: the message was already pruned by plan retention (message_id
    // set null by the FK); an orphan row can never be adopted.
    await seedSource(h, 'cms_e_orphan', {
        messageId: null,
        createdAt: OLD
    })
    // KEPT: an open execution row means adoption may still need this payload.
    await seedSource(h, 'cms_f_adoptable', {
        messageId: 'msg_adoptable',
        createdAt: OLD
    })
    await seedSource(h, 'cms_g_handoff', {
        messageId: 'msg_handoff',
        createdAt: OLD
    })
    await seedSource(h, 'cms_h_adopting', {
        messageId: 'msg_adopting',
        createdAt: OLD
    })
    // KEPT: content_blocks_json was truncated, so these lines are a copy of
    // output the transcript no longer holds.
    await seedSource(h, 'cms_i_truncated', {
        messageId: 'msg_truncated_marked',
        createdAt: OLD
    })
    // KEPT: inside the window.
    await seedSource(h, 'cms_j_young', {
        messageId: 'msg_young',
        createdAt: YOUNG
    })
    // KEPT: the session's turn lock still points at this message.
    await seedSource(h, 'cms_k_inflight', {
        sessionId: h.inflightSessionId,
        messageId: 'msg_inflight',
        createdAt: OLD
    })
    // Already cleared: must not be counted again.
    await seedSource(h, 'cms_l_cleared', {
        messageId: 'msg_done',
        createdAt: OLD,
        alreadyCleared: true
    })

    // ---- the plan-based route (finite retention, 30d) ----
    // Its message is deleted by the plan sweep, so this row orphans and its
    // payload goes. Positive control that plan clearing still works.
    await seedMessage(h, 'msg_plan_old', {
        sessionId: h.planSessionId,
        createdAt: OLD,
        terminal: true
    })
    await seedSource(h, 'cms_m_plan_old', {
        sessionId: h.planSessionId,
        messageId: 'msg_plan_old',
        createdAt: OLD
    })
    // The regression. Held by the session's turn lock AND carrying an open
    // execution row, so deleteMessageBatch keeps the message and adoption may
    // still need these lines. Plan-based clearing took them before the two
    // paths shared a predicate.
    await seedMessage(h, 'msg_plan_stuck', {
        sessionId: h.planStuckSessionId,
        createdAt: OLD,
        execState: 'running'
    })
    await seedSource(h, 'cms_n_plan_stuck', {
        sessionId: h.planStuckSessionId,
        messageId: 'msg_plan_stuck',
        createdAt: OLD
    })
    // The case where preview and real run invert. Truncated, so the marker
    // exemption keeps its payload while the message exists — but the message
    // is old and not inflight, so sweepUser DELETES it first, which nulls
    // message_id and makes the row an orphan that passes every exemption.
    // A preview counted against the pre-delete state promised to keep it.
    await seedMessage(h, 'msg_plan_truncated', {
        sessionId: h.planSessionId,
        createdAt: OLD,
        terminal: true,
        truncated: true
    })
    await seedSource(h, 'cms_o_plan_truncated', {
        sessionId: h.planSessionId,
        messageId: 'msg_plan_truncated',
        createdAt: OLD
    })
}

const CLEARED_IDS = [
    'cms_a_done',
    'cms_b_no_terminal',
    'cms_c_exec_done',
    'cms_d_json',
    'cms_e_orphan'
]
// Cleared by the plan-based route rather than the age-based one.
const PLAN_CLEARED_IDS = ['cms_m_plan_old', 'cms_o_plan_truncated']
const KEPT_IDS = [
    'cms_f_adoptable',
    'cms_g_handoff',
    'cms_h_adopting',
    'cms_i_truncated',
    'cms_j_young',
    'cms_k_inflight',
    'cms_n_plan_stuck'
]

const withWindow = async <T>(
    days: string | undefined,
    fn: () => Promise<T>
): Promise<T> => {
    const previous = process.env.MF_SOURCE_RAW_CLEAR_AFTER_DAYS
    if (days === undefined) delete process.env.MF_SOURCE_RAW_CLEAR_AFTER_DAYS
    else process.env.MF_SOURCE_RAW_CLEAR_AFTER_DAYS = days
    try {
        return await fn()
    } finally {
        if (previous === undefined)
            delete process.env.MF_SOURCE_RAW_CLEAR_AFTER_DAYS
        else process.env.MF_SOURCE_RAW_CLEAR_AFTER_DAYS = previous
    }
}

interface SourceState {
    id: string
    rawText: string | null
    rawJson: unknown
    rawClearedAt: Date | null
    externalId: string | null
    sourceEventKey: string
    rawSha256: string
}

const sourceStates = async (h: Harness): Promise<SourceState[]> =>
    h.db
        .select({
            id: chatMessageSources.id,
            rawText: chatMessageSources.rawText,
            rawJson: chatMessageSources.rawJson,
            rawClearedAt: chatMessageSources.rawClearedAt,
            externalId: chatMessageSources.externalId,
            sourceEventKey: chatMessageSources.sourceEventKey,
            rawSha256: chatMessageSources.rawSha256
        })
        .from(chatMessageSources)
        .orderBy(asc(chatMessageSources.id))

interface Footprint {
    rows: number
    bytes: number
    logicalBytes: number
}

// VACUUM FULL first, because an UPDATE that nulls a column only marks the old
// tuple dead — pg_total_relation_size would not move at all without it. A
// real deployment does NOT get this: autovacuum returns the space to the
// table's own free space map for reuse by later inserts, not to the OS.
// logicalBytes is the sum of raw_bytes still holding a payload, i.e. the
// figure the production measurement was taken in, before TOAST compression.
const tableFootprint = async (h: Harness): Promise<Footprint> => {
    await h.db.execute(sql.raw('vacuum full analyze chat_message_sources'))
    const result = (await h.db.execute(sql`
        select
            (select count(*) from chat_message_sources)::float8 as rows,
            pg_total_relation_size('chat_message_sources')::float8 as bytes,
            (
                select coalesce(sum(raw_bytes), 0)
                from chat_message_sources
                where raw_text is not null or raw_json is not null
            )::float8 as logical_bytes
    `)) as Array<Record<string, number | string>>
    return {
        rows: Number(result[0]?.rows ?? 0),
        bytes: Number(result[0]?.bytes ?? 0),
        logicalBytes: Number(result[0]?.logical_bytes ?? 0)
    }
}

// A corpus big enough that the footprint delta is payload, not page rounding.
// The text is random base64 on purpose: `'y'.repeat(4096)` measures pglz, not
// the sweep — a run with it reclaimed 41 kB for 2 MB of payload because TOAST
// had already compressed it to nothing.
const BULK_ROWS = 500
const bulkPayload = (i: number): string =>
    JSON.stringify({
        type: 'assistant',
        uuid: `bulk-uuid-${i}`,
        message: {
            id: `msg_${i}`,
            role: 'assistant',
            content: [
                { type: 'text', text: randomBytes(3072).toString('base64') }
            ]
        }
    })

const seedBulk = async (h: Harness): Promise<void> => {
    await seedMessage(h, 'msg_bulk', { createdAt: OLD, terminal: true })
    const rows = Array.from({ length: BULK_ROWS }, (_, i) => {
        const payload = bulkPayload(i)
        return {
            id: `cms_bulk_${String(i).padStart(4, '0')}`,
            sessionId: h.sessionId,
            messageId: 'msg_bulk',
            sourceKind: 'live_stream' as const,
            framework: 'claude-code',
            runtime: 'sprites',
            sourceSeq: i,
            sourceEventKey: `bulk-key-${i}`,
            externalId: `bulk-uuid-${i}`,
            rawFormat: 'jsonl' as const,
            rawText: payload,
            rawSha256: `bulk-sha-${i}`,
            rawBytes: payload.length,
            parserName: 'pgtest',
            parserVersion: '1',
            parsedAt: OLD,
            createdAt: OLD,
            updatedAt: OLD
        }
    })
    await h.db.insert(chatMessageSources).values(rows)
}

test(
    'age-based raw clearing keeps every row it cannot prove is unreadable',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            await seedFixtures(h)

            const result = await withWindow(undefined, () =>
                h.service.runOnce()
            )

            assert.equal(
                result.sourceRaw.rowsCleared,
                CLEARED_IDS.length,
                'exactly the rows no reader can still need'
            )
            assert.equal(result.sourceRaw.capped, false)
            assert.equal(result.sourceRaw.dryRun, false)
            assert.equal(
                result.sourcesCleared,
                PLAN_CLEARED_IDS.length,
                'the plan route cleared only its own orphaned row'
            )
            assert.equal(
                result.sourceRaw.afterDays,
                180,
                'a 30d plan cannot pull the age window below the floor'
            )

            const states = await sourceStates(h)
            assert.equal(states.length, 15, 'no row is ever deleted')
            const byId = new Map(states.map((s) => [s.id, s]))
            for (const id of [...CLEARED_IDS, ...PLAN_CLEARED_IDS]) {
                const row = byId.get(id)
                assert.ok(row, `${id} still exists`)
                assert.equal(row.rawText, null, `${id} raw_text cleared`)
                assert.equal(row.rawJson, null, `${id} raw_json cleared`)
                assert.ok(
                    row.rawClearedAt instanceof Date,
                    `${id} carries raw_cleared_at`
                )
                // The anchors every surviving reader keys off.
                assert.equal(row.externalId, `uuid-${id}`)
                assert.equal(row.sourceEventKey, `key-${id}`)
                assert.equal(row.rawSha256, `sha-${id}`)
            }
            for (const id of KEPT_IDS) {
                const row = byId.get(id)
                assert.ok(row, `${id} still exists`)
                assert.equal(row.rawClearedAt, null, `${id} not cleared`)
                assert.ok(
                    row.rawText !== null || row.rawJson !== null,
                    `${id} keeps its payload`
                )
            }

            const telemetry = h.events.find(
                ([name]) => name === 'chat.message_sources.raw_cleared'
            )
            assert.ok(telemetry, 'the sweep reports what it did')
            assert.deepEqual(telemetry[1], {
                afterDays: 180,
                rowsCleared: CLEARED_IDS.length,
                capped: false,
                dryRun: false
            })
        } finally {
            await h.drop()
        }
    }
)

test('a second run clears nothing', { skip: !RUN }, async () => {
    const h = await buildHarness()
    try {
        await seedFixtures(h)

        await withWindow(undefined, () => h.service.runOnce())
        const second = await withWindow(undefined, () => h.service.runOnce())

        assert.equal(second.sourceRaw.rowsCleared, 0)
        assert.equal(second.sourceRaw.capped, false)
        assert.equal(second.sourcesCleared, 0, 'the plan route too')
    } finally {
        await h.drop()
    }
})

test(
    'an explicit 0 window touches nothing at all',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            await seedFixtures(h)

            const result = await withWindow('0', () => h.service.runOnce())

            assert.equal(result.sourceRaw.rowsCleared, 0)
            const cleared = await h.db
                .select({ id: chatMessageSources.id })
                .from(chatMessageSources)
                .where(eq(chatMessageSources.id, 'cms_a_done'))
            assert.equal(cleared.length, 1)
            const [row] = await h.db
                .select({ rawText: chatMessageSources.rawText })
                .from(chatMessageSources)
                .where(eq(chatMessageSources.id, 'cms_a_done'))
            assert.equal(row.rawText, PAYLOAD, 'the payload is untouched')
            assert.equal(
                h.events.some(
                    ([name]) => name === 'chat.message_sources.raw_cleared'
                ),
                false,
                'an off sweep emits nothing'
            )
        } finally {
            await h.drop()
        }
    }
)

// The half of #672 this sweep must not reproduce: a dry run must count
// without writing. It walks the same keyset, so its number is exact.
test(
    'a dry run reports the exact count and writes nothing',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            await seedFixtures(h)
            const dryRunService = new ChatRetentionService(
                h.db,
                {
                    get: (key: string) =>
                        key === 'CHAT_RETENTION_DRY_RUN' ? '1' : undefined
                } as never,
                undefined,
                {
                    event: (name: string, attrs: Record<string, unknown>) =>
                        h.events.push([name, attrs])
                } as never
            )

            const result = await withWindow(undefined, () =>
                dryRunService.runOnce()
            )

            assert.equal(result.sourceRaw.dryRun, true)
            // Exactly what a real run's age phase clears, with no allowance
            // for the plan phase: the age scope excludes plan-swept owners
            // outright, so a preview cannot re-count the plan phase's rows.
            assert.equal(
                result.sourceRaw.rowsCleared,
                CLEARED_IDS.length,
                'the age preview counts only rows the age phase owns'
            )
            assert.equal(result.sourcesCleared, 0, 'the plan route too')
            const states = await sourceStates(h)
            assert.equal(
                states.filter((s) => s.rawClearedAt !== null).length,
                1,
                'only the fixture that was already cleared'
            )
        } finally {
            await h.drop()
        }
    }
)

test(
    'the reclaim is real, measured on the table itself',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            await seedBulk(h)
            const before = await tableFootprint(h)

            const result = await withWindow(undefined, () =>
                h.service.runOnce()
            )

            const after = await tableFootprint(h)
            assert.equal(result.sourceRaw.rowsCleared, BULK_ROWS)
            assert.equal(after.rows, before.rows, 'not one row is deleted')
            assert.ok(
                after.bytes < before.bytes,
                `reclaim must be real: ${before.bytes} -> ${after.bytes}`
            )
            assert.equal(after.logicalBytes, 0, 'no payload is left behind')
            // Printed rather than asserted as a ratio: the figure depends
            // on payload size and compressibility, and a threshold here
            // would be a number invented to pass.
            console.log(
                `chat_message_sources ${before.rows} rows: stored ${before.bytes} -> ${after.bytes} B, logical ${before.logicalBytes} -> ${after.logicalBytes} B`
            )
        } finally {
            await h.drop()
        }
    }
)

// The other reader of these rows. compareRecoveryRawSources sees a cleared
// row as `cleared:` not `raw:`, so it diffs as missing and the runtime
// session recovery endpoint re-imports it from the sprite transcript. That
// upsert is the difference between "degraded" and "lost": prove here that it
// really does put the payload back and retire raw_cleared_at, because the
// whole reader audit rests on it.
test(
    'runtime session recovery re-hydrates a cleared row',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            await seedFixtures(h)
            await withWindow(undefined, () => h.service.runOnce())

            const repo = new ChatRepository(h.db)
            const [before] = await h.db
                .select({
                    rawText: chatMessageSources.rawText,
                    rawClearedAt: chatMessageSources.rawClearedAt
                })
                .from(chatMessageSources)
                .where(eq(chatMessageSources.id, 'cms_a_done'))
            assert.equal(before.rawText, null)
            assert.ok(before.rawClearedAt instanceof Date)

            // What the recovery reader rebuilds from the on-disk transcript:
            // the same source_event_key, carrying the payload again.
            await repo.upsertMessageSources([
                {
                    id: 'cms_reimported',
                    sessionId: h.sessionId,
                    messageId: 'msg_done',
                    sourceKind: 'local_session_recovery',
                    framework: 'claude-code',
                    runtime: 'sprites',
                    sourceSeq: 1,
                    sourceEventKey: 'key-cms_a_done',
                    externalId: 'uuid-cms_a_done',
                    rawFormat: 'jsonl',
                    rawText: PAYLOAD,
                    rawSha256: 'sha-cms_a_done',
                    rawBytes: PAYLOAD.length,
                    parserName: 'claude-code-session-jsonl',
                    parserVersion: '1',
                    parsedAt: new Date()
                }
            ])

            const [after] = await h.db
                .select({
                    id: chatMessageSources.id,
                    rawText: chatMessageSources.rawText,
                    rawClearedAt: chatMessageSources.rawClearedAt
                })
                .from(chatMessageSources)
                .where(eq(chatMessageSources.sourceEventKey, 'key-cms_a_done'))
            assert.equal(
                after.id,
                'cms_a_done',
                'the same row, not a duplicate'
            )
            assert.equal(after.rawText, PAYLOAD, 'the payload is back')
            assert.equal(
                after.rawClearedAt,
                null,
                'and the row is no longer marked cleared'
            )
        } finally {
            await h.drop()
        }
    }
)

// The sweep is default-on and daily, so the cost of DECIDING what to clear
// matters as much as the cost of clearing it. Without an indexed access
// path it walks the primary key and filters, which grows with the table this
// change exists to bound. Pin the plan, not a timing.
test(
    'the candidate scan is served by the partial index, and stops at the cutoff',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            await seedBulk(h)
            await h.db.execute(sql.raw('analyze chat_message_sources'))
            const cutoff = new Date(Date.now() - 180 * DAY_MS).toISOString()
            const explain = async (): Promise<string> => {
                const rows = (await h.db.execute(
                    sql.raw(
                        `explain (analyze, buffers, format text) select s.id from chat_message_sources s where s.created_at < '${cutoff}'::timestamptz and (s.created_at, s.id) > ('-infinity'::timestamptz, '') and s.raw_cleared_at is null order by s.created_at, s.id limit 200`
                    )
                )) as Array<Record<string, string>>
                return rows.map((r) => Object.values(r)[0]).join('\n')
            }

            const before = await explain()
            assert.match(
                before,
                /chat_message_sources_raw_pending_idx/,
                `the partial index must drive the scan:\n${before}`
            )
            assert.doesNotMatch(before, /Seq Scan on chat_message_sources/)

            await withWindow(undefined, () => h.service.runOnce())
            await h.db.execute(sql.raw('analyze chat_message_sources'))

            // Every seeded row is now cleared, so it has left the partial
            // index: the drained probe reads a handful of pages rather than
            // re-walking the corpus.
            const after = await explain()
            const rowsRead = (plan: string): number =>
                Number(
                    /actual time=[\d.]+\.\.[\d.]+ rows=(\d+)/.exec(plan)?.[1] ??
                        -1
                )
            assert.equal(
                rowsRead(after),
                0,
                `drained probe returns nothing:\n${after}`
            )
            console.log(
                `raw-clear candidate probe, drained: ${/Buffers: shared[^\n]*/.exec(after)?.[0] ?? 'no buffer line'}`
            )
        } finally {
            await h.drop()
        }
    }
)

// A preview must not promise something the real run contradicts. sweepUser
// deletes messages BEFORE it clears sources, so a count taken against the
// pre-delete state got the truncated case exactly backwards. Compare the two
// against EACH OTHER on identical corpora, through the line an operator
// actually reads, rather than against a number written down here.
test(
    'the dry-run figure matches what a real run then clears',
    { skip: !RUN },
    async () => {
        const preview = await buildHarness()
        const real = await buildHarness()
        try {
            await seedFixtures(preview)
            await seedFixtures(real)

            const lines: string[] = []
            const dryRunService = preview.build({
                CHAT_RETENTION_DRY_RUN: '1'
            })
            ;(dryRunService as unknown as { log: { log: unknown } }).log = {
                log: (line: string) => lines.push(line),
                warn: () => {},
                error: () => {}
            } as never
            await withWindow(undefined, () => dryRunService.runOnce())

            const reported = lines
                .map((line) =>
                    /would delete (\d+) messages, clear up to (\d+) sources/.exec(
                        line
                    )
                )
                .find((match) => match !== null)
            assert.ok(reported, `no dry-run line in:\n${lines.join('\n')}`)

            const actual = await withWindow(undefined, () =>
                real.service.runOnce()
            )

            assert.equal(
                Number(reported[1]),
                actual.messagesDeleted,
                'messages: preview vs real'
            )
            assert.equal(
                Number(reported[2]),
                actual.sourcesCleared,
                'sources: preview vs real'
            )

            // And specifically the row that inverts: the preview must have
            // counted it, because the real run does clear it.
            const [truncated] = await real.db
                .select({ rawClearedAt: chatMessageSources.rawClearedAt })
                .from(chatMessageSources)
                .where(eq(chatMessageSources.id, 'cms_o_plan_truncated'))
            assert.ok(
                truncated.rawClearedAt instanceof Date,
                "the real run clears the truncated message's orphaned row"
            )
        } finally {
            await preview.drop()
            await real.drop()
        }
    }
)

// message_history_retention_days is a Postgres integer. 2147483647 is legal,
// and it makes a cutoff no JS Date can represent — whose toISOString() throws
// inside the driver. The plan-floor probe reads EVERY plan, so before the
// bound one such row, on a plan nobody is subscribed to, rejected the entire
// retention run.
test(
    'a plan window no date can represent disables the raw sweep, not the run',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            await seedFixtures(h)
            await h.db.execute(
                sql.raw(
                    `update plans set message_history_retention_days = 2147483647 where message_history_retention_days = 30`
                )
            )

            const result = await withWindow(undefined, () =>
                h.service.runOnce()
            )

            assert.equal(
                result.sourceRaw.afterDays,
                0,
                'the raw sweep stands down rather than guessing a window'
            )
            assert.equal(result.sourceRaw.rowsCleared, 0)
            // The rest of the run is untouched: the hostile plan is skipped,
            // and every other sweep still reports.
            assert.equal(
                result.messagesDeleted,
                0,
                'the out-of-range plan is skipped, not swept'
            )
            assert.ok(
                h.events.some(([name]) => name === 'chat.stream_log.size'),
                'the run completed far enough to emit the growth metric'
            )
            const survivors = await sourceStates(h)
            assert.equal(
                survivors.filter((row) => row.rawClearedAt !== null).length,
                1,
                'only the fixture that was already cleared'
            )
        } finally {
            await h.drop()
        }
    }
)

// A 36,501-day plan is odd but legal, and its cutoff is a perfectly good
// 1926 date. An earlier policy-flavoured ceiling skipped such a user from the
// message sweep entirely, so their genuinely ancient history stopped being
// deleted. The bound is a representability limit now, so they are swept.
test(
    'an odd but representable plan window is swept, not skipped',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            await seedFixtures(h)
            await h.db.execute(
                sql.raw(
                    `update plans set message_history_retention_days = 36501 where message_history_retention_days = 30`
                )
            )
            // Older than 36,501 days, so the sweep has something to do.
            await seedMessage(h, 'msg_ancient', {
                sessionId: h.planSessionId,
                createdAt: new Date(Date.now() - 40_000 * DAY_MS),
                terminal: true
            })

            const result = await withWindow(undefined, () =>
                h.service.runOnce()
            )

            assert.equal(
                result.messagesDeleted,
                1,
                'the ancient message is deleted: the plan is swept as normal'
            )
            const [gone] = await h.db
                .select({ id: chatMessages.id })
                .from(chatMessages)
                .where(eq(chatMessages.id, 'msg_ancient'))
            assert.equal(gone, undefined)
        } finally {
            await h.drop()
        }
    }
)

// The bound is only honest if the value it permits survives the whole round
// trip — JS Date, toISOString(), and the driver's timestamptz cast. Postgres
// rejects a year of 0000 and the expanded -00NNNN form outright, which is
// what actually sets the ceiling.
test(
    'the largest permitted window round-trips through the driver',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            await seedFixtures(h)

            const result = await withWindow(
                String(RETENTION_WINDOW_MAX_DAYS),
                () => h.service.runOnce()
            )

            assert.equal(result.sourceRaw.afterDays, RETENTION_WINDOW_MAX_DAYS)
            assert.equal(
                result.sourceRaw.rowsCleared,
                0,
                'nothing is that old, but the statement executed'
            )
        } finally {
            await h.drop()
        }
    }
)

test('the run cap stops the drain and reports it', { skip: !RUN }, async () => {
    const h = await buildHarness()
    try {
        await seedFixtures(h)
        // Drive the cap path without seeding 50k rows: two batches of two,
        // then the cap. Grouped on the service for exactly this reason.
        Object.assign(
            (h.service as unknown as { rawClear: Record<string, number> })
                .rawClear,
            { batchSize: 2, pauseMs: 0, maxRows: 4 }
        )

        const result = await withWindow(undefined, () => h.service.runOnce())

        assert.equal(result.sourceRaw.rowsCleared, 4)
        assert.equal(result.sourceRaw.capped, true)
        const states = await sourceStates(h)
        assert.equal(
            states.filter((s) => s.rawClearedAt !== null).length,
            7,
            'four from the cap, the pre-cleared fixture, two from the plan route'
        )
    } finally {
        await h.drop()
    }
})
