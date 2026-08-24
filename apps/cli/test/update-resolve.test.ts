import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { performSelfUpdate } from '../src/commands/update'
import { resolveUpdateTarget } from '../src/self-update'

// Same hand-rolled tar writer as self-update.test.ts: the updater deliberately
// has no system tar dependency, so the fixture cannot use one either.
const writeField = (
    target: Buffer,
    offset: number,
    length: number,
    value: string
): void => {
    target.write(value.padEnd(length, '\0'), offset, length, 'utf8')
}

const writeOctal = (
    target: Buffer,
    offset: number,
    length: number,
    value: number
): void => {
    writeField(
        target,
        offset,
        length,
        `${value.toString(8).padStart(length - 1, '0')}\0`
    )
}

const tarGz = (entries: Record<string, Buffer>): Buffer => {
    const chunks: Buffer[] = []
    for (const [name, data] of Object.entries(entries)) {
        const header = Buffer.alloc(512)
        writeField(header, 0, 100, name)
        writeOctal(header, 100, 8, 0o755)
        writeOctal(header, 108, 8, 0)
        writeOctal(header, 116, 8, 0)
        writeOctal(header, 124, 12, data.length)
        writeOctal(header, 136, 12, 0)
        header.fill(0x20, 148, 156)
        header[156] = '0'.charCodeAt(0)
        writeField(header, 257, 6, 'ustar\0')
        writeField(header, 263, 2, '00')
        const checksum = header.reduce((sum, byte) => sum + byte, 0)
        writeField(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `)
        chunks.push(header, data)
        const padding = (512 - (data.length % 512)) % 512
        if (padding > 0) chunks.push(Buffer.alloc(padding))
    }
    chunks.push(Buffer.alloc(1024))
    return gzipSync(Buffer.concat(chunks))
}

const sha256 = (data: Buffer): string =>
    createHash('sha256').update(data).digest('hex')

const target = resolveUpdateTarget()
const targetName = `${target.os}-${target.arch}`
const ARTIFACT_URL = `https://github.com/manyfold-open/manyfold/releases/download/cli-v9.9.9/mf-9.9.9-${targetName}.${target.archiveFormat}`

interface Harness {
    fetchImpl: typeof fetch
    urls: string[]
}

const harness = (opts: {
    manifest: Record<string, unknown>
    archive?: Buffer
}): Harness => {
    const urls: string[] = []
    const fetchImpl = (async (input: string) => {
        urls.push(String(input))
        if (String(input).endsWith('.json'))
            return {
                ok: true,
                status: 200,
                text: async () => JSON.stringify(opts.manifest)
            } as unknown as Response
        const body = opts.archive ?? Buffer.alloc(0)
        return {
            ok: true,
            status: 200,
            arrayBuffer: async () =>
                body.buffer.slice(
                    body.byteOffset,
                    body.byteOffset + body.byteLength
                )
        } as unknown as Response
    }) as unknown as typeof fetch
    return { fetchImpl, urls }
}

const manifestFor = (
    archive: Buffer,
    overrides: Record<string, unknown> = {}
): Record<string, unknown> => ({
    schema: 1,
    channel: 'stable',
    version: '9.9.9',
    commit: 'b981ca2a4f2c8e0b6d5f1a90c3e77b2d4f8a0e11',
    commitShort: 'b981ca2',
    buildTime: '2026-08-24T08:22:41Z',
    publishedAt: '2026-08-24T08:30:12Z',
    tag: 'cli-v9.9.9',
    artifacts: {
        [targetName]: {
            url: ARTIFACT_URL,
            sha256: sha256(archive),
            size: archive.byteLength,
            format: target.archiveFormat,
            binary: target.binaryName
        }
    },
    ...overrides
})

const withFakeExec = async (
    body: (execPath: string) => Promise<void>
): Promise<void> => {
    const dir = await mkdtemp(join(tmpdir(), 'mf-update-'))
    const execPath = join(dir, target.binaryName)
    await writeFile(execPath, 'OLD BINARY')
    try {
        await body(execPath)
    } finally {
        await rm(dir, { recursive: true, force: true })
    }
}

// Only zip extraction differs by platform, and self-update.test.ts already
// covers both archive readers; this file is about the resolve → verify → swap
// sequence, so it runs on the tar.gz hosts.
const tarOnly = { skip: target.archiveFormat !== 'tar.gz' }

test(
    'performSelfUpdate resolves the channel manifest, verifies and swaps in two fetches',
    tarOnly,
    async () => {
        const archive = tarGz({ [target.binaryName]: Buffer.from('NEW BINARY') })
        const h = harness({ manifest: manifestFor(archive), archive })
        await withFakeExec(async (execPath) => {
            const result = await performSelfUpdate({
                standalone: true,
                execPath,
                fetchImpl: h.fetchImpl
            })
            assert.equal(result.changed, true)
            assert.equal(result.to, '9.9.9')
            assert.equal(
                result.commit,
                'b981ca2a4f2c8e0b6d5f1a90c3e77b2d4f8a0e11'
            )
            // Two round trips: the manifest and the archive. The old protocol
            // needed a third for a detached .sha256, which could be served
            // from a different cache generation than the bytes it described.
            assert.deepEqual(h.urls, [
                'https://github.com/manyfold-open/manyfold/releases/download/cli-channels/stable.json',
                ARTIFACT_URL
            ])
            assert.equal(await readFile(execPath, 'utf8'), 'NEW BINARY')
        })
    }
)

test(
    'performSelfUpdate aborts on a sha256 mismatch without touching the executable',
    tarOnly,
    async () => {
        const archive = tarGz({ [target.binaryName]: Buffer.from('NEW BINARY') })
        const tampered = manifestFor(archive)
        ;(
            tampered.artifacts as Record<string, Record<string, unknown>>
        )[targetName].sha256 = 'f'.repeat(64)
        const h = harness({ manifest: tampered, archive })
        await withFakeExec(async (execPath) => {
            await assert.rejects(
                () =>
                    performSelfUpdate({
                        standalone: true,
                        execPath,
                        fetchImpl: h.fetchImpl
                    }),
                /sha256 mismatch/
            )
            assert.equal(await readFile(execPath, 'utf8'), 'OLD BINARY')
        })
    }
)

test(
    'performSelfUpdate reads a pinned stable version from its own release manifest',
    tarOnly,
    async () => {
        const archive = tarGz({ [target.binaryName]: Buffer.from('NEW BINARY') })
        const h = harness({ manifest: manifestFor(archive), archive })
        await withFakeExec(async (execPath) => {
            await performSelfUpdate({
                standalone: true,
                execPath,
                targetVersion: '9.9.9',
                fetchImpl: h.fetchImpl
            })
            assert.equal(
                h.urls[0],
                'https://github.com/manyfold-open/manyfold/releases/download/cli-v9.9.9/manifest.json'
            )
        })
    }
)

test(
    'performSelfUpdate reads a pinned dev version from the rolling dev release',
    tarOnly,
    async () => {
        const version = '9.9.9-dev.202608240920.a72f4de'
        const archive = tarGz({ [target.binaryName]: Buffer.from('DEV BINARY') })
        const h = harness({
            manifest: manifestFor(archive, { channel: 'dev', version }),
            archive
        })
        await withFakeExec(async (execPath) => {
            await performSelfUpdate({
                standalone: true,
                execPath,
                targetVersion: version,
                fetchImpl: h.fetchImpl
            })
            assert.equal(
                h.urls[0],
                `https://github.com/manyfold-open/manyfold/releases/download/cli-dev/manifest-${version}.json`
            )
        })
    }
)

test(
    'performSelfUpdate downloads nothing when the manifest names the running version',
    tarOnly,
    async () => {
        const archive = tarGz({ [target.binaryName]: Buffer.from('NEW BINARY') })
        // MF_CLI_VERSION is 0.0.0-dev under tsx (no build-time define).
        const h = harness({
            manifest: manifestFor(archive, { version: '0.0.0-dev' }),
            archive
        })
        await withFakeExec(async (execPath) => {
            const result = await performSelfUpdate({
                standalone: true,
                execPath,
                fetchImpl: h.fetchImpl
            })
            assert.equal(result.changed, false)
            assert.equal(h.urls.length, 1)
            assert.equal(await readFile(execPath, 'utf8'), 'OLD BINARY')
        })
    }
)

test(
    'performSelfUpdate refuses when the channel has no build for this target',
    tarOnly,
    async () => {
        const archive = tarGz({ [target.binaryName]: Buffer.from('NEW BINARY') })
        const h = harness({
            manifest: manifestFor(archive, { artifacts: {} }),
            archive
        })
        await withFakeExec(async (execPath) => {
            await assert.rejects(
                () =>
                    performSelfUpdate({
                        standalone: true,
                        execPath,
                        fetchImpl: h.fetchImpl
                    }),
                new RegExp(`no ${targetName} build`)
            )
            assert.equal(h.urls.length, 1)
        })
    }
)

test('performSelfUpdate refuses to run against a source build', async () => {
    await assert.rejects(
        () => performSelfUpdate({ standalone: false }),
        /only works on installed mf binaries/
    )
})
