import test from 'node:test'
import assert from 'node:assert/strict'
import {
    access,
    appendFile,
    mkdtemp,
    readFile,
    rename,
    rm,
    stat,
    writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { boundErrSink, followFile, readLastLines } from '../src/daemon/log-file'
import { parseLineCount } from '../src/commands/daemon/logs'

const withTempDir = async (
    fn: (dir: string) => Promise<void>
): Promise<void> => {
    const dir = await mkdtemp(join(tmpdir(), 'mf-daemon-tail-'))
    try {
        await fn(dir)
    } finally {
        await rm(dir, { recursive: true, force: true })
    }
}

const delay = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms))

const waitFor = async (predicate: () => boolean): Promise<void> => {
    const deadline = Date.now() + 2_000
    while (!predicate()) {
        if (Date.now() >= deadline)
            throw new Error('timed out waiting for data')
        await delay(10)
    }
}

test('readLastLines handles empty, short, exact, and unterminated logs', async () => {
    await withTempDir(async (dir) => {
        const path = join(dir, 'daemon.log')
        await writeFile(path, '')
        assert.equal((await readLastLines(path, 5)).toString(), '')
        await writeFile(path, 'one\ntwo\n')
        assert.equal((await readLastLines(path, 5)).toString(), 'one\ntwo\n')
        assert.equal((await readLastLines(path, 2)).toString(), 'one\ntwo\n')
        await writeFile(path, 'one\ntwo\nthree')
        assert.equal((await readLastLines(path, 2)).toString(), 'two\nthree')
        assert.equal((await readLastLines(path, 0)).toString(), '')
    })
})

test('readLastLines defaults to 50 lines', async () => {
    await withTempDir(async (dir) => {
        const path = join(dir, 'daemon.log')
        const lines = Array.from(
            { length: 60 },
            (_, index) => `line-${index + 1}`
        )
        await writeFile(path, `${lines.join('\n')}\n`)
        assert.equal(
            (await readLastLines(path)).toString(),
            `${lines.slice(-50).join('\n')}\n`
        )
    })
})

test('readLastLines preserves multibyte text across chunk boundaries', async () => {
    await withTempDir(async (dir) => {
        const path = join(dir, 'daemon.log')
        await writeFile(path, 'prefix-😀😀😀\nsecond-雪\nthird-🚀\n')
        assert.equal(
            (await readLastLines(path, 2, { chunkSize: 16 })).toString(),
            'second-雪\nthird-🚀\n'
        )
    })
})

test('readLastLines reads only a bounded suffix for a small tail', async () => {
    await withTempDir(async (dir) => {
        const path = join(dir, 'daemon.log')
        const lines = Array.from(
            { length: 1_000 },
            (_, index) => `${String(index).padStart(4, '0')}-${'x'.repeat(90)}`
        )
        await writeFile(path, `${lines.join('\n')}\n`)
        let bytesRead = 0
        const chunkSize = 128
        const tail = await readLastLines(path, 3, {
            chunkSize,
            onChunk: (bytes) => {
                bytesRead += bytes
            }
        })
        const expected = Buffer.from(`${lines.slice(-3).join('\n')}\n`)
        assert.deepEqual(tail, expected)
        assert.ok(bytesRead <= expected.length + 2 * chunkSize)
    })
})

test('followFile emits appended bytes and resolves on abort', async () => {
    await withTempDir(async (dir) => {
        const path = join(dir, 'daemon.log')
        await writeFile(path, 'existing\n')
        const controller = new AbortController()
        const chunks: Buffer[] = []
        const following = followFile(
            path,
            (await stat(path)).size,
            (data) => {
                chunks.push(data)
            },
            { pollMs: 10, signal: controller.signal }
        )
        await delay(20)
        await appendFile(path, Buffer.from('new-雪\n'))
        await waitFor(() =>
            Buffer.concat(chunks).includes(Buffer.from('new-雪'))
        )
        controller.abort()
        await following
        assert.equal(Buffer.concat(chunks).toString(), 'new-雪\n')
    })
})

test('followFile restarts at zero after truncation', async () => {
    await withTempDir(async (dir) => {
        const path = join(dir, 'daemon.log')
        await writeFile(path, 'existing-content\n')
        const controller = new AbortController()
        const chunks: Buffer[] = []
        const following = followFile(
            path,
            (await stat(path)).size,
            (data) => {
                chunks.push(data)
            },
            { pollMs: 10, signal: controller.signal }
        )
        await delay(20)
        await writeFile(path, '')
        await delay(30)
        await appendFile(path, 'after-truncate\n')
        await waitFor(() => Buffer.concat(chunks).includes('after-truncate'))
        controller.abort()
        await following
        assert.equal(Buffer.concat(chunks).toString(), 'after-truncate\n')
    })
})

test('followFile waits for a missing file to be created', async () => {
    await withTempDir(async (dir) => {
        const path = join(dir, 'daemon.log')
        const controller = new AbortController()
        const chunks: Buffer[] = []
        const following = followFile(
            path,
            0,
            (data) => {
                chunks.push(data)
            },
            { pollMs: 10, signal: controller.signal }
        )
        await delay(20)
        await writeFile(path, 'created\n')
        await waitFor(() => chunks.length > 0)
        controller.abort()
        await following
        assert.equal(Buffer.concat(chunks).toString(), 'created\n')
    })
})

test('followFile detects rename rotation by inode', async () => {
    await withTempDir(async (dir) => {
        const path = join(dir, 'daemon.log')
        await writeFile(path, 'existing\n')
        const controller = new AbortController()
        const chunks: Buffer[] = []
        const following = followFile(
            path,
            (await stat(path)).size,
            (data) => {
                chunks.push(data)
            },
            { pollMs: 10, signal: controller.signal }
        )
        await delay(20)
        await rename(path, `${path}.1`)
        await writeFile(path, 'rotated\n')
        await waitFor(() => Buffer.concat(chunks).includes('rotated'))
        controller.abort()
        await following
        assert.equal(Buffer.concat(chunks).toString(), 'rotated\n')
    })
})

test('boundErrSink leaves small files alone and bounds oversized files', async () => {
    await withTempDir(async (dir) => {
        const path = join(dir, 'daemon.err.log')
        await boundErrSink(path, { maxBytes: 4 })
        await writeFile(path, '1234')
        await boundErrSink(path, { maxBytes: 4 })
        assert.equal(await readFile(path, 'utf8'), '1234')
        await assert.rejects(() => access(`${path}.1`))
        await writeFile(path, '0123456789')
        await boundErrSink(path, { maxBytes: 4 })
        assert.equal(await readFile(`${path}.1`, 'utf8'), '6789')
        assert.equal((await stat(path)).size, 0)
    })
})

test('parseLineCount accepts non-negative integers and rejects other input', () => {
    assert.equal(parseLineCount('0'), 0)
    assert.equal(parseLineCount('50'), 50)
    for (const invalid of ['-1', '1.5', 'abc', ''])
        assert.throws(() => parseLineCount(invalid), /integer/)
})
