import test from 'node:test'
import assert from 'node:assert/strict'
import {
    access,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rm,
    utimes,
    writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { createDaemonLog } from '../src/daemon/log-file'

const withTempDir = async (
    fn: (dir: string) => Promise<void>
): Promise<void> => {
    const dir = await mkdtemp(join(tmpdir(), 'mf-daemon-log-'))
    try {
        await fn(dir)
    } finally {
        await rm(dir, { recursive: true, force: true })
    }
}

test('one log call writes one line and optionally echoes the same line', async () => {
    await withTempDir(async (dir) => {
        const path = join(dir, 'daemon.log')
        let echoed = ''
        const echo = new Writable({
            write(chunk, _encoding, callback) {
                echoed += chunk.toString()
                callback()
            }
        })
        const logger = await createDaemonLog(path, { echo })
        await logger.log('hello once')
        await logger.close()
        const persisted = await readFile(path, 'utf8')
        assert.equal(persisted, echoed)
        assert.equal(persisted.split('\n').filter(Boolean).length, 1)
        assert.equal(persisted.match(/hello once/g)?.length, 1)

        const silentPath = join(dir, 'silent.log')
        const silentLogger = await createDaemonLog(silentPath)
        await silentLogger.log('persist without echo')
        await silentLogger.close()
        const silent = await readFile(silentPath, 'utf8')
        assert.equal(silent.split('\n').filter(Boolean).length, 1)
        assert.equal(silent.match(/persist without echo/g)?.length, 1)
    })
})

test('rotation keeps a fresh active log and a bounded backup count', async () => {
    await withTempDir(async (dir) => {
        const path = join(dir, 'daemon.log')
        const logger = await createDaemonLog(path, {
            maxBytes: 40,
            maxBackups: 2
        })
        await logger.log('first')
        await logger.log('second')
        await logger.log('third')
        await logger.close()
        assert.match(await readFile(path, 'utf8'), /third/)
        assert.match(await readFile(`${path}.1`, 'utf8'), /second/)
        assert.match(await readFile(`${path}.2`, 'utf8'), /first/)
        assert.deepEqual((await readdir(dir)).sort(), [
            'daemon.log',
            'daemon.log.1',
            'daemon.log.2'
        ])
    })
})

test('rotation shifts backups safely when a numbering gap exists', async () => {
    await withTempDir(async (dir) => {
        const path = join(dir, 'daemon.log')
        await writeFile(path, 'active\n')
        await writeFile(`${path}.2`, 'older\n')
        const logger = await createDaemonLog(path, {
            maxBytes: 1,
            maxBackups: 3
        })
        await logger.log('new')
        await logger.close()
        assert.equal(await readFile(`${path}.1`, 'utf8'), 'active\n')
        assert.equal(await readFile(`${path}.3`, 'utf8'), 'older\n')
        await assert.rejects(() => access(`${path}.2`))
        assert.match(await readFile(path, 'utf8'), /new/)
    })
})

test('rotation failures are deduplicated and logging continues', async () => {
    await withTempDir(async (dir) => {
        const path = join(dir, 'daemon.log')
        await writeFile(path, 'active\n')
        await mkdir(`${path}.1`)
        const errors: string[] = []
        const logger = await createDaemonLog(path, {
            maxBytes: 1,
            maxBackups: 1,
            onError: (message) => errors.push(message)
        })
        await logger.log('one')
        await logger.log('two')
        await logger.close()
        assert.equal(errors.length, 1)
        const active = await readFile(path, 'utf8')
        assert.match(active, /one/)
        assert.match(active, /two/)
    })
})

test('old backups are purged when a logger starts', async () => {
    await withTempDir(async (dir) => {
        const path = join(dir, 'daemon.log')
        const backup = `${path}.1`
        await writeFile(backup, 'old\n')
        const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
        await utimes(backup, old, old)
        const logger = await createDaemonLog(path, {
            maxBackups: 1,
            maxAgeDays: 1
        })
        await logger.close()
        await assert.rejects(() => access(backup))
    })
})

test('close flushes queued lines and later writes are no-ops', async () => {
    await withTempDir(async (dir) => {
        const path = join(dir, 'daemon.log')
        const logger = await createDaemonLog(path)
        void logger.log('queued before close')
        await logger.close()
        const before = await readFile(path, 'utf8')
        assert.match(before, /queued before close/)
        await logger.log('ignored after close')
        assert.equal(await readFile(path, 'utf8'), before)
    })
})
