import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
    MANIFESTS,
    compareVersions,
    findPluginVersionFailures,
    isShipped,
    parseVersion
} from './check-plugin-version.mjs'

const SCRIPT = fileURLToPath(
    new URL('./check-plugin-version.mjs', import.meta.url)
)
const SKILL = 'plugins/manyfold/skills/manyfold-cli-usage/SKILL.md'
const both = (version) =>
    Object.fromEntries(MANIFESTS.map((file) => [file, version]))

test('versions compare by semver precedence, ignoring build metadata', () => {
    assert.equal(compareVersions('0.2.0', '0.1.0+codex.20260923204859'), 1)
    assert.equal(compareVersions('0.1.0+codex.2', '0.1.0+codex.1'), 0)
    assert.equal(compareVersions('1.0.0-rc.1', '1.0.0'), -1)
    assert.equal(compareVersions('1.0.0-alpha', '1.0.0-alpha.1'), -1)
    assert.equal(compareVersions('1.0.0-alpha.1', '1.0.0-beta'), -1)
    assert.equal(compareVersions('1.0.0-2', '1.0.0-10'), -1)
    assert.equal(compareVersions('0.10.0', '0.9.0'), 1)
    assert.equal(parseVersion('0.2'), null)
    assert.equal(parseVersion(undefined), null)
})

test('only what a host loads counts as shipped', () => {
    assert.ok(isShipped(SKILL))
    assert.ok(isShipped('plugins/manyfold/.codex-plugin/plugin.json'))
    assert.ok(!isShipped('plugins/manyfold/README.md'))
    assert.ok(!isShipped('plugins/manyfold/DEVELOPMENT.md'))
    assert.ok(!isShipped('apps/cli/src/agent-help/auth.md'))
})

test('a skill change with a raised version passes', () => {
    assert.deepEqual(
        findPluginVersionFailures({
            changed: [SKILL],
            baseVersion: '0.1.0+codex.20260923204859',
            headVersions: both('0.2.0')
        }),
        []
    )
})

test('a skill change that keeps the version fails and says what to do', () => {
    const [failure, ...rest] = findPluginVersionFailures({
        changed: [
            SKILL,
            'plugins/manyfold/skills/manyfold-cli-usage/references/auth.md'
        ],
        baseVersion: '0.2.0',
        headVersions: both('0.2.0')
    })
    assert.deepEqual(rest, [])
    assert.match(failure, /manyfold-cli-usage\/SKILL\.md and 1 more/)
    assert.match(failure, /not above 0\.2\.0: raise it in both manifests/)
})

test('a new build-metadata suffix alone is not a raise', () => {
    assert.equal(
        findPluginVersionFailures({
            changed: [SKILL],
            baseVersion: '0.1.0+codex.1',
            headVersions: both('0.1.0+codex.2')
        }).length,
        1
    )
})

test('docs, unrelated files and a plugin new at base need no raise', () => {
    for (const changed of [
        ['plugins/manyfold/README.md'],
        ['apps/api/src/x.ts'],
        []
    ])
        assert.deepEqual(
            findPluginVersionFailures({
                changed,
                baseVersion: '0.2.0',
                headVersions: both('0.2.0')
            }),
            []
        )
    assert.deepEqual(
        findPluginVersionFailures({
            changed: [SKILL],
            baseVersion: null,
            headVersions: both('0.1.0')
        }),
        []
    )
})

test('the manifests must agree and be semver on every PR', () => {
    const [disagree] = findPluginVersionFailures({
        changed: [],
        baseVersion: '0.2.0',
        headVersions: { [MANIFESTS[0]]: '0.3.0', [MANIFESTS[1]]: '0.2.0' }
    })
    assert.match(disagree, /the manifests disagree/)
    const [invalid] = findPluginVersionFailures({
        changed: [],
        baseVersion: '0.2.0',
        headVersions: both('latest')
    })
    assert.match(invalid, /"latest" is not a semver version/)
})

// End to end over a real git history, because the gate depends on `git diff`
// naming the files and `git show` reading the base manifest.
function repo(t, { baseVersion, headVersion, files }) {
    const root = fs.mkdtempSync(
        path.join(os.tmpdir(), 'manyfold-plugin-version-')
    )
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const git = (...args) => {
        const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
        assert.equal(
            result.status,
            0,
            `git ${args.join(' ')}: ${result.stderr}`
        )
        return result.stdout.trim()
    }
    const write = (relPath, contents) => {
        const target = path.join(root, relPath)
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(target, contents)
    }
    const manifests = (version) => {
        for (const file of MANIFESTS)
            write(
                file,
                `${JSON.stringify({ name: 'manyfold', version }, null, 4)}\n`
            )
    }
    manifests(baseVersion)
    write(SKILL, 'old\n')
    git('init', '--initial-branch=main')
    git('config', 'user.email', 'fixture@example.com')
    git('config', 'user.name', 'fixture')
    git('config', 'commit.gpgsign', 'false')
    git('add', '.')
    git('commit', '-m', 'base')
    const base = git('rev-parse', 'HEAD')
    manifests(headVersion)
    for (const [relPath, contents] of Object.entries(files))
        write(relPath, contents)
    git('add', '.')
    git('commit', '-m', 'change')
    return { root, base }
}

const run = (root, env) =>
    spawnSync(process.execPath, [SCRIPT], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, ...env }
    })

test('the executable fails a real PR that changed the skill and kept the version', (t) => {
    const { root, base } = repo(t, {
        baseVersion: '0.1.0+codex.20260923204859',
        headVersion: '0.1.0+codex.20260923204859',
        files: { [SKILL]: 'new\n' }
    })
    const result = run(root, { TURBO_SCM_BASE: base })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /plugin version check failed/)
    assert.match(result.stderr, /raise it in both manifests/)
})

test('the executable passes the same PR once the version is raised', (t) => {
    const { root, base } = repo(t, {
        baseVersion: '0.1.0+codex.20260923204859',
        headVersion: '0.2.0',
        files: { [SKILL]: 'new\n' }
    })
    const result = run(root, { TURBO_SCM_BASE: base })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /plugin version check passed/)
})

test('the executable refuses to guess a base', () => {
    const result = run(process.cwd(), { TURBO_SCM_BASE: '' })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /TURBO_SCM_BASE is not set/)
})
