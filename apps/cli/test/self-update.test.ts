import test from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { strToU8, zipSync } from 'fflate'
import {
    cleanupStaleUpdateArtifact,
    extractUpdateBinary,
    OLD_BINARY_SUFFIX,
    replaceExecutable,
    resolveUpdateTarget
} from '../src/self-update'
import { isBunStandalone } from '../src/standalone'

const writeField = (
    target: Buffer,
    offset: number,
    length: number,
    value: string
): void => {
    target.write(
        value,
        offset,
        Math.min(length, Buffer.byteLength(value)),
        'ascii'
    )
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
        writeField(
            header,
            148,
            8,
            `${checksum.toString(8).padStart(6, '0')}\0 `
        )
        chunks.push(header, data)
        const padding = (512 - (data.length % 512)) % 512
        if (padding > 0) chunks.push(Buffer.alloc(padding))
    }
    chunks.push(Buffer.alloc(1024))
    return gzipSync(Buffer.concat(chunks))
}

test('update targets match every release asset shape', () => {
    assert.deepEqual(resolveUpdateTarget('linux', 'x64'), {
        os: 'linux',
        arch: 'x64',
        archiveFormat: 'tar.gz',
        binaryName: 'mf'
    })
    assert.deepEqual(resolveUpdateTarget('darwin', 'arm64'), {
        os: 'darwin',
        arch: 'arm64',
        archiveFormat: 'tar.gz',
        binaryName: 'mf'
    })
    assert.deepEqual(resolveUpdateTarget('win32', 'x64'), {
        os: 'windows',
        arch: 'x64',
        archiveFormat: 'zip',
        binaryName: 'mf.exe'
    })
    assert.throws(
        () => resolveUpdateTarget('win32', 'arm64'),
        /unsupported Windows arch/
    )
    assert.throws(
        () => resolveUpdateTarget('aix', 'x64'),
        /unsupported platform/
    )
})

test('standalone detection works for compiled Unix and Windows executables', () => {
    assert.equal(
        isBunStandalone({ hasBun: true, execPath: '/usr/local/bin/mf' }),
        true
    )
    assert.equal(
        isBunStandalone({ hasBun: true, execPath: 'C:\\Tools\\mf.exe' }),
        true
    )
    assert.equal(
        isBunStandalone({ hasBun: true, execPath: '/opt/bun/bin/bun' }),
        false
    )
    assert.equal(
        isBunStandalone({ hasBun: true, execPath: 'C:\\Tools\\bun.exe' }),
        false
    )
    assert.equal(
        isBunStandalone({ hasBun: false, execPath: '/usr/local/bin/mf' }),
        false
    )
})

test('in-process tar.gz extraction returns only the expected root binary', () => {
    const target = resolveUpdateTarget('linux', 'x64')
    assert.deepEqual(
        extractUpdateBinary(tarGz({ mf: Buffer.from('unix-binary') }), target),
        Buffer.from('unix-binary')
    )
    assert.throws(
        () =>
            extractUpdateBinary(
                tarGz({ 'nested/mf': Buffer.from('wrong') }),
                target
            ),
        /not found at archive root/
    )
    const corrupted = tarGz({ mf: Buffer.from('unix-binary') })
    const tar = Buffer.from(gzipSync(Buffer.from('not a tar')))
    assert.throws(() => extractUpdateBinary(tar, target), /invalid tar/)
    corrupted[corrupted.length - 8] ^= 0xff
    assert.throws(
        () => extractUpdateBinary(corrupted, target),
        /invalid tar\.gz archive/
    )
})

test('in-process zip extraction returns only the expected root executable', () => {
    const target = resolveUpdateTarget('win32', 'x64')
    assert.deepEqual(
        extractUpdateBinary(
            zipSync({ 'mf.exe': strToU8('windows-binary') }),
            target
        ),
        Buffer.from('windows-binary')
    )
    assert.throws(
        () =>
            extractUpdateBinary(
                zipSync({ 'nested/mf.exe': strToU8('wrong') }),
                target
            ),
        /not found at archive root/
    )
    assert.throws(
        () => extractUpdateBinary(Buffer.from('not a zip'), target),
        /invalid zip archive/
    )
})

test('Windows replacement keeps the running executable as a recoverable backup', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mf-self-update-'))
    const execPath = join(dir, 'mf.exe')
    const newBinary = join(dir, 'downloaded.exe')
    try {
        await writeFile(execPath, 'old-binary')
        await writeFile(newBinary, 'new-binary')

        await replaceExecutable(newBinary, execPath, { platform: 'win32' })

        assert.equal(await readFile(execPath, 'utf8'), 'new-binary')
        assert.equal(
            await readFile(`${execPath}${OLD_BINARY_SUFFIX}`, 'utf8'),
            'old-binary'
        )

        await cleanupStaleUpdateArtifact({
            platform: 'win32',
            execPath,
            standalone: true
        })
        await assert.rejects(() => access(`${execPath}${OLD_BINARY_SUFFIX}`))
    } finally {
        await rm(dir, { recursive: true, force: true })
    }
})

test('Windows replacement restores the previous executable when install fails', async () => {
    const calls: string[] = []
    const execPath = 'C:\\Tools\\mf.exe'
    const newBinary = 'C:\\Tools\\downloaded.exe'
    const oldPath = `${execPath}${OLD_BINARY_SUFFIX}`
    await assert.rejects(
        () =>
            replaceExecutable(newBinary, execPath, {
                platform: 'win32',
                removeFile: async (path) => {
                    calls.push(`remove ${path}`)
                },
                renameFile: async (source, destination) => {
                    calls.push(`rename ${source} -> ${destination}`)
                    if (source === newBinary) throw new Error('access denied')
                }
            }),
        /previous executable was restored: access denied/
    )
    assert.deepEqual(calls, [
        `remove ${oldPath}`,
        `rename ${execPath} -> ${oldPath}`,
        `rename ${newBinary} -> ${execPath}`,
        `rename ${oldPath} -> ${execPath}`
    ])
})

test('Windows replacement reports when installation and recovery both fail', async () => {
    const execPath = 'C:\\Tools\\mf.exe'
    const newBinary = 'C:\\Tools\\downloaded.exe'
    const oldPath = `${execPath}${OLD_BINARY_SUFFIX}`
    await assert.rejects(
        () =>
            replaceExecutable(newBinary, execPath, {
                platform: 'win32',
                removeFile: async () => {},
                renameFile: async (source) => {
                    if (source === newBinary) throw new Error('install denied')
                    if (source === oldPath) throw new Error('restore denied')
                }
            }),
        /could not install the new executable: install denied; restoring the previous executable also failed: restore denied/
    )
})

test('stale update cleanup is limited to installed Windows binaries', async () => {
    const removed: string[] = []
    const removeFile = async (path: string): Promise<void> => {
        removed.push(path)
    }
    await cleanupStaleUpdateArtifact({
        platform: 'linux',
        execPath: '/usr/local/bin/mf',
        standalone: true,
        removeFile
    })
    await cleanupStaleUpdateArtifact({
        platform: 'win32',
        execPath: 'C:\\Tools\\mf.exe',
        standalone: false,
        removeFile
    })
    await cleanupStaleUpdateArtifact({
        platform: 'win32',
        execPath: 'C:\\Tools\\mf.exe',
        standalone: true,
        removeFile
    })
    assert.deepEqual(removed, [`C:\\Tools\\mf.exe${OLD_BINARY_SUFFIX}`])
})
