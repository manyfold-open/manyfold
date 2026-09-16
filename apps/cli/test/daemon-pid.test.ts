import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
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

        const ownership = await claimDaemonPid(process.pid, paths)
        try {
            assert.equal(
                (await readFile(paths.pidPath, 'utf8')).trim(),
                `${process.pid}`
            )
            assert.equal(await runningDaemonPid(paths), process.pid)
            await clearDaemonPid(process.pid, paths)
            assert.equal(await readDaemonPid(paths), process.pid)
        } finally {
            await ownership.release()
        }
        assert.equal(await readDaemonPid(paths), null)
    })
})

test('concurrent claims and stale cleanup cannot remove a current owner', async () => {
    await withPaths(async (paths) => {
        const results = await Promise.allSettled([
            claimDaemonPid(process.pid, paths),
            claimDaemonPid(process.pid, paths)
        ])
        const accepted = results.filter(
            (result) => result.status === 'fulfilled'
        )
        try {
            assert.equal(accepted.length, 1)
            assert.equal(
                results.filter((result) => result.status === 'rejected').length,
                1
            )
            await clearDaemonPid(undefined, paths)
            assert.equal(await readDaemonPid(paths), process.pid)
        } finally {
            for (const result of accepted) await result.value?.release()
        }
        const next = await claimDaemonPid(process.pid, paths)
        try {
            for (const result of accepted) await result.value.release()
            assert.equal(await readDaemonPid(paths), process.pid)
        } finally {
            await next.release()
        }
    })
})

test('an ownership handle keeps its original profile when path getters change', async () => {
    await withPaths(async (first) => {
        const second = `${first.pidPath}.other`
        let current = first.pidPath
        const ownership = await claimDaemonPid(process.pid, {
            get pidPath() {
                return current
            }
        })
        current = second
        await writeFile(second, 'keep this other profile')
        await ownership.release()
        await assert.rejects(readFile(first.pidPath), { code: 'ENOENT' })
        assert.equal(await readFile(second, 'utf8'), 'keep this other profile')
    })
})

test('stale metadata from a previous process with the same PID does not block startup', async () => {
    await withPaths(async (paths) => {
        const oldInstance = randomUUID()
        await mkdir(`${paths.pidPath}.locks`)
        await writeFile(
            join(`${paths.pidPath}.locks`, 'owner.json'),
            JSON.stringify({ pid: process.pid, instanceId: oldInstance })
        )
        await writeFile(paths.pidPath, String(process.pid))
        const current = await claimDaemonPid(process.pid, paths)
        try {
            assert.notEqual(current.instanceId, oldInstance)
            assert.equal(await readDaemonPid(paths), process.pid)
        } finally {
            await current.release()
        }
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
