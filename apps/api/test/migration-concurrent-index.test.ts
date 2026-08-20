import 'reflect-metadata'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import {
    CONCURRENT_INDEXES,
    planConcurrentIndex
} from '../src/db/concurrent-index'

test('a fresh database skips the build: the migration creates it inline', () => {
    assert.equal(
        planConcurrentIndex({ tableExists: false, indexIsValid: null }),
        'skip_absent_table'
    )
})

test('an existing table with no such index gets the concurrent build', () => {
    assert.equal(
        planConcurrentIndex({ tableExists: true, indexIsValid: null }),
        'create'
    )
})

test('a re-run over a valid index does nothing', () => {
    assert.equal(
        planConcurrentIndex({ tableExists: true, indexIsValid: true }),
        'skip_valid'
    )
})

// IF NOT EXISTS matches on the NAME, so an index left invalid by an
// interrupted build would be skipped forever: unused by the planner, still
// maintained by every writer.
test('an invalid index is dropped and rebuilt, never skipped', () => {
    assert.equal(
        planConcurrentIndex({ tableExists: true, indexIsValid: false }),
        'rebuild_invalid'
    )
})

// The absent-table guard is what makes a fresh database safe, and it has
// to win even if a name collision reports an index already sitting there.
test('an absent table wins over any index state', () => {
    for (const indexIsValid of [null, true, false])
        assert.equal(
            planConcurrentIndex({ tableExists: false, indexIsValid }),
            'skip_absent_table'
        )
})

// The two paths must build the SAME index: this step covers existing
// databases, the migration covers fresh ones. A predicate that drifted
// between them would give the two populations different indexes.
test('every spec matches a CONCURRENTLY-free twin in a migration file', () => {
    assert.ok(CONCURRENT_INDEXES.length > 0)
    const folder = path.join(process.cwd(), 'drizzle')
    const sql = fs
        .readdirSync(folder)
        .filter((name) => name.endsWith('.sql'))
        .map((name) => fs.readFileSync(path.join(folder, name), 'utf8'))
        .join('\n')
    for (const spec of CONCURRENT_INDEXES) {
        const inline = spec.create.replace(' CONCURRENTLY', '')
        assert.ok(
            sql.includes(inline),
            `no migration creates ${spec.index} as: ${inline}`
        )
    }
})

test('every spec names the table its own statement targets', () => {
    for (const spec of CONCURRENT_INDEXES) {
        assert.ok(
            spec.create.includes(`"${spec.table}"`),
            `${spec.index} does not target ${spec.table}`
        )
        assert.ok(
            spec.create.includes(`"${spec.index}"`),
            `${spec.index} statement does not create that name`
        )
        assert.match(spec.create, /CREATE INDEX CONCURRENTLY IF NOT EXISTS/)
    }
})
