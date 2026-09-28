import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
    mkdir,
    mkdtemp,
    readdir,
    readFile,
    realpath,
    rename,
    stat,
    symlink,
    writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
    DAEMON_CLIENT_FEATURES,
    DAEMON_FEATURE_FS_WRITE_STREAM,
    DAEMON_FS_WRITE_CHUNK_MAX_BYTES
} from '@manyfold/shared'
import { rpcHandler, setDeclaredWorkspaceRoot } from '../src/daemon/rpc'
import { sweepUploads, UPLOAD_IDLE_MS } from '../src/daemon/fs-upload'
import { daemonPaths } from '../src/daemon/config'
import type { RpcContext } from '../src/daemon/ws-client'

// DAEMON_FEATURE_FS_WRITE_STREAM: a file larger than one RPC frame goes in
// chunks into an owner-only part beside the target and is renamed over it
// at commit. Laid out like a hosted machine: the daemon's config dir sits in
// the home the platform vouches for.

const ctx = (refId: string): RpcContext => ({
    refId,
    sendEvent: () => {},
    onCancel: () => {}
})

const call = (
    method: Parameters<typeof rpcHandler>[0],
    payload: Record<string, unknown>
) => rpcHandler(method, payload, ctx(`ref-${method}`))

interface Machine {
    home: string
    config: string
    project: string
}

const withMachine = async (
    fn: (m: Machine) => Promise<void>
): Promise<void> => {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'mf-fs-upload-')))
    const priorConfigDir = process.env.MF_CONFIG_DIR
    const priorProfile = process.env.MF_PROFILE
    const config = join(home, '.manyfold')
    process.env.MF_CONFIG_DIR = config
    delete process.env.MF_PROFILE
    const project = join(home, 'project')
    await mkdir(project, { recursive: true })
    setDeclaredWorkspaceRoot(null)
    try {
        await fn({ home, config, project })
    } finally {
        setDeclaredWorkspaceRoot(null)
        if (priorConfigDir === undefined) delete process.env.MF_CONFIG_DIR
        else process.env.MF_CONFIG_DIR = priorConfigDir
        if (priorProfile !== undefined) process.env.MF_PROFILE = priorProfile
    }
}

const begin = async (
    path: string,
    roots: string[],
    mode?: string
): Promise<string> => {
    const ack = await call('fs.write.begin', {
        path,
        roots,
        ...(mode ? { mode } : {})
    })
    assert.equal(ack.ok, true, ack.error)
    assert.equal(ack.payload?.chunkMaxBytes, DAEMON_FS_WRITE_CHUNK_MAX_BYTES)
    return String(ack.payload?.uploadId)
}

const chunk = (uploadId: string, seq: number, buf: Buffer) =>
    call('fs.write.chunk', { uploadId, seq, data: buf.toString('base64') })

const parts = async (dir: string): Promise<string[]> =>
    (await readdir(dir)).filter((name) => name.startsWith('.mf-part-'))

const sha256 = (buf: Buffer): string =>
    createHash('sha256').update(buf).digest('hex')

test('the daemon advertises fs.write.stream.v1', () => {
    assert.ok(DAEMON_CLIENT_FEATURES.includes(DAEMON_FEATURE_FS_WRITE_STREAM))
})

test('a file sent in chunks appears whole at commit, and only then', async () => {
    await withMachine(async ({ project }) => {
        const target = join(project, 'big.bin')
        const pieces = [
            randomBytes(1024 * 1024),
            randomBytes(1024 * 1024),
            randomBytes(100)
        ]
        const whole = Buffer.concat(pieces)
        const uploadId = await begin(target, [project])
        const [part] = await parts(project)
        assert.ok(part, 'a part beside the target')
        assert.equal((await stat(join(project, part))).mode & 0o777, 0o600)
        for (const [seq, piece] of pieces.entries())
            assert.equal((await chunk(uploadId, seq, piece)).ok, true)
        assert.equal(
            existsSync(target),
            false,
            'nothing at the target before commit'
        )
        const done = await call('fs.write.commit', {
            uploadId,
            size: whole.length,
            sha256: sha256(whole)
        })
        assert.deepEqual(done, {
            ok: true,
            payload: { size: whole.length, sha256: sha256(whole) }
        })
        assert.ok((await readFile(target)).equals(whole))
        assert.deepEqual(await parts(project), [])
        // No mode asked for: what a plain fs.write gives a new file.
        const plain = join(project, 'plain.txt')
        await call('fs.write', { path: plain, content: 'x', roots: [project] })
        assert.equal(
            (await stat(target)).mode & 0o777,
            (await stat(plain)).mode & 0o777
        )
    })
})

test('the mode applies at commit and an existing file is replaced whole', async () => {
    await withMachine(async ({ project }) => {
        const target = join(project, 'config.json')
        await writeFile(target, 'old', { mode: 0o644 })
        const uploadId = await begin(target, [project], '600')
        await chunk(uploadId, 0, Buffer.from('new'))
        assert.equal(await readFile(target, 'utf8'), 'old')
        assert.equal((await call('fs.write.commit', { uploadId })).ok, true)
        assert.equal(await readFile(target, 'utf8'), 'new')
        assert.equal((await stat(target)).mode & 0o777, 0o600)
    })
})

