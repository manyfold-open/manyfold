import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
    CROSS_SUITE_PAIRINGS,
    discoverPgTestFiles,
    parseTapSummary,
    testRunnerArgs
} from '../scripts/run-pg-audit'

const passingTap = `TAP version 13
ok 1 - first
ok 2 - second
1..2
# tests 2
# pass 2
# fail 0
# cancelled 0
# skipped 0
# todo 0`

// #722: the audit runs files serially, so the one place cross-suite blast
// radius is proved is the concurrent pairing. A rename that quietly drops a
// pairing member would leave the runner green having proved nothing, so the
// members are checked against the files on disk here, in the default suite.
test('every cross-suite pairing names files that still exist', () => {
    assert.ok(CROSS_SUITE_PAIRINGS.length > 0)
    const discovered = new Set(
        discoverPgTestFiles(path.join(process.cwd(), 'test')).map((file) =>
            path.relative(process.cwd(), file)
        )
    )
    for (const pairing of CROSS_SUITE_PAIRINGS) {
        assert.ok(pairing.length >= 2, pairing.join(' + '))
        for (const member of pairing)
            assert.ok(discovered.has(member), `${member} is not discoverable`)
    }
})

test('pairings force one worker per file and terminate completed children', () => {
    const files = ['test/retention.pg.test.ts', 'test/neighbour.pg.test.ts']
    assert.deepEqual(testRunnerArgs(files), [
        '--import',
        'tsx',
        '--test',
        '--test-concurrency=2',
        '--test-force-exit',
        '--test-reporter=tap',
        ...files
    ])
})

test('TAP validation rejects skips and accepts a complete file', () => {
    assert.deepEqual(parseTapSummary(passingTap, 'good.pg.test.ts'), {
        tests: 2,
        pass: 2,
        fail: 0,
        cancelled: 0,
        skipped: 0,
        todo: 0
    })
    assert.throws(
        () =>
            parseTapSummary(
                passingTap
                    .replace('# pass 2', '# pass 1')
                    .replace('# skipped 0', '# skipped 1'),
                'skipped.pg.test.ts'
            ),
        /incomplete TAP result/
    )
})

test('PostgreSQL discovery is sorted and excludes deterministic tests', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyfold-pg-audit-'))
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    fs.writeFileSync(path.join(dir, 'z.pg.test.ts'), '')
    fs.writeFileSync(path.join(dir, 'a.pg.test.ts'), '')
    fs.writeFileSync(path.join(dir, 'unit.test.ts'), '')

    assert.deepEqual(
        discoverPgTestFiles(dir).map((file) => path.basename(file)),
        ['a.pg.test.ts', 'z.pg.test.ts']
    )
})
