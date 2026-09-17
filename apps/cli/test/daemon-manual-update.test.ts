import test from 'node:test'
import assert from 'node:assert/strict'
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    statSync,
    writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DaemonLocalHealth } from '../src/daemon/control'

// A daemon nobody supervises updates itself by driving the swap from the old
// process (ADR-0029 §5). Everything below runs against a scratch profile and
// fake successors: what is pinned is the order of operations, what lands on
// disk, and that a successor that never comes up puts the old binary back.

const home = mkdtempSync(join(tmpdir(), 'mf-manual-update-'))
process.env.HOME = home
process.env.MF_CONFIG_DIR = join(home, 'config')
process.env.MF_PROFILE = 'manualupdate'

const {
    handOffToSuccessor,
    keepPreviousBinary,
    precheckBinary,
    previousBinaryPath,
    readUpdateLatch,
    takeUpdateRollback,
    writeUpdateLatch
} = await import('../src/daemon/manual-update')
const { rpcHandler, setManualUpdateHandoff, manualUpdateCapable } =
    await import('../src/daemon/rpc')

const posix = process.platform !== 'win32'
let counter = 0
const scratch = (label: string): string => {
    const dir = join(home, `${label}-${++counter}`)
    mkdirSync(dir, { recursive: true })
    return dir
}

const health = (over: Partial<DaemonLocalHealth>): DaemonLocalHealth => ({
    status: 'running',
    pid: 1,
    version: '0.0.0',
    channel: 'stable',
    profile: 'manualupdate',
    daemonId: 'dh_1',
    apiUrl: 'http://127.0.0.1:1/api',
    startedAt: new Date().toISOString(),
    uptimeMs: 0,
    wsConnected: false,
    activeExecs: 0,
    activePtys: 0,
    updatePending: false,
    autoUpdate: false,
    startupMethod: 'manual',
    logPath: '/dev/null',
    ...over
})

test('the precheck runs the candidate and demands the target version from it', async () => {
    await precheckBinary('/opt/new', '2.0.0', async () => ({
        stdout: 'mf 2.0.0 (abc)\n'
    }))
    await assert.rejects(
        precheckBinary('/opt/new', '2.0.0', async () => ({
            stdout: 'mf 1.9.9\n'
        })),
        /reports "mf 1.9.9", not 2.0.0/
    )
    await assert.rejects(
        precheckBinary('/opt/new', '2.0.0', async () => {
            throw new Error('exec format error')
        }),
        /failed its precheck: exec format error/
    )
})

test(
    'the previous binary is kept as a hard link of the running one, replacing any older leftover',
    { skip: !posix },
    async () => {
        const dir = scratch('prev')
        const execPath = join(dir, 'mf')
        writeFileSync(execPath, 'current', { mode: 0o755 })
        writeFileSync(previousBinaryPath(execPath), 'stale leftover')
        const prev = await keepPreviousBinary(execPath)
        assert.equal(prev, `${execPath}.prev`)
        assert.equal(readFileSync(prev, 'utf8'), 'current')
        assert.equal(statSync(prev).ino, statSync(execPath).ino, 'same inode')
    }
)

test('the latch and the rollback marker round-trip, and the marker is taken once', async () => {
    const dir = scratch('markers')
    const latchPath = join(dir, 'update-latch.json')
    assert.equal(await readUpdateLatch(latchPath), null)
    await writeUpdateLatch(latchPath, {
        version: '2.0.0',
        reason: 'never came up',
        at: 'now'
    })
    assert.deepEqual(await readUpdateLatch(latchPath), {
        version: '2.0.0',
        reason: 'never came up',
        at: 'now'
    })
    const rollbackPath = join(dir, 'update-rollback.json')
    assert.equal(await takeUpdateRollback(rollbackPath), null)
    writeFileSync(
        rollbackPath,
        JSON.stringify({
            fromVersion: '1.0.0',
            toVersion: '2.0.0',
            reason: 'r',
            at: 'now'
        })
    )
    assert.deepEqual(await takeUpdateRollback(rollbackPath), {
        fromVersion: '1.0.0',
        toVersion: '2.0.0',
        reason: 'r',
        at: 'now'
    })
    assert.equal(existsSync(rollbackPath), false, 'reported once')
})

