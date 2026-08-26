import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
    AGENT_CLIS,
    DOTENV_PATH_VAR,
    LOG_VAR,
    sealedEnv,
    writeSentinels
} from './test-sealed-env.mjs'

const wrapper = fileURLToPath(new URL('./test-sealed-env.mjs', import.meta.url))

// The probe runs from a temp directory so it can carry a decoy .env, which
// leaves it outside the workspace's module resolution — hence the absolute
// specifier.
const dotenvConfig = createRequire(import.meta.url).resolve('dotenv/config')

const box = (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyfold-sealed-env-'))
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    return dir
}

test('drops every shape of ambient credential', () => {
    const { env, stripped } = sealedEnv({
        OPENAI_API_KEY: 'sk-1',
        ANTHROPIC_AUTH_TOKEN: 'sk-2',
        AWS_SECRET_ACCESS_KEY: 'sk-3',
        STRIPE_SECRET_KEY: 'sk-4',
        POSTGRES_PASSWORD: 'pw',
        MF_A2A_BEARER: 'tok',
        API_CRYPTO_KEY: 'k',
        PATH: '/usr/bin'
    })

    assert.deepEqual(stripped, [
        'ANTHROPIC_AUTH_TOKEN',
        'API_CRYPTO_KEY',
        'AWS_SECRET_ACCESS_KEY',
        'MF_A2A_BEARER',
        'OPENAI_API_KEY',
        'POSTGRES_PASSWORD',
        'STRIPE_SECRET_KEY'
    ])
    assert.equal(env.PATH, '/usr/bin')
    for (const name of stripped) assert.equal(name in env, false)
})

// None of these IS a credential, so the suffix rules do not see them, but each
// one names or opens one.
test('drops the brokers that hand out a credential without being one', () => {
    const { env, stripped } = sealedEnv({
        SSH_AUTH_SOCK: '/tmp/agent.sock',
        KUBECONFIG: '/home/dev/.kube/config',
        DOCKER_AUTH_CONFIG: '{"auths":{}}',
        DOCKER_CONFIG: '/home/dev/.docker',
        AWS_PROFILE: 'prod',
        AWS_SHARED_CREDENTIALS_FILE: '/home/dev/.aws/credentials',
        AWS_CONFIG_FILE: '/home/dev/.aws/config',
        GOOGLE_APPLICATION_CREDENTIALS: '/home/dev/gcp.json',
        NPM_CONFIG_USERCONFIG: '/home/dev/.npmrc',
        GH_TOKEN: 'gho_1',
        GITHUB_TOKEN: 'ghs_1',
        NETRC: '/home/dev/.netrc',
        PATH: '/usr/bin'
    })

    assert.deepEqual(stripped, [
        'AWS_CONFIG_FILE',
        'AWS_PROFILE',
        'AWS_SHARED_CREDENTIALS_FILE',
        'DOCKER_AUTH_CONFIG',
        'DOCKER_CONFIG',
        'GH_TOKEN',
        'GITHUB_TOKEN',
        'GOOGLE_APPLICATION_CREDENTIALS',
        'KUBECONFIG',
        'NETRC',
        'NPM_CONFIG_USERCONFIG',
        'SSH_AUTH_SOCK'
    ])
    assert.deepEqual(Object.keys(env).sort(), ['PATH', 'TZ'])
})

test('points dotenv at the file it is given', () => {
    const { env } = sealedEnv(
        { PATH: '/usr/bin' },
        { dotenvPath: '/tmp/box/empty.env' }
    )

    assert.equal(env[DOTENV_PATH_VAR], '/tmp/box/empty.env')
})

// The suites need these; the seal must never be able to take them away.
test('keeps what the suites actually run on, and pins the clock', () => {
    const { env, stripped } = sealedEnv({
        DATABASE_URL: 'postgres://localhost/scratch',
        RUN_PG_E2E: '1',
        PG_TEST_SCRATCH: '1',
        PG_TEST_ADMIN_URL:
            'postgres://postgres:postgres@127.0.0.1:5432/postgres',
        TEST_SHARD: '2/4',
        CI: 'true',
        HOME: '/home/runner',
        TMPDIR: '/tmp',
        NODE_OPTIONS: '--no-warnings',
        PATH: '/usr/bin',
        TZ: 'Europe/London'
    })

    assert.deepEqual(stripped, [])
    assert.equal(env.DATABASE_URL, 'postgres://localhost/scratch')
    assert.equal(env.RUN_PG_E2E, '1')
    assert.equal(env.PG_TEST_SCRATCH, '1')
    assert.ok(env.PG_TEST_ADMIN_URL)
    assert.equal(env.TEST_SHARD, '2/4')
    assert.equal(env.TZ, 'UTC')
})