test('chunks must come in order', async () => {
    await withMachine(async ({ project }) => {
        const uploadId = await begin(join(project, 'ordered.txt'), [project])
        assert.deepEqual(await chunk(uploadId, 1, Buffer.from('b')), {
            ok: false,
            payload: { nextSeq: 0 },
            error: 'upload_seq_mismatch'
        })
        assert.equal((await chunk(uploadId, 0, Buffer.from('a'))).ok, true)
        assert.equal((await chunk(uploadId, 1, Buffer.from('b'))).ok, true)
        assert.equal((await call('fs.write.commit', { uploadId })).ok, true)
        assert.equal(await readFile(join(project, 'ordered.txt'), 'utf8'), 'ab')
    })
})

test('a size or sha256 that does not match discards the upload and keeps the target', async () => {
    await withMachine(async ({ project }) => {
        const target = join(project, 'kept.txt')
        await writeFile(target, 'keep')
        for (const claim of [
            { size: 99 },
            { sha256: sha256(Buffer.from('other')) }
        ]) {
            const uploadId = await begin(target, [project])
            await chunk(uploadId, 0, Buffer.from('replacement'))
            assert.deepEqual(
                await call('fs.write.commit', { uploadId, ...claim }),
                {
                    ok: false,
                    error: 'upload_integrity_mismatch'
                }
            )
            assert.equal(await readFile(target, 'utf8'), 'keep')
            assert.deepEqual(await parts(project), [])
            assert.equal(
                (await chunk(uploadId, 1, Buffer.from('x'))).error,
                'upload_unknown'
            )
        }
    })
})

test('a chunk over the limit discards the upload', async () => {
    await withMachine(async ({ project }) => {
        const uploadId = await begin(join(project, 'huge.bin'), [project])
        const ack = await call('fs.write.chunk', {
            uploadId,
            seq: 0,
            data: 'A'.repeat(
                Math.ceil(DAEMON_FS_WRITE_CHUNK_MAX_BYTES / 3) * 4 + 4
            )
        })
        assert.deepEqual(ack, { ok: false, error: 'upload_chunk_too_large' })
        assert.deepEqual(await parts(project), [])
    })
})

// ADR-0013: the agent owns the directory it works in and can swap it for a
// link between begin and commit; the rename must not follow it out.
test('commit refuses a target whose directory became a link out of the roots', async () => {
    await withMachine(async ({ home, project }) => {
        const outside = join(home, 'outside')
        await mkdir(outside)
        const dir = join(project, 'docs')
        await mkdir(dir)
        const uploadId = await begin(join(dir, 'report.md'), [project])
        await chunk(uploadId, 0, Buffer.from('report'))
        await rename(dir, join(project, 'docs-moved'))
        await symlink(outside, dir)
        const ack = await call('fs.write.commit', { uploadId })
        assert.equal(ack.ok, false)
        assert.match(String(ack.error), /outside allowed roots/)
        assert.deepEqual(await readdir(outside), [])
    })
})

test('abort drops the part', async () => {
    await withMachine(async ({ project }) => {
        const uploadId = await begin(join(project, 'dropped.txt'), [project])
        await chunk(uploadId, 0, Buffer.from('partial'))
        assert.deepEqual(await call('fs.write.abort', { uploadId }), {
            ok: true
        })
        assert.deepEqual(await parts(project), [])
        assert.equal(
            (await call('fs.write.commit', { uploadId })).error,
            'upload_unknown'
        )
        assert.deepEqual(await call('fs.write.abort', { uploadId }), {
            ok: true
        })
    })
})

test('an upload idle past the hour is swept, and so is a part a previous daemon left', async () => {
    await withMachine(async ({ project }) => {
        const uploadId = await begin(join(project, 'idle.txt'), [project])
        assert.equal(sweepUploads(Date.now() + UPLOAD_IDLE_MS + 1_000), 1)
        assert.deepEqual(await parts(project), [])
        assert.equal(
            (await chunk(uploadId, 0, Buffer.from('late'))).error,
            'upload_unknown'
        )

        const leftover = join(project, '.mf-part-from-a-dead-daemon')
        await writeFile(leftover, 'half')
        await writeFile(
            daemonPaths.uploadsIndexPath,
            JSON.stringify([{ id: 'dead', part: leftover }])
        )
        assert.equal(sweepUploads(), 1)
        assert.equal(existsSync(leftover), false)
    })
})

test("begin refuses a target in the daemon's config dir under a vouched home", async () => {
    await withMachine(async ({ home, config }) => {
        await assert.rejects(
            call('fs.write.begin', {
                path: join(config, 'profiles', 'spriterunner', 'config.json'),
                roots: [home]
            }),
            /inside the daemon's config dir/
        )
    })
})
