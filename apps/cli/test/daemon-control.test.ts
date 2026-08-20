import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
    controlSocketPathFor,
    queryDaemonHealth,
    startControlServer,
    waitForDaemonHealth,
    type DaemonLocalHealth
} from '../src/daemon/control'

const onUnix = process.platform !== 'win32'

const makeHealth = (
    overrides: Partial<DaemonLocalHealth> = {}
): DaemonLocalHealth => ({
    status: 'running',
    pid: process.pid,
    version: '0.0.0-test',
    channel: 'stable',
    profile: 'default',
    daemonId: 'dae_test',
    apiUrl: 'https://api.test/api',
    startedAt: new Date(0).toISOString(),
    uptimeMs: 1,
    wsConnected: true,
    activeExecs: 0,
    activePtys: 0,
    updatePending: false,
    autoUpdate: false,
    startupMethod: 'manual',
    logPath: '/tmp/daemon.log',
    ...overrides
})

const withSocketDir = async (
    fn: (socketPath: string) => Promise<void>
): Promise<void> => {
    const dir = await mkdtemp(join(tmpdir(), 'mf-ctl-'))
    try {
        await fn(join(dir, 'daemon.sock'))
    } finally {
        await rm(dir, { recursive: true, force: true })
    }
}

test('daemon status reads health locally without any API', {
    skip: !onUnix
}, async () => {
    await withSocketDir(async (socketPath) => {
        const stop = await startControlServer({
            socketPath,
            getHealth: () => makeHealth({ activeExecs: 2 })
        })
        try {
            const health = await queryDaemonHealth(socketPath)
            assert.ok(health)
            assert.equal(health.status, 'running')
            assert.equal(health.activeExecs, 2)
            assert.equal(health.pid, process.pid)
        } finally {
            await stop()
        }
        assert.equal(
            await queryDaemonHealth(socketPath),
            null,
            'socket must be gone after close so status reports not-running'
        )
    })
})

test('daemon start can gate on readiness, not just a pidfile', {
    skip: !onUnix
}, async () => {
    await withSocketDir(async (socketPath) => {
        let status: DaemonLocalHealth['status'] = 'starting'
        const stop = await startControlServer({
            socketPath,
            getHealth: () => makeHealth({ status })
        })
        try {
            setTimeout(() => {
                status = 'running'
            }, 300)
            const health = await waitForDaemonHealth(socketPath, {
                timeoutMs: 5_000
            })
            assert.equal(health?.status, 'running')
        } finally {
            await stop()
        }
    })
})

test('a stale socket left by SIGKILL is reclaimed on the next start', {
    skip: !onUnix
}, async () => {
    await withSocketDir(async (socketPath) => {
        await writeFile(socketPath, '')
        const stop = await startControlServer({
            socketPath,
            getHealth: () => makeHealth()
        })
        try {
            const health = await queryDaemonHealth(socketPath)
            assert.equal(health?.status, 'running')
        } finally {
            await stop()
        }
    })
})

test('a live control socket refuses a second daemon', {
    skip: !onUnix
}, async () => {
    await withSocketDir(async (socketPath) => {
        const stop = await startControlServer({
            socketPath,
            getHealth: () => makeHealth()
        })
        try {
            await assert.rejects(
                startControlServer({
                    socketPath,
                    getHealth: () => makeHealth()
                }),
                /already serving/
            )
        } finally {
            await stop()
        }
    })
})

test('query on a missing socket resolves null instead of throwing', async () => {
    await withSocketDir(async (socketPath) => {
        assert.equal(await queryDaemonHealth(socketPath), null)
    })
})

test('windows uses a named pipe derived from the state dir', () => {
    const a = controlSocketPathFor('C:\\Users\\a\\.manyfold\\daemon')
    const b = controlSocketPathFor('C:\\Users\\b\\.manyfold\\daemon')
    if (process.platform === 'win32') {
        assert.match(a, /^\\\\\.\\pipe\\mf-daemon-/)
        assert.notEqual(a, b)
    } else {
        assert.ok(a.endsWith('daemon.sock'))
    }
})