test('puts the sentinel directory ahead of the inherited PATH', () => {
    const { env } = sealedEnv(
        { PATH: '/usr/bin:/bin' },
        { sentinelDir: '/tmp/sentinels', logFile: '/tmp/log' }
    )

    assert.equal(env.PATH, `/tmp/sentinels${path.delimiter}/usr/bin:/bin`)
    assert.equal(env[LOG_VAR], '/tmp/log')
})

test('sentinels cover every framework CLI the daemon spawns by name', (t) => {
    const dir = writeSentinels(path.join(box(t), 'bin'))

    assert.deepEqual(
        fs.readdirSync(dir).sort(),
        [...AGENT_CLIS].sort(),
        'apps/cli/src/daemon/detect.ts BINARY_FOR_FRAMEWORK is the source list'
    )
    // Not trapped on purpose: the suites resolve these for real.
    for (const name of ['node', 'bash', 'sh', 'npm', 'curl', 'tar', 'mf'])
        assert.equal(fs.existsSync(path.join(dir, name)), false)
})

// The whole point: a run that reaches a real agent CLI must fail, even when
// the code under test swallows the non-zero exit.
test('fails the run when a swallowed spawn reaches an agent CLI', (t) => {
    const dir = box(t)
    const probe = path.join(dir, 'probe.mjs')
    fs.writeFileSync(
        probe,
        [
            "import { spawnSync } from 'node:child_process'",
            "spawnSync('codex', ['--version'], { stdio: 'ignore' })",
            "console.log('the caller ignored the failure')"
        ].join('\n')
    )

    assert.throws(
        () =>
            execFileSync(
                process.execPath,
                [wrapper, '--', process.execPath, probe],
                { encoding: 'utf8', stdio: 'pipe' }
            ),
        (error) => {
            assert.equal(error.status, 1)
            assert.match(error.stderr, /reached a real agent CLI/)
            assert.match(error.stderr, /- codex --version/)
            return true
        }
    )
})

// A test that plants its own stub has to keep winning, or sealing the
// environment would break the suites it is meant to protect.
test('a stub the caller prepends still shadows the sentinel', (t) => {
    const dir = box(t)
    const stubDir = path.join(dir, 'stub')
    fs.mkdirSync(stubDir)
    fs.writeFileSync(path.join(stubDir, 'claude'), '#!/bin/sh\necho stubbed\n')
    fs.chmodSync(path.join(stubDir, 'claude'), 0o755)

    const probe = path.join(dir, 'probe.mjs')
    fs.writeFileSync(
        probe,
        [
            "import { execFileSync } from 'node:child_process'",
            'const stubDir = process.argv[2]',
            "const out = execFileSync('claude', [], {",
            "    encoding: 'utf8',",
            '    env: { ...process.env, PATH: `${stubDir}:${process.env.PATH}` }',
            '})',
            'process.stdout.write(out)'
        ].join('\n')
    )

    const out = execFileSync(
        process.execPath,
        [wrapper, '--', process.execPath, probe, stubDir],
        { encoding: 'utf8' }
    )

    assert.match(out, /stubbed/)
})

// Many PostgreSQL tests `import 'dotenv/config'` at module top. On a developer
// checkout that reads apps/api/.env and puts back exactly what was stripped, so
// the seal has to survive the import rather than merely precede it.
test('an inherited .env cannot put a stripped credential back', (t) => {
    const dir = box(t)
    fs.writeFileSync(
        path.join(dir, '.env'),
        'OPENAI_API_KEY=leaked-from-dotenv\nDECOY_PLAIN=decoy\n'
    )
    const probe = path.join(dir, 'probe.mjs')
    fs.writeFileSync(
        probe,
        [
            `import ${JSON.stringify(pathToFileURL(dotenvConfig).href)}`,
            'process.stdout.write(',
            '    JSON.stringify({',
            '        key: process.env.OPENAI_API_KEY ?? null,',
            '        decoy: process.env.DECOY_PLAIN ?? null',
            '    })',
            ')'
        ].join('\n')
    )

    const out = execFileSync(
        process.execPath,
        [wrapper, '--', process.execPath, probe],
        {
            encoding: 'utf8',
            cwd: dir,
            env: { ...process.env, OPENAI_API_KEY: 'sk-ambient' }
        }
    )

    assert.deepEqual(JSON.parse(out.slice(out.indexOf('{'))), {
        key: null,
        decoy: null
    })
})

test('passes the command exit code through', (t) => {
    const dir = box(t)
    const probe = path.join(dir, 'probe.mjs')
    fs.writeFileSync(probe, 'process.exit(7)')

    assert.throws(
        () =>
            execFileSync(
                process.execPath,
                [wrapper, '--', process.execPath, probe],
                { stdio: 'pipe' }
            ),
        (error) => error.status === 7
    )
})