const handoffHarness = (opts: { comesUp: boolean; spawnThrows?: boolean }) => {
    const dir = scratch('handoff')
    const execPath = join(dir, 'mf')
    writeFileSync(execPath, 'new binary', { mode: 0o755 })
    writeFileSync(previousBinaryPath(execPath), 'old binary', { mode: 0o755 })
    const calls: string[] = []
    const spawned: string[] = []
    const killed: Array<[number, string]> = []
    let nextPid = 100
    const deps = {
        execPath,
        fromVersion: '1.0.0',
        toVersion: '2.0.0',
        stopServing: async () => {
            calls.push('stopServing')
        },
        spawnDaemon: (binary: string) => {
            calls.push(`spawn:${readFileSync(binary, 'utf8')}`)
            if (opts.spawnThrows) throw new Error('ENOEXEC')
            spawned.push(binary)
            return ++nextPid
        },
        health: async () =>
            opts.comesUp
                ? health({ pid: nextPid, version: '2.0.0', status: 'running' })
                : health({
                      pid: nextPid,
                      version: '1.0.0',
                      status: 'starting'
                  }),
        kill: (pid: number, signal: NodeJS.Signals) => {
            killed.push([pid, signal])
        },
        latchPath: join(dir, 'update-latch.json'),
        rollbackPath: join(dir, 'update-rollback.json'),
        watchdogMs: 200,
        sleep: async () => {},
        log: () => {}
    }
    return { deps, calls, spawned, killed, execPath }
}

test(
    'a successor that reports the target version running takes over, and the previous binary is dropped',
    { skip: !posix },
    async () => {
        const h = handoffHarness({ comesUp: true })
        const outcome = await handOffToSuccessor(h.deps)
        assert.deepEqual(outcome, { kind: 'handed-off', successorPid: 101 })
        assert.deepEqual(h.calls, ['stopServing', 'spawn:new binary'])
        assert.equal(existsSync(previousBinaryPath(h.execPath)), false)
        assert.deepEqual(h.killed, [])
        assert.equal(existsSync(h.deps.latchPath), false)
    }
)

test(
    'a successor that never comes up is stopped, the previous binary restored and relaunched, and the target latched',
    { skip: !posix },
    async () => {
        const h = handoffHarness({ comesUp: false })
        const outcome = await handOffToSuccessor(h.deps)
        assert.equal(outcome.kind, 'rolled-back')
        assert.deepEqual(h.calls, [
            'stopServing',
            'spawn:new binary',
            'spawn:old binary'
        ])
        assert.deepEqual(h.killed, [
            [101, 'SIGTERM'],
            [101, 'SIGKILL']
        ])
        assert.equal(readFileSync(h.execPath, 'utf8'), 'old binary', 'restored')
        assert.equal(existsSync(previousBinaryPath(h.execPath)), false)
        const latch = await readUpdateLatch(h.deps.latchPath)
        assert.equal(latch?.version, '2.0.0')
        assert.match(latch?.reason ?? '', /did not report 2.0.0 running/)
        const rollback = await takeUpdateRollback(h.deps.rollbackPath)
        assert.equal(rollback?.fromVersion, '1.0.0')
        assert.equal(rollback?.toVersion, '2.0.0')
    }
)

test(
    'a successor that cannot even be spawned rolls back without a watchdog wait',
    { skip: !posix },
    async () => {
        const h = handoffHarness({ comesUp: true, spawnThrows: true })
        const outcome = await handOffToSuccessor(h.deps)
        assert.equal(outcome.kind, 'rolled-back')
        assert.match(
            outcome.kind === 'rolled-back' ? outcome.reason : '',
            /failed to spawn/
        )
        assert.equal(readFileSync(h.execPath, 'utf8'), 'old binary')
    }
)

test('daemon.update refuses a manual start unless this daemon can hand off, in which case the update proceeds', async () => {
    setManualUpdateHandoff(null)
    assert.equal(manualUpdateCapable(), false)
    const refused = await rpcHandler(
        'daemon.update',
        {},
        { refId: 'u1', sendEvent: () => {}, onCancel: () => {} }
    )
    assert.equal(refused.ok, false)
    assert.match(refused.error ?? '', /not managed by an init unit/)
    setManualUpdateHandoff(async () => {})
    try {
        assert.equal(manualUpdateCapable(), true)
        // Past the gate: the coordinator runs the real self-update, which
        // refuses a source build before touching the network.
        const attempted = await rpcHandler(
            'daemon.update',
            {},
            { refId: 'u2', sendEvent: () => {}, onCancel: () => {} }
        )
        assert.equal(attempted.ok, false)
        assert.match(
            attempted.error ?? '',
            /self-update only works on installed mf binaries/
        )
    } finally {
        setManualUpdateHandoff(null)
    }
})
