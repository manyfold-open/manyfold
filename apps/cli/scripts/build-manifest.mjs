#!/usr/bin/env node
// Builds the release manifest that `mf update` and install.sh consume.
//
// The manifest — not a filename convention — is the contract: it names every
// artifact by absolute URL with its sha256, so the binary never derives a
// download path and the artifact storage can move without reissuing binaries.
//
// Emission format is load-bearing: install.sh parses this with awk, so the
// 2-space JSON.stringify layout and key order are pinned by
// apps/cli/test/install-script.test.ts. Do not switch to a compact writer.
//
// Usage:
//   node scripts/build-manifest.mjs \
//       --channel stable --version 0.24.0 --commit <40-hex> \
//       --build-time 2026-08-24T08:22:41Z --tag cli-v0.24.0 \
//       --dir dist-bin \
//       --base https://github.com/manyfold-open/manyfold/releases/download/cli-v0.24.0 \
//       --out dist-bin/manifest.json

import { createHash } from 'node:crypto'
import { createReadStream, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const fail = (msg) => {
    console.error(`build-manifest: ${msg}`)
    process.exit(1)
}

const args = new Map()
for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i]
    if (!key.startsWith('--')) fail(`unexpected argument ${key}`)
    args.set(key.slice(2), process.argv[i + 1])
}

const required = (name) => {
    const value = args.get(name)
    if (!value) fail(`--${name} is required`)
    return value
}

const channel = required('channel')
if (channel !== 'stable' && channel !== 'dev')
    fail(`--channel must be stable or dev, got ${channel}`)
const version = required('version')
const commit = required('commit')
if (!/^[0-9a-f]{40}$/.test(commit))
    fail(`--commit must be a 40-char lowercase sha, got ${commit}`)
const tag = required('tag')
const base = required('base').replace(/\/+$/, '')
const dir = resolve(required('dir'))
const out = resolve(required('out'))
const buildTime = args.get('build-time') ?? new Date().toISOString()
const notesUrl = args.get('notes-url')

// Every artifact key the updater can ask for. A manifest missing any of them is
// a half-published channel, which is worse than no manifest at all: readers
// would see it as current and then fail per-platform.
const EXPECTED_TARGETS = [
    'darwin-arm64',
    'darwin-x64',
    'linux-arm64',
    'linux-x64',
    'windows-x64'
]

const sha256 = (path) =>
    new Promise((resolveHash, rejectHash) => {
        const hash = createHash('sha256')
        const stream = createReadStream(path)
        stream.on('data', (chunk) => hash.update(chunk))
        stream.on('end', () => resolveHash(hash.digest('hex')))
        stream.on('error', rejectHash)
    })

const ASSET_RE = /^mf-(.+)-((?:darwin|linux|windows)-(?:x64|arm64))\.(tar\.gz|zip)$/

const artifacts = {}
for (const name of readdirSync(dir).sort()) {
    const match = ASSET_RE.exec(name)
    if (!match) continue
    const [, assetVersion, target, format] = match
    // Re-hash here rather than trusting a value carried through an artifact
    // upload: the manifest must describe the exact bytes being published.
    if (assetVersion !== version)
        fail(
            `${name} embeds version ${assetVersion} but --version is ${version}`
        )
    const path = join(dir, name)
    artifacts[target] = {
        url: `${base}/${name}`,
        sha256: await sha256(path),
        size: statSync(path).size,
        format,
        binary: format === 'zip' ? 'mf.exe' : 'mf'
    }
}

const missing = EXPECTED_TARGETS.filter((t) => !artifacts[t])
if (missing.length > 0)
    fail(
        `no artifact for ${missing.join(', ')} in ${dir} — refusing to publish a partial ${channel} manifest`
    )

const manifest = {
    schema: 1,
    channel,
    version,
    commit,
    commitShort: commit.slice(0, 7),
    buildTime,
    publishedAt: new Date().toISOString(),
    tag,
    ...(notesUrl ? { notesUrl } : {}),
    // Stable key order so the awk extractors in install.sh stay honest.
    artifacts: Object.fromEntries(
        EXPECTED_TARGETS.map((target) => [target, artifacts[target]])
    )
}

writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`)
console.log(
    `build-manifest: ✓ ${out} — ${channel} ${version} (${manifest.commitShort}), ${EXPECTED_TARGETS.length} targets`
)
