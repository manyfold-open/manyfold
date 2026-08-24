import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
    fetchReleaseManifest,
    MAX_MANIFEST_BYTES,
    manifestArtifact,
    parseReleaseManifest,
    targetKey
} from '../src/release-manifest'
import { resolveUpdateTarget } from '../src/self-update'

const SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

const golden = (
    overrides: Record<string, unknown> = {},
    artifacts?: Record<string, unknown>
): Record<string, unknown> => ({
    schema: 1,
    channel: 'stable',
    version: '0.24.0',
    commit: '923abd1a4f2c8e0b6d5f1a90c3e77b2d4f8a0e11',
    commitShort: '923abd1',
    buildTime: '2026-08-24T08:22:41Z',
    publishedAt: '2026-08-24T08:30:12Z',
    tag: 'cli-v0.24.0',
    artifacts: artifacts ?? {
        'linux-x64': {
            url: 'https://github.com/manyfold-open/manyfold/releases/download/cli-v0.24.0/mf-0.24.0-linux-x64.tar.gz',
            sha256: SHA,
            size: 39137144,
            format: 'tar.gz',
            binary: 'mf'
        },
        'windows-x64': {
            url: 'https://github.com/manyfold-open/manyfold/releases/download/cli-v0.24.0/mf-0.24.0-windows-x64.zip',
            sha256: SHA,
            size: 42483109,
            format: 'zip',
            binary: 'mf.exe'
        }
    },
    ...overrides
})

test('parseReleaseManifest accepts a well-formed manifest', () => {
    const m = parseReleaseManifest(golden(), 'stable.json')
    assert.equal(m.schema, 1)
    assert.equal(m.channel, 'stable')
    assert.equal(m.version, '0.24.0')
    assert.equal(m.commitShort, '923abd1')
    assert.equal(m.artifacts['linux-x64']?.format, 'tar.gz')
    assert.equal(m.artifacts['windows-x64']?.binary, 'mf.exe')
    assert.equal(m.notesUrl, undefined)
})

test('parseReleaseManifest derives commitShort when the publisher omits it', () => {
    const m = parseReleaseManifest(
        golden({ commitShort: undefined }),
        'stable.json'
    )
    assert.equal(m.commitShort, '923abd1')
})

test('parseReleaseManifest rejects a schema it cannot read', () => {
    assert.throws(
        () => parseReleaseManifest(golden({ schema: 2 }), 'stable.json'),
        /unsupported schema 2/
    )
})

test('parseReleaseManifest rejects an unknown channel', () => {
    assert.throws(
        () => parseReleaseManifest(golden({ channel: 'beta' }), 'stable.json'),
        /unknown channel beta/
    )
})

test('parseReleaseManifest requires version, commit and tag', () => {
    for (const field of ['version', 'commit', 'tag'])
        assert.throws(
            () =>
                parseReleaseManifest(
                    golden({ [field]: '' }),
                    'stable.json'
                ),
            new RegExp(`${field} is missing`)
        )
})

// The manifest is the only thing that names a download URL, so a downgrade to
// plaintext here would hand the whole update path to a network attacker.
test('parseReleaseManifest rejects a non-https artifact url', () => {
    assert.throws(
        () =>
            parseReleaseManifest(
                golden({}, {
                    'linux-x64': {
                        url: 'http://example.com/mf.tar.gz',
                        sha256: SHA,
                        size: 1,
                        format: 'tar.gz',
                        binary: 'mf'
                    }
                }),
                'stable.json'
            ),
        /artifact linux-x64 url is not https/
    )
})

test('parseReleaseManifest rejects a malformed sha256', () => {
    for (const bad of [SHA.slice(0, 63), SHA.toUpperCase(), 'nope'])
        assert.throws(
            () =>
                parseReleaseManifest(
                    golden({}, {
                        'linux-x64': {
                            url: 'https://example.com/mf.tar.gz',
                            sha256: bad,
                            size: 1,
                            format: 'tar.gz',
                            binary: 'mf'
                        }
                    }),
                    'stable.json'
                ),
            /sha256 is not 64 lowercase hex/
        )
})

test('parseReleaseManifest rejects unknown archive and binary names', () => {
    const base = {
        url: 'https://example.com/mf.tar.gz',
        sha256: SHA,
        size: 1,
        format: 'tar.gz',
        binary: 'mf'
    }
    assert.throws(
        () =>
            parseReleaseManifest(
                golden({}, { 'linux-x64': { ...base, format: 'tar.xz' } }),
                'stable.json'
            ),
        /unknown format/
    )
    assert.throws(
        () =>
            parseReleaseManifest(
                golden({}, { 'linux-x64': { ...base, binary: 'nca' } }),
                'stable.json'
            ),
        /unknown binary name/
    )
})

