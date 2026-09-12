import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { forceExitFailures } from './check-force-exit.mjs'

const fixture = (t, files) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manyfold-force-exit-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    for (const [file, source] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
        fs.writeFileSync(path.join(root, file), source)
    }
    return root
}

test('accepts natural test exits without a baseline or git checkout', (t) => {
    const root = fixture(t, {
        'package.json': JSON.stringify({ scripts: { test: 'node --test' } }),
        '.github/workflows/ci.yml': 'run: node --test test/*.test.ts',
        'oss/apps/api/test/nested/example.pg.test.ts':
            "import test from 'node:test'"
    })
    assert.deepEqual(forceExitFailures(root), [])
})

for (const [file, source] of Object.entries({
    '.github/workflows/ci.yml':
        'run: node --test --test-force-exit test/*.test.ts',
    'oss/.github/workflows/ci.yml':
        'run: node --test --test-force-exit test/one.test.ts',
    'oss/apps/api/scripts/run-pg-audit.ts':
        "const argv = ['--test', '--test-force-exit']",
    'apps/api-cloud/test/nested/example.pg.test.ts':
        '// node --test --test-force-exit',
    'oss/apps/api/test/nested/example.pg.test.ts':
        '// node --test --test-force-exit',
    'scripts/nested/run.sh': 'node --test --test-force-exit',
    'oss/packages/db/package.json': JSON.stringify({
        scripts: { test: 'node --test --test-force-exit' }
    }),
    'package.json': JSON.stringify({
        scripts: { test: 'node --test --test-force-exit' }
    }),
    justfile: 'test:\n    node --test --test-force-exit'
})) {
    test(`rejects forced exits in ${file}`, (t) => {
        const root = fixture(t, { [file]: source })
        const failures = forceExitFailures(root)
        assert.equal(failures.length, 1)
        assert.ok(failures[0].startsWith(`${file}:`))
        assert.match(failures[0], /is forbidden/)
    })
}

test('ignores dependency, build output and only the checker fixtures', (t) => {
    const root = fixture(t, {
        'oss/apps/api/node_modules/example/index.js': '--test-force-exit',
        'oss/apps/api/dist/test.js': '--test-force-exit',
        'scripts/check-force-exit.mjs': '--test-force-exit',
        'scripts/check-force-exit.test.mjs': '--test-force-exit',
        'oss/scripts/check-force-exit.mjs': '--test-force-exit',
        'oss/scripts/check-force-exit.test.mjs': '--test-force-exit'
    })
    assert.deepEqual(forceExitFailures(root), [])
})

test('a stale baseline cannot license a forced exit', (t) => {
    const root = fixture(t, {
        'config/force-exit-baseline.txt': 'apps/api/test/old.pg.test.ts\n',
        'apps/api/test/old.pg.test.ts': '// node --test --test-force-exit'
    })
    assert.equal(forceExitFailures(root).length, 1)
})
