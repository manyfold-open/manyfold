import assert from 'node:assert/strict'
import type { PathLike } from 'node:fs'
import fs, {
    mkdtemp,
    readFile,
    readdir,
    rm,
    stat,
    writeFile
} from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { writeProtectedFile } from '../src/json-state'
import {
    acquireProcessLock,
    ProcessLockBusyError
} from '../src/daemon/process-lock'

for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
    test(`Windows protected replace recovers from a temporary ${code}`, async (t) => {
        const dir = await mkdtemp(join(tmpdir(), 'mf-protected-replace-'))
        const path = join(dir, 'owner.json')
        const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
        const rename = fs.rename
        let attempts = 0
        await writeFile(path, 'original')
        const mocked = t.mock.method(
            fs,
            'rename',
            async (source: PathLike, destination: PathLike) => {
                attempts += 1
                assert.equal(await readFile(path, 'utf8'), 'original')
                assert.equal(await readFile(source, 'utf8'), 'replacement')
                if (platform.value !== 'win32')
                    assert.equal((await stat(source)).mode & 0o777, 0o600)
                if (attempts === 1)
                    throw Object.assign(new Error('temporary replace denial'), {
                        code
                    })
                return rename(source, destination)
            }
        )
        syncBuiltinESMExports()
        Object.defineProperty(process, 'platform', {
            ...platform,
            value: 'win32'
        })
        try {
            await writeProtectedFile(path, 'replacement')
            assert.equal(attempts, 2)
            assert.equal(await readFile(path, 'utf8'), 'replacement')
            assert.deepEqual(await readdir(dir), ['owner.json'])
        } finally {
            Object.defineProperty(process, 'platform', platform)
            mocked.mock.restore()
            syncBuiltinESMExports()
            await rm(dir, { recursive: true, force: true })
        }
    })
}

test('an exhausted Windows retry budget preserves the target and cleans the temporary file', async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'mf-replace-exhausted-'))
    const path = join(dir, 'owner.json')
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    const failure = Object.assign(new Error('persistent access denial'), {
        code: 'EPERM'
    })
    let now = 0
    const time = t.mock.method(performance, 'now', () => now)
    const rename = t.mock.method(fs, 'rename', async () => {
        now = 1_000
        throw failure
    })
    syncBuiltinESMExports()
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    try {
        await writeFile(path, 'original')
        await assert.rejects(
            writeProtectedFile(path, 'replacement'),
            (error) => error === failure
        )
        assert.equal(await readFile(path, 'utf8'), 'original')
        assert.deepEqual(await readdir(dir), ['owner.json'])
    } finally {
        Object.defineProperty(process, 'platform', platform)
        time.mock.restore()
        rename.mock.restore()
        syncBuiltinESMExports()
        await rm(dir, { recursive: true, force: true })
    }
})

test('failed metadata publication holds the kernel lock until cleanup, then permits a new owner', async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'mf-metadata-lock-'))
    const failure = Object.assign(new Error('metadata I/O failure'), {
        code: 'EIO'
    })
    let publishing!: () => void
    let release!: () => void
    const atPublication = new Promise<void>((resolve) => {
        publishing = resolve
    })
    const gate = new Promise<void>((resolve) => {
        release = resolve
    })
    const mocked = t.mock.method(fs, 'rename', async () => {
        publishing()
        await gate
        throw failure
    })
    syncBuiltinESMExports()
    const acquiring = acquireProcessLock(dir)
    const rejected = assert.rejects(acquiring, (error) => error === failure)
    try {
        await atPublication
        await assert.rejects(acquireProcessLock(dir), ProcessLockBusyError)
        release()
        await rejected
        assert.deepEqual(
            await readdir(dir),
            process.platform === 'win32' ? [] : ['lock']
        )
        mocked.mock.restore()
        syncBuiltinESMExports()
        const owner = await acquireProcessLock(dir)
        await owner.release()
    } finally {
        release()
        await rejected
        mocked.mock.restore()
        syncBuiltinESMExports()
        await rm(dir, { recursive: true, force: true })
    }
})
