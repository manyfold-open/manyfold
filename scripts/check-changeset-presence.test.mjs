import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
    findPresenceFailures,
    formatFailures,
    isChangesetFile,
    isReleaseNoteRelevant,
    readAddedChangesets,
    surfacesFromPackages,
    touchedSurfaces
} from './check-changeset-presence.mjs'

const SCRIPT = fileURLToPath(
    new URL('./check-changeset-presence.mjs', import.meta.url)
)

const RELEASED = { '@manyfold/api': 'apps/api', '@manyfold/web': 'apps/web' }
const IGNORED = { '@manyfold/shared': 'packages/shared' }

const pkg = (name, dir) => ({ packageJson: { name }, dir })

const surfaces = () =>
    surfacesFromPackages(
        [
            ...Object.entries(RELEASED).map(([name, dir]) => pkg(name, dir)),
            ...Object.entries(IGNORED).map(([name, dir]) => pkg(name, dir))
        ],
        '',
        new Set(Object.keys(IGNORED))
    )

const changeset = (id, releases, summary = 'fixture') => ({
    id,
    releases: releases.map((name) => ({ name, type: 'patch' })),
    summary
})

const verdict = (files, added) => {
    const touched = touchedSurfaces(files, surfaces())
    const found = findPresenceFailures(touched, added)
    return { touched, ...found, failures: formatFailures(touched, found) }
}

test('a changed product source file needs a changeset that names it', () => {
    const { missing, failures } = verdict(
        ['apps/api/src/chat/chat.service.ts'],
        []
    )

    assert.deepEqual(missing, ['@manyfold/api'])
    assert.equal(failures.length, 1)
    assert.match(failures[0], /^@manyfold\/api\n/)
    assert.match(failures[0], /apps\/api\/src\/chat\/chat\.service\.ts/)
})

test('a changeset the PR adds covers the surface it names', () => {
    const { missing, failures } = verdict(
        [
            'apps/api/src/chat/chat.service.ts',
            '.changeset/nice-pandas-smile.md'
        ],
        [changeset('.changeset/nice-pandas-smile.md', ['@manyfold/api'])]
    )

    assert.deepEqual(missing, [])
    assert.deepEqual(failures, [])
})

test('a changeset naming another surface does not cover this one', () => {
    const { missing } = verdict(
        [
            'apps/api/src/chat/chat.service.ts',
            'apps/web/src/pages/AgentChat.tsx',
            '.changeset/nice-pandas-smile.md'
        ],
        [changeset('.changeset/nice-pandas-smile.md', ['@manyfold/web'])]
    )

    assert.deepEqual(missing, ['@manyfold/api'])
})

// The whole point of reading coverage out of the diff: `.changeset/` normally
// holds several changesets from already-merged PRs, and any of them naming
// @manyfold/api would otherwise excuse every later api PR.
test('a changeset already pending from an earlier PR is not coverage', () => {
    const { missing, failures } = verdict(
        ['apps/api/src/chat/chat.service.ts'],
        []
    )

    assert.deepEqual(missing, ['@manyfold/api'])
    assert.equal(failures.length, 1)
})

test('an empty changeset with a reason declines the note', () => {
    const { missing, declined, failures } = verdict(
        ['apps/api/src/chat/chat.service.ts', '.changeset/quiet-moons-rest.md'],
        [
            changeset(
                '.changeset/quiet-moons-rest.md',
                [],
                'Internal refactor: no behavior reaches an operator.'
            )
        ]
    )

    assert.deepEqual(missing, ['@manyfold/api'])
    assert.deepEqual(declined, ['.changeset/quiet-moons-rest.md'])
    assert.deepEqual(failures, [])
})

// A reasonless declination excuses nothing, so both halves are reported: fill
// in the reason, or add a real changeset. Reporting only the empty file would
// leave the author fixing it and hitting the surface failure on the next run.
test('an empty changeset with no reason is itself the failure', () => {
    const { unexplained, declined, missing, failures } = verdict(
        ['apps/api/src/chat/chat.service.ts', '.changeset/quiet-moons-rest.md'],
        [changeset('.changeset/quiet-moons-rest.md', [], '   \n')]
    )

    assert.deepEqual(unexplained, ['.changeset/quiet-moons-rest.md'])
    assert.deepEqual(declined, [])
    assert.deepEqual(missing, ['@manyfold/api'])
    assert.equal(failures.length, 2)
    assert.match(failures[0], /empty changeset with no reason/)
    assert.match(failures[1], /^@manyfold\/api\n/)
})

test('tests, markdown, package.json and CHANGELOG.md are not release-worthy', () => {
    for (const file of [
        'apps/api/test/chat.test.ts',
        'apps/api/src/chat/__tests__/helper.ts',
        'apps/web/src/lib/chatStreamStore.test.ts',
        'apps/api/AGENTS.md',
        'apps/api/package.json',
        'apps/api/CHANGELOG.md'
    ]) {
        assert.equal(isReleaseNoteRelevant(file), false, file)
    }

    for (const file of [
        'apps/api/src/chat/chat.service.ts',
        'apps/api/drizzle/0157_add_column.sql',
        'apps/web/public/logo.svg'
    ]) {
        assert.equal(isReleaseNoteRelevant(file), true, file)
    }
})

