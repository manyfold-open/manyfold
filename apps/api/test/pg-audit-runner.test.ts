import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { parse } from 'yaml'

import { CROSS_SUITE_PAIRINGS } from '../scripts/run-pg-audit'
import {
    discoverPgTestFiles,
    parseTapSummary,
    testRunnerArgs
} from '../scripts/pg-test-runner'
import { runPgTests } from '../scripts/run-pg-tests'

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
    fs.mkdirSync(path.join(dir, 'domain'))
    fs.writeFileSync(path.join(dir, 'domain', 'nested.pg.test.ts'), '')

    assert.deepEqual(
        discoverPgTestFiles(dir).map((file) => path.relative(dir, file)),
        ['a.pg.test.ts', 'domain/nested.pg.test.ts', 'z.pg.test.ts']
    )
})

test('the required runner executes nested files, rejects skipped files and requires opt-in', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-nested-'))
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    fs.mkdirSync(path.join(dir, 'nested'))
    const nested = path.join(dir, 'nested', 'witness.pg.test.ts')
    fs.writeFileSync(
        nested,
        "import test from 'node:test'\ntest('nested witness actually executed', () => {})\n"
    )
    fs.writeFileSync(
        path.join(dir, 'unit.test.ts'),
        "throw new Error('must not execute unit fixture')"
    )
    const run = (enabled: boolean) =>
        spawnSync(
            process.execPath,
            ['--import', 'tsx', 'scripts/run-pg-tests.ts', dir],
            {
                cwd: process.cwd(),
                encoding: 'utf8',
                env: { ...process.env, RUN_PG_E2E: enabled ? '1' : '' }
            }
        )
    assert.equal(typeof runPgTests, 'function')
    const passed = run(true)
    assert.equal(passed.status, 0, passed.stderr + passed.stdout)
    assert.match(passed.stdout, /nested witness actually executed/)
    assert.equal(parseTapSummary(passed.stdout, 'nested').tests, 1)
    assert.equal(run(false).status, 1)
    fs.writeFileSync(
        nested,
        "import test from 'node:test'\ntest('dormant', { skip: true }, () => {})\n"
    )
    const skipped = run(true)
    assert.equal(skipped.status, 1)
    assert.match(skipped.stderr, /incomplete TAP result/)
    assert.ok(
        testRunnerArgs([nested, nested], 1).includes('--test-concurrency=1')
    )
})

test('the required workflow invokes the recursive runner under the sealed environment wrapper', () => {
    const workflow = parse(
        fs.readFileSync(
            path.join(process.cwd(), '../../.github/workflows/ci.yml'),
            'utf8'
        )
    )
    const step = workflow.jobs['pg-tests'].steps.find(
        (step: { name?: string }) => step.name === 'Run pg suites'
    )
    assert.ok(step)
    assert.equal(step.env.RUN_PG_E2E, '1')
    assert.equal(step.env.PG_TEST_SCRATCH, '1')
    assert.match(
        step.run,
        /test-sealed-env\.mjs -- node --import tsx scripts\/run-pg-tests\.ts/
    )
    assert.doesNotMatch(step.run, /test\/\*\.pg\.test/)
    const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'))
    assert.equal(
        manifest.scripts['test:pg:audit'],
        'tsx scripts/run-pg-audit.ts'
    )
})
