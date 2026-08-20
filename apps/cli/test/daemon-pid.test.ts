import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
    claimDaemonPid,
    clearDaemonPid,
    DaemonAlreadyRunningError,
    readDaemonPid,
    runningDaemonPid,
    type DaemonPidPaths
} from '../src/daemon/pid'

const withPaths = async (
    fn: (paths: DaemonPidPaths) => Promise<void>
): Promise<void> => {
    const dir = await mkdtemp(join(tmpdir(), 'mf-daemon-pid-'))
    const paths = {
        pidPath: join(dir, 'daemon.pid')
    }
    try {
        await fn(paths)
    } finally {
        await rm(dir, { recursive: true, force: true })
    }
}

test('claimDaemonPid refuses to replace a live daemon pid', async () => {
    await withPaths(async (paths) => {
        await writeFile(paths.pidPath, `${process.pid}\n`, 'utf8')

        await assert.rejects(
            () => claimDaemonPid(process.pid + 1, paths),
            DaemonAlreadyRunningError
        )
        assert.equal(await readDaemonPid(paths), process.pid)
    })
})

test('claimDaemonPid replaces a stale pidfile', async () => {
    await withPaths(async (paths) => {
        await writeFile(paths.pidPath, '99999999\n', 'utf8')

        await claimDaemonPid(process.pid, paths)

        assert.equal(
            (await readFile(paths.pidPath, 'utf8')).trim(),
            `${process.pid}`
        )
        assert.equal(await runningDaemonPid(paths), process.pid)
    })
})

test('clearDaemonPid only removes the pid it owns', async () => {
    await withPaths(async (paths) => {
        await writeFile(paths.pidPath, `${process.pid}\n`, 'utf8')

        await clearDaemonPid(process.pid + 1, paths)
        assert.equal(await readDaemonPid(paths), process.pid)

        await clearDaemonPid(process.pid, paths)
        assert.equal(await readDaemonPid(paths), null)
    })
})