// The Version Packages PR and the main -> develop sync PR carry exactly this
// shape. They pass on paths alone, so neither needs a branch-name exception.
test('a version/sync PR touches no release-worthy path', () => {
    const { touched, failures } = verdict(
        [
            'apps/api/package.json',
            'apps/api/CHANGELOG.md',
            'apps/web/package.json',
            'apps/web/CHANGELOG.md',
            '.changeset/consumed-one.md'
        ],
        []
    )

    assert.equal(touched.size, 0)
    assert.deepEqual(failures, [])
})

test('an ignored package implies no surface', () => {
    const { touched, failures } = verdict(['packages/shared/src/semver.ts'], [])

    assert.equal(touched.size, 0)
    assert.deepEqual(failures, [])
})

test('the longest matching package directory owns a file', () => {
    const nested = surfacesFromPackages(
        [
            pkg('@manyfold/api', 'apps/api'),
            pkg('@manyfold/api-edge', 'apps/api/edge')
        ],
        '',
        new Set()
    )
    const touched = touchedSurfaces(['apps/api/edge/src/index.ts'], nested)

    assert.deepEqual([...touched.keys()], ['@manyfold/api-edge'])
})

test('README.md in .changeset is documentation, not a changeset', () => {
    assert.equal(isChangesetFile('.changeset/README.md'), false)
    assert.equal(isChangesetFile('.changeset/config.json'), false)
    assert.equal(isChangesetFile('.changeset/nice-pandas-smile.md'), true)
})

test('a changeset the PR deleted is not coverage', () => {
    const added = readAddedChangesets(
        '/root',
        ['.changeset/gone.md', '.changeset/here.md'],
        (absPath) =>
            absPath.endsWith('gone.md')
                ? null
                : {
                      releases: [{ name: '@manyfold/api', type: 'patch' }],
                      summary: 'x'
                  }
    )

    assert.deepEqual(
        added.map((entry) => entry.id),
        ['.changeset/here.md']
    )
})

// End to end over a real workspace and a real git history, because the gate has
// to survive @manypkg reading the workspace, @changesets/config expanding
// `ignore`, and `git diff` naming the files.
function repo(t, { files, changesets }) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manyfold-presence-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))

    const git = (...args) => {
        const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
        assert.equal(
            result.status,
            0,
            `git ${args.join(' ')}: ${result.stderr}`
        )
    }
    const write = (relPath, contents) => {
        const target = path.join(root, relPath)
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(target, contents)
    }
    const manifest = (name) =>
        JSON.stringify({ name, private: true, version: '1.0.0' })

    write('package.json', manifest('manyfold-fixture'))
    write(
        'pnpm-workspace.yaml',
        "packages:\n    - 'apps/*'\n    - 'packages/*'\n"
    )
    for (const [name, dir] of Object.entries({ ...RELEASED, ...IGNORED }))
        write(`${dir}/package.json`, manifest(name))
    write(
        '.changeset/config.json',
        JSON.stringify({
            privatePackages: { version: true, tag: false },
            ignore: Object.keys(IGNORED)
        })
    )

    git('init', '--initial-branch=main')
    git('config', 'user.email', 'fixture@example.com')
    git('config', 'user.name', 'fixture')
    git('config', 'commit.gpgsign', 'false')
    git('add', '.')
    git('commit', '-m', 'base')

    const base = spawnSync('git', ['rev-parse', 'HEAD'], {
        cwd: root,
        encoding: 'utf8'
    }).stdout.trim()

    for (const [relPath, contents] of Object.entries(files))
        write(relPath, contents)
    for (const [id, body] of Object.entries(changesets ?? {}))
        write(`.changeset/${id}.md`, body)
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

test('the executable fails a real PR that changed api with no changeset', (t) => {
    const { root, base } = repo(t, {
        files: { 'apps/api/src/chat.ts': 'export const x = 1\n' }
    })
    const result = run(root, { TURBO_SCM_BASE: base })

    assert.equal(result.status, 1)
    assert.match(result.stderr, /changeset presence check failed/)
    assert.match(result.stderr, /@manyfold\/api/)
    assert.match(result.stderr, /pnpm changeset --empty/)
})

test('the executable passes the same PR once it adds the changeset', (t) => {
    const { root, base } = repo(t, {
        files: { 'apps/api/src/chat.ts': 'export const x = 1\n' },
        changesets: {
            'nice-pandas-smile':
                "---\n'@manyfold/api': patch\n---\n\nDid a thing.\n"
        }
    })
    const result = run(root, { TURBO_SCM_BASE: base })

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /@manyfold\/api covered/)
})

test('the executable accepts an explained empty changeset', (t) => {
    const { root, base } = repo(t, {
        files: { 'apps/api/src/chat.ts': 'export const x = 1\n' },
        changesets: {
            'quiet-moons-rest': '---\n---\n\nDead code removal only.\n'
        }
    })
    const result = run(root, { TURBO_SCM_BASE: base })

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /declares no release note is owed/)
})

test('the executable refuses to run without a base', (t) => {
    const { root } = repo(t, {
        files: { 'apps/api/src/chat.ts': 'export const x = 1\n' }
    })
    const result = run(root, { TURBO_SCM_BASE: '' })

    assert.equal(result.status, 1)
    assert.match(result.stderr, /TURBO_SCM_BASE is not set/)
})
