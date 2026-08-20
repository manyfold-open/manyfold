import test from 'node:test'
import assert from 'node:assert/strict'
import {
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rm,
    stat,
    writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
    readJsonState,
    writeProtectedFile,
    writeProtectedJson
} from '../src/json-state'

const withTempDir = async (
    fn: (dir: string) => Promise<void>
): Promise<void> => {
    const dir = await mkdtemp(join(tmpdir(), 'mf-json-state-'))
    try {
        await fn(dir)
    } finally {
        await rm(dir, { recursive: true, force: true })
    }
}

test('readJsonState returns undefined only when the file is missing', async () => {
    await withTempDir(async (dir) => {
        assert.equal(await readJsonState(join(dir, 'missing.json')), undefined)
    })
})

test('readJsonState reports corrupt JSON without leaking its contents', async () => {
    await withTempDir(async (dir) => {
        const path = join(dir, 'config.json')
        const fakeToken = 'mf_fake_token_must_not_leak'
        await writeFile(path, `{"token":"${fakeToken}"`)
        const err = await readJsonState(path).then(
            () => undefined,
            (reason: unknown) => reason as Error
        )
        assert.ok(err)
        assert.match(err.message, new RegExp(path))
        assert.doesNotMatch(err.message, new RegExp(fakeToken))
    })
})

test('readJsonState reports non-ENOENT I/O failures with the path and errno', async () => {
    await withTempDir(async (dir) => {
        const blocker = join(dir, 'blocker')
        const path = join(blocker, 'config.json')
        await writeFile(blocker, 'not a directory')
        await assert.rejects(
            () => readJsonState(path),
            (err: Error) =>
                err.message.includes(path) && err.message.includes('ENOTDIR')
        )
    })
})

test('protected JSON writes roundtrip with private directory and file modes', async () => {
    await withTempDir(async (dir) => {
        const stateDir = join(dir, 'state')
        const path = join(stateDir, 'config.json')
        const value = { apiUrl: 'https://api.test', token: 'mf_secret' }
        await writeProtectedJson(path, value)
        assert.deepEqual(await readJsonState(path), value)
        assert.equal((await stat(stateDir)).mode & 0o777, 0o700)
        assert.equal((await stat(path)).mode & 0o777, 0o600)
    })
})

test('a pre-rename write failure preserves the target and leaves no temp file', async () => {
    await withTempDir(async (dir) => {
        const fileName = `${'a'.repeat(230)}.json`
        const path = join(dir, fileName)
        await writeFile(path, 'original')
        await assert.rejects(() => writeProtectedFile(path, 'replacement'))
        assert.equal(await readFile(path, 'utf8'), 'original')
        assert.deepEqual(await readdir(dir), [fileName])
    })
})

test('a rename failure removes its temporary file', async () => {
    await withTempDir(async (dir) => {
        const path = join(dir, 'target')
        await mkdir(path)
        await assert.rejects(() => writeProtectedFile(path, 'replacement'))
        assert.deepEqual(await readdir(dir), ['target'])
    })
})
