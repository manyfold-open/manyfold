import test from 'node:test'
import assert from 'node:assert/strict'
import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import {
    isRepresentableWindowDays,
    RETENTION_WINDOW_MAX_DAYS
} from '../src/modules/chat-retention/retention-window'
import { resolveCompactAfterDays } from '../src/modules/chat-retention/stream-log-compaction'
import {
    INITIAL_RAW_CLEAR_CURSOR,
    rawClearCutoff,
    rawClearStatement,
    resolveEffectiveRawClearDays,
    resolveRawClearWindow,
    SOURCE_RAW_CLEAR_FLOOR_DAYS
} from '../src/modules/chat-retention/source-raw-retention'

// The knob's semantics are the whole safety story for a sweep that destroys
// payloads with no env set: a garbage value must not be able to turn it ON at
// a window nobody chose, and no value may pull the window below what this
// database's own plans promise.

test('an unset window falls back to the seeded floor', () => {
    for (const raw of [undefined, '', '   '])
        assert.deepEqual(resolveRawClearWindow(raw), {
            days: SOURCE_RAW_CLEAR_FLOOR_DAYS,
            invalid: false
        })
})

test('an explicit non-positive value is off, and is not an error', () => {
    for (const raw of ['0', '-1'])
        assert.deepEqual(resolveRawClearWindow(raw), {
            days: 0,
            invalid: false
        })
})

// Fail closed: the failure that matters is a typo silently ENABLING a clear,
// not one silently disabling it.
test('an unparseable value disables the sweep and is flagged', () => {
    for (const raw of ['18O', 'off', 'yes', 'NaN'])
        assert.deepEqual(
            resolveRawClearWindow(raw),
            { days: 0, invalid: true },
            `${raw} must not be read as a window`
        )
})

test('a sub-floor window is clamped up, never honoured', () => {
    for (const raw of ['1', '90', String(SOURCE_RAW_CLEAR_FLOOR_DAYS - 1)])
        assert.equal(
            resolveRawClearWindow(raw).days,
            SOURCE_RAW_CLEAR_FLOOR_DAYS
        )
})

// 2147483647 is a legal Postgres integer, and a cutoff that far back is an
// Invalid Date whose toISOString() throws.
test('a window no date can represent is rejected, not clamped', () => {
    assert.deepEqual(resolveRawClearWindow('2147483647'), {
        days: 0,
        invalid: true
    })
    assert.deepEqual(resolveRawClearWindow(String(RETENTION_WINDOW_MAX_DAYS)), {
        days: RETENTION_WINDOW_MAX_DAYS,
        invalid: false
    })
    assert.equal(isRepresentableWindowDays(2147483647), false)
    assert.equal(isRepresentableWindowDays(Number.NaN), false)
    assert.equal(isRepresentableWindowDays(RETENTION_WINDOW_MAX_DAYS), true)
    assert.equal(isRepresentableWindowDays(0), true)
})

// The bound is representability, not policy. An odd-but-legal plan window has
// a perfectly good cutoff, and rejecting it would stop sweeping that user.
test('an odd but representable window is allowed through', () => {
    assert.equal(isRepresentableWindowDays(36_501), true)
    assert.equal(isRepresentableWindowDays(100_000), true)
    assert.deepEqual(resolveRawClearWindow('36501'), {
        days: 36_501,
        invalid: false
    })
})

// The compaction knob had the same hole: 2147483647 reached compactionCutoff
// and threw on toISOString() inside the candidate query. `0` is already this
// knob's answer to anything it cannot read.
test('the compaction knob rejects a window no date can represent', () => {
    assert.equal(resolveCompactAfterDays('2147483647'), 0)
    assert.equal(
        resolveCompactAfterDays(String(RETENTION_WINDOW_MAX_DAYS)),
        RETENTION_WINDOW_MAX_DAYS
    )
    assert.equal(resolveCompactAfterDays('36501'), 36_501)
    assert.equal(resolveCompactAfterDays('30'), 30)
})

// Every value the resolver calls valid must survive the arithmetic that turns
// it into a cutoff.
test('every accepted window produces a real date', () => {
    const now = new Date('2026-08-10T00:00:00.000Z')
    for (const raw of ['180', '365', '3650', String(RETENTION_WINDOW_MAX_DAYS)])
        assert.doesNotThrow(() =>
            rawClearCutoff(now, resolveRawClearWindow(raw).days).toISOString()
        )
})

test('a wider window is honoured and truncated to whole days', () => {
    assert.equal(resolveRawClearWindow('365').days, 365)
    assert.equal(resolveRawClearWindow('365.9').days, 365)
})

// The seeded 180 is what OUR plans table says; someone else's may promise
// more, and the sweep has to follow theirs.
test('the live plan floor widens the window but never narrows it', () => {
    assert.equal(resolveEffectiveRawClearDays(180, 3650), 3650)
    assert.equal(resolveEffectiveRawClearDays(365, 180), 365)
    assert.equal(resolveEffectiveRawClearDays(180, 0), 180)
})

test('off stays off however generous the plans table is', () => {
    assert.equal(resolveEffectiveRawClearDays(0, 3650), 0)
})

