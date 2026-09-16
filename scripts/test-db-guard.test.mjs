import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const api = path.join(
    root,
    fs.existsSync(path.join(root, 'oss/apps/api/package.json'))
        ? 'oss/apps/api'
        : 'apps/api'
)
const wrapper = fileURLToPath(new URL('./test-sealed-env.mjs', import.meta.url))
const executable = process.env.SEALED_TEST_NODE_BINARY || process.execPath
const target = 'postgres://fixture:fixture@127.0.0.1:1/never_open'

function probe(
    t,
    files,
    entry,
    { pg = false, tsx = false, testRunner = false } = {}
) {
    const dir = fs.mkdtempSync(path.join(api, 'test/.db-guard-'))
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    for (const [name, source] of Object.entries(files))
        fs.writeFileSync(path.join(dir, name), source)
    const env = { ...process.env, RUN_PG_E2E: pg ? '1' : '' }
    delete env.MF_TEST_DB_MODE
    delete env.MF_TEST_DB_LOG
    delete env.MF_TEST_PG_PARENT
    delete env.NODE_TEST_CONTEXT
    return spawnSync(
        executable,
        [
            wrapper,
            '--',
            executable,
            ...(tsx ? ['--import', 'tsx'] : []),
            ...(testRunner ? ['--test'] : []),
            ...[entry].flat().map((file) => path.join(dir, file))
        ],
        {
            cwd: api,
            env,
            encoding: 'utf8',
            timeout: 30_000
        }
    )
}

for (const [name, entry, source, tsx] of [
    [
        'ESM',
        'entry.mjs',
        `import postgres from 'postgres'; const alias = postgres; try { alias('${target}') } catch { console.log('swallowed') }`,
        false
    ],
    [
        'CommonJS',
        'entry.cjs',
        `const postgres = require('postgres'); const { default: alias = postgres } = postgres; try { alias('${target}') } catch { console.log('swallowed') }`,
        false
    ],
    [
        'tsx CommonJS',
        'entry.ts',
        `import postgres from 'postgres'; const open: typeof postgres = postgres; try { open('${target}') } catch { console.log('swallowed') }`,
        true
    ],
    [
        'namespace bracket',
        'entry.mjs',
        `import * as pg from 'postgres'; try { pg['default']('${target}') } catch { console.log('swallowed') }`,
        false
    ],
    [
        'conditional returned factory',
        'entry.mjs',
        `import postgres from 'postgres'; const pick = () => process.pid ? postgres : () => {}; try { pick()('${target}') } catch { console.log('swallowed') }`,
        false
    ],
    [
        'conditional factory alias',
        'entry.mjs',
        `import postgres from 'postgres'; let open = () => {}; if (process.pid) open = postgres; try { open('${target}') } catch { console.log('swallowed') }`,
        false
    ],
    [
        'constructor property',
        'entry.ts',
        `import postgres from 'postgres'; class Helper { constructor(public connect = postgres) {} open() { this.connect('${target}') } }; try { new Helper().open() } catch { console.log('swallowed') }`,
        true
    ],
    [
        'bound factory',
        'entry.mjs',
        `import postgres from 'postgres'; const open = postgres.bind(null, '${target}'); try { open() } catch { console.log('swallowed') }`,
        false
    ],
    [
        'dynamic import',
        'entry.mjs',
        `const name = ['post', 'gres'].join(''); try { (await import(name)).default('${target}') } catch { console.log('swallowed') }`,
        false
    ],
    [
        'import continuation',
        'entry.mjs',
        `await import('postgres').then(({ default: open }) => { try { open('${target}') } catch { console.log('swallowed') } })`,
        false
    ],
    [
        'late opt-in mutation',
        'entry.mjs',
        `import postgres from 'postgres'; process.env.RUN_PG_E2E = '1'; try { postgres('${target}') } catch { console.log('swallowed') }`,
        false
    ]
])
    test(
        'sealed runner rejects ' + name + ' database access even when caught',
        (t) => {
            const result = probe(t, { [entry]: source }, entry, { tsx })
            assert.equal(result.status, 1, result.stderr + result.stdout)
            assert.match(result.stdout, /swallowed/)
            assert.match(result.stderr, /forbidden database or dotenv entry/)
            assert.match(result.stderr, /postgres database factory/)
        }
    )