test('targetKey matches the manifest artifact keys', () => {
    assert.equal(targetKey(resolveUpdateTarget('linux', 'x64')), 'linux-x64')
    assert.equal(
        targetKey(resolveUpdateTarget('darwin', 'arm64')),
        'darwin-arm64'
    )
    assert.equal(targetKey(resolveUpdateTarget('win32', 'x64')), 'windows-x64')
})

test('manifestArtifact names the missing target and the channel', () => {
    const m = parseReleaseManifest(golden(), 'stable.json')
    assert.equal(
        manifestArtifact(m, resolveUpdateTarget('linux', 'x64')).size,
        39137144
    )
    assert.throws(
        () => manifestArtifact(m, resolveUpdateTarget('darwin', 'arm64')),
        /the stable channel has no darwin-arm64 build for 0\.24\.0/
    )
})

const respond = (body: string, ok = true): typeof fetch =>
    (async () =>
        ({
            ok,
            status: ok ? 200 : 404,
            text: async () => body
        }) as unknown as Response) as unknown as typeof fetch

test('fetchReleaseManifest surfaces a non-200 with the URL', async () => {
    await assert.rejects(
        () =>
            fetchReleaseManifest('https://example.com/stable.json', {
                fetchImpl: respond('', false)
            }),
        /GET https:\/\/example\.com\/stable\.json → 404/
    )
})

test('fetchReleaseManifest rejects a body that is not JSON', async () => {
    await assert.rejects(
        () =>
            fetchReleaseManifest('https://example.com/stable.json', {
                fetchImpl: respond('<!doctype html>')
            }),
        /body is not JSON/
    )
})

// A channel pointer is a few hundred bytes; anything larger is a misrouted
// response, and parsing it would be the only unbounded work in the path.
test('fetchReleaseManifest rejects an oversized body', async () => {
    await assert.rejects(
        () =>
            fetchReleaseManifest('https://example.com/stable.json', {
                fetchImpl: respond('x'.repeat(MAX_MANIFEST_BYTES + 1))
            }),
        /body exceeds/
    )
})

test('fetchReleaseManifest parses a real payload', async () => {
    const m = await fetchReleaseManifest('https://example.com/stable.json', {
        fetchImpl: respond(JSON.stringify(golden()))
    })
    assert.equal(m.version, '0.24.0')
})

// The generator and the reader are two halves of one contract; a schema change
// on either side that the other cannot read is exactly the failure this catches.
test('build-manifest.mjs output round-trips through parseReleaseManifest', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mf-manifest-gen-'))
    try {
        for (const target of [
            'darwin-arm64',
            'darwin-x64',
            'linux-arm64',
            'linux-x64'
        ])
            await writeFile(join(dir, `mf-0.24.0-${target}.tar.gz`), target)
        await writeFile(join(dir, 'mf-0.24.0-windows-x64.zip'), 'win')
        const out = join(dir, 'manifest.json')
        execFileSync(
            process.execPath,
            [
                new URL('../scripts/build-manifest.mjs', import.meta.url)
                    .pathname,
                '--channel',
                'stable',
                '--version',
                '0.24.0',
                '--commit',
                '923abd1a4f2c8e0b6d5f1a90c3e77b2d4f8a0e11',
                '--build-time',
                '2026-08-24T08:22:41Z',
                '--tag',
                'cli-v0.24.0',
                '--dir',
                dir,
                '--base',
                'https://github.com/manyfold-open/manyfold/releases/download/cli-v0.24.0',
                '--out',
                out
            ],
            { stdio: 'pipe' }
        )
        const raw = await readFile(out, 'utf8')
        const manifest = parseReleaseManifest(JSON.parse(raw), out)
        assert.equal(manifest.channel, 'stable')
        assert.equal(manifest.version, '0.24.0')
        assert.equal(manifest.commitShort, '923abd1')
        for (const target of [
            'darwin-arm64',
            'darwin-x64',
            'linux-arm64',
            'linux-x64',
            'windows-x64'
        ] as const)
            assert.ok(manifest.artifacts[target], `missing ${target}`)
        assert.equal(manifest.artifacts['windows-x64']?.binary, 'mf.exe')
        // install.sh reads this with awk, so the exact layout is part of the
        // contract: target keys at 4 spaces, their fields at 6, and a target
        // block closed by a brace at 4.
        assert.match(raw, /^ {4}"darwin-arm64": \{$/m)
        assert.match(raw, /^ {6}"sha256": "[0-9a-f]{64}",$/m)
        assert.match(raw, /^ {6}"url": "https:\/\/[^"]+",$/m)
        assert.match(raw, /^ {4}\},$/m)
    } finally {
        await rm(dir, { recursive: true, force: true })
    }
})