test('the cutoff is the window measured back from now', () => {
    const now = new Date('2026-08-09T00:00:00.000Z')
    assert.equal(
        rawClearCutoff(now, 180).toISOString(),
        '2026-02-10T00:00:00.000Z'
    )
})

const dialect = new PgDialect()
const render = (node: SQL): string => dialect.sqlToQuery(node).sql
// Everything the candidate CTE selects on, i.e. the decision itself, with the
// locking clause and the update arm left out.
const candidatePredicate = (sql: string): string =>
    /with candidate as \(([\s\S]*?)order by s\.created_at/.exec(sql)?.[1] ??
    'NO CANDIDATE CTE'
const AGE = {
    kind: 'age' as const,
    cutoff: new Date('2026-02-10T00:00:00.000Z'),
    after: INITIAL_RAW_CLEAR_CURSOR
}

// Selection and write are one statement so nothing can change between them,
// and the update repeats the predicate so the count is rows written rather
// than rows a stale select liked. Both are invisible in a fake db, so pin the
// SQL text.
test('the update re-checks every exemption the candidate scan applied', () => {
    const sql = render(rawClearStatement(AGE, 200, true))
    const guards = [
        /update "chat_message_sources" u/,
        /u\.raw_cleared_at is null/,
        /where cs\.id = u\.session_id/,
        /where m\.id = u\.message_id/,
        /where te\.message_id = u\.message_id/
    ]
    for (const guard of guards)
        assert.match(sql, guard, `update arm is missing ${guard}`)
    assert.equal(
        sql.split('with candidate as').length - 1,
        1,
        'one statement, so there is no window between check and write'
    )
})

test('a dry run renders the same scan with no update arm at all', () => {
    const sql = render(rawClearStatement(AGE, 200, false))
    assert.doesNotMatch(sql, /update "chat_message_sources"/)
    assert.match(sql, /from "chat_message_sources" s/)
})

// The cursor has to page the same order the partial index stores, or the
// planner falls back to the primary key and the scan cannot stop at the
// cutoff.
test('the scan pages and orders on (created_at, id)', () => {
    const sql = render(rawClearStatement(AGE, 200, true))
    assert.match(sql, /\(s\.created_at, s\.id\) >/)
    assert.match(sql, /order by s\.created_at, s\.id/)
    assert.match(sql, /for update of s skip locked/)
})

test('the plan scope filters by owner instead of by cursor', () => {
    const sql = render(
        rawClearStatement(
            { kind: 'plan', cutoff: AGE.cutoff, userId: 'user_1' },
            200,
            true
        )
    )
    assert.match(sql, /owner\.user_id = \$/)
    assert.doesNotMatch(sql, /\(s\.created_at, s\.id\) >/)
    // Same exemptions as the age scope: one predicate, two callers.
    assert.match(sql, /where te\.message_id = s\.message_id/)
    assert.match(sql, /cs\.inflight_message_id = s\.message_id/)
})

// Only the plan phase deletes before it clears, so only its preview models
// anything. A preview never locks, because it must not block a live writer.
test('only the plan preview models deletes, and no preview locks', () => {
    const plan = { kind: 'plan' as const, cutoff: AGE.cutoff, userId: 'u1' }
    assert.match(
        candidatePredicate(render(rawClearStatement(plan, 200, false))),
        /dm\.created_at </,
        'the plan preview models the deletes that precede its clear'
    )
    assert.doesNotMatch(
        candidatePredicate(render(rawClearStatement(AGE, 200, false))),
        /dm\.created_at </,
        'the age preview has no deletes to model'
    )
    for (const scope of [AGE, plan]) {
        assert.doesNotMatch(
            render(rawClearStatement(scope, 200, false)),
            /for update/
        )
        assert.match(
            render(rawClearStatement(scope, 200, true)),
            /for update of s skip locked/
        )
    }
})

// C: the preview must decide with the cutoff the run captured, not re-derive
// one from the live plans table and database now().
test('the plan preview binds the captured cutoff, not a fresh one', () => {
    const cutoff = new Date('2026-07-11T00:00:00.000Z')
    const preview = render(
        rawClearStatement({ kind: 'plan', cutoff, userId: 'u1' }, 200, false)
    )
    assert.doesNotMatch(preview, /make_interval/)
    assert.doesNotMatch(preview, /now\(\)/)
    assert.match(preview, /dm\.created_at < \$/)
    // deleteMessageBatch's own predicate, on the same instant.
    assert.match(preview, /dm\.id is distinct from dcs\.inflight_message_id/)
})

// D: the phases are disjoint by predicate rather than by timing, so the age
// preview cannot re-count rows the plan phase owns — and preview and run pick
// the same rows instead of two sets that merely usually agree.
test('the age scope excludes owners the plan phase sweeps', () => {
    for (const apply of [true, false])
        assert.match(
            candidatePredicate(render(rawClearStatement(AGE, 200, apply))),
            /pp\.message_history_retention_days > 0/,
            `apply=${apply} must exclude plan-swept owners`
        )
    assert.equal(
        candidatePredicate(render(rawClearStatement(AGE, 200, false))),
        candidatePredicate(render(rawClearStatement(AGE, 200, true))),
        'the age preview and its real run select on identical terms'
    )
})