test('a transitive local helper cannot connect during module loading', (t) => {
    const result = probe(
        t,
        {
            'entry.mjs':
                "try { await import('./outer.mjs') } catch { console.log('swallowed') }",
            'outer.mjs': "import './inner.mjs'",
            'inner.mjs': `import postgres from 'postgres'; postgres('${target}')`
        },
        'entry.mjs'
    )
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stdout, /swallowed/)
    assert.match(result.stderr, /postgres database factory/)
})

test('pure imports, dormant bound factories and injected fakes remain valid', (t) => {
    const result = probe(
        t,
        {
            'entry.mjs':
                "import { helper, dormant } from './helper.mjs'; if (!helper(() => ({ fake: true })).fake) throw Error('bad fake'); void dormant; console.log('fake passed')",
            'helper.mjs': `import postgres from 'postgres'; export const dormant = postgres.bind(null, '${target}'); export const helper = (connect = postgres) => connect('${target}')`
        },
        'entry.mjs'
    )
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /fake passed/)
})

test('explicit PG opt-in allows the driver factory without creating a network connection', (t) => {
    const result = probe(
        t,
        {
            'entry.pg.test.mjs': `import postgres from 'postgres'; const sql = postgres('${target}'); await sql.end(); console.log('PG allowed')`
        },
        'entry.pg.test.mjs',
        { pg: true }
    )
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /PG allowed/)
})

test('an ordinary test remains denied when the surrounding run opts into PG', (t) => {
    const result = probe(
        t,
        {
            'entry.test.mjs':
                "import { connect } from './helper.mjs'; try { connect() } catch { console.log('swallowed') }",
            'helper.mjs': `import postgres from 'postgres'; export const connect = () => postgres('${target}')`
        },
        'entry.test.mjs',
        { pg: true }
    )
    assert.equal(result.status, 1, result.stderr + result.stdout)
    assert.match(result.stdout, /swallowed/)
    assert.match(result.stderr, /postgres database factory/)
})

test('a mixed opt-in Node test run allows PG children but denies ordinary children', (t) => {
    const result = probe(
        t,
        {
            'ordinary.test.mjs': `import test from 'node:test'; import postgres from 'postgres'; test('ordinary', () => { try { postgres('${target}') } catch { console.log('ordinary swallowed') } })`,
            'allowed.pg.test.mjs': `import test from 'node:test'; import postgres from 'postgres'; test('PG', async () => { const sql = postgres('${target}'); await sql.end(); console.log('PG allowed') })`
        },
        ['ordinary.test.mjs', 'allowed.pg.test.mjs'],
        { pg: true, testRunner: true }
    )
    assert.equal(result.status, 1, result.stderr + result.stdout)
    assert.match(result.stdout, /ordinary swallowed/)
    assert.match(result.stdout, /PG allowed/)
    assert.equal(result.stderr.match(/- postgres database factory/g)?.length, 1)
})

test('direct dotenv.config cannot reload a local file outside the seal', (t) => {
    const result = probe(
        t,
        {
            'entry.mjs':
                "import { config } from 'dotenv'; try { config({ path: new URL('./decoy.env', import.meta.url).pathname }) } catch { console.log('swallowed') } if (process.env.MF_DECOY) throw Error('dotenv escaped')",
            'decoy.env': 'MF_DECOY=should-not-load\n'
        },
        'entry.mjs'
    )
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stdout, /swallowed/)
    assert.match(result.stderr, /dotenv.config outside the sealed empty file/)
    assert.doesNotMatch(result.stderr, /dotenv escaped/)
})

test('loopback HTTP fixtures are unaffected by the database guard', (t) => {
    const result = probe(
        t,
        {
            'entry.mjs':
                "import http from 'node:http'; const server = http.createServer((_q,r) => r.end('ok')); await new Promise(r => server.listen(0, '127.0.0.1', r)); try { const body = await (await fetch('http://127.0.0.1:' + server.address().port)).text(); if (body !== 'ok') throw Error('bad HTTP'); } finally { await new Promise(r => server.close(r)); }"
        },
        'entry.mjs'
    )
    assert.equal(result.status, 0, result.stderr)
})
