import assert from 'node:assert/strict'
import test from 'node:test'
import { SpritesError } from '@manyfold/sprites'
import type {
    ExecOptions,
    ExecResult,
    SpriteWriteFileArgs
} from '@manyfold/sprites'
import { SpriteKeepAliveLeaseService } from '../src/modules/agents/keep-alive/sprite-keepalive-lease.service'

// A service framework's processes on a sprite (hermes, openclaw): the start
// and report assets on the machine and the sprites Services API that runs
// them. Holding the machine awake is not this service's job
// (HostKeepAwakeService): nothing here places or releases a task.

const CLEAN_SUMMARY = JSON.stringify({
    deletedTasks: [],
    remainingTasks: [],
    killedPids: [],
    errors: []
})

const ok = (stdout: string): ExecResult => ({
    exitCode: 0,
    stdout,
    stderr: ''
})

const baseHost = (over: Record<string, unknown> = {}) => ({
    id: 'sbx_x',
    userId: 'u_1',
    kind: 'hosted',
    providerId: 'rtp_1',
    providerRef: { kind: 'sprites', spriteName: 'sprite-x', spriteId: 'sp_x' },
    status: 'ready',
    powerState: 'running',
    keepAwake: true,
    updatedAt: new Date('2026-06-04T00:00:00.000Z'),
    ...over
})

const baseRuntime = (over: Record<string, unknown> = {}) => ({
    id: 'art_x',
    framework: 'hermes',
    hostId: 'sbx_x',
    dashboardEnabled: false,
    capabilitiesJson: null as Record<string, unknown> | null,
    updatedAt: new Date('2026-06-04T00:00:00.000Z'),
    ...over
})

class TestLease extends SpriteKeepAliveLeaseService {
    clientThrows = false
    serviceCalls: string[] = []
    execCalls: Array<{ cmd: string[]; stdin: string }> = []
    writes: string[] = []
    spriteClient: Record<string, unknown> = {
        stopService: async () => {
            this.serviceCalls.push('stopService')
            return { state: { status: 'stopped' } }
        },
        getService: async () => {
            this.serviceCalls.push('getService')
            return { state: { status: 'stopped' } }
        },
        startService: async () => {
            this.serviceCalls.push('startService')
            return { state: { status: 'running' } }
        }
    }
    cleanupResult: ExecResult = ok(CLEAN_SUMMARY)

    protected async clientFor(): Promise<{
        client: never
        spriteName: string
    } | null> {
        if (this.clientThrows) return null
        return { client: this.spriteClient as never, spriteName: 'sprite-x' }
    }

    protected async exec(
        _client: never,
        _spriteName: string,
        opts: ExecOptions
    ): Promise<ExecResult> {
        this.execCalls.push({
            cmd: opts.cmd,
            stdin: typeof opts.stdin === 'string' ? opts.stdin : ''
        })
        return this.cleanupResult
    }

    protected async writeFile(
        _client: never,
        _spriteName: string,
        args: SpriteWriteFileArgs
    ): Promise<void> {
        this.writes.push(args.absPath)
    }
}

// Collapse recorded execs to their kind so ordering assertions stay readable:
// 'cleanup' (bash -s cleanup script), 'mv' (atomic start.sh swap).
const execKinds = (calls: Array<{ cmd: string[] }>): string[] =>
    calls.map((call) => (call.cmd[0] === 'mv' ? 'mv' : 'cleanup'))

const makeLease = (hostOver: Record<string, unknown> = {}) => {
    const host = baseHost(hostOver)
    const runtime = baseRuntime()
    const runtimePatches: Array<Record<string, unknown>> = []
    const db = {
        update: () => ({
            set: (payload: Record<string, unknown>) => {
                runtimePatches.push(payload)
                Object.assign(runtime, payload)
                return { where: async () => undefined }
            }
        })
    }
    const hosts = {
        findById: async (id: string) => (id === host.id ? host : null)
    }
    const runtimes = {
        findById: async () => runtime,
        applyServiceReportPatch: async () => undefined
    }
    const lease = new TestLease(
        db as never,
        hosts as never,
        {} as never,
        runtimes as never,
        {} as never,
        { get: () => undefined } as never
    )
    return { lease, host, runtime, runtimePatches }
}

test('ensureServiceRunning starts a stopped service through the sprites services API', async () => {
    const { lease } = makeLease()

    const res = await lease.ensureServiceRunning(baseRuntime() as never)

    assert.deepEqual(res, { started: true })
    assert.deepEqual(lease.serviceCalls, ['getService', 'startService'])
    assert.ok(lease.writes.some((path) => path.endsWith('/start.sh.tmp')))
})

test('ensureServiceRunning on a running service is a pure no-op', async () => {
    const { lease } = makeLease()
    lease.spriteClient.getService = async () => ({
        state: { status: 'running' }
    })

    const res = await lease.ensureServiceRunning(baseRuntime() as never)

    assert.deepEqual(res, { started: false })
    assert.deepEqual(lease.execCalls, [])
})

test('install writes the service start assets and nothing else', async () => {
    const { lease, runtimePatches } = makeLease()

    const meta = await lease.install({
        runtimeId: 'art_x',
        framework: 'hermes',
        serviceName: 'hermes',
        client: {} as never,
        spriteName: 'sprite-x',
        homeDir: '/home/sprite/.hermes',
        exec: ['hermes', 'gateway'],
        reportToken: 'report-token'
    })

    assert.equal(meta.desiredState, 'stopped')
    assert.deepEqual(execKinds(lease.execCalls), ['mv'])
    assert.ok(lease.writes.includes('/home/sprite/.hermes/start.sh.tmp'))
    const caps = runtimePatches.at(-1)?.capabilitiesJson as {
        keepAlive: { lastVerifiedAt?: string }
    }
    assert.ok(caps.keepAlive.lastVerifiedAt)
})

test('isSpritesNotFound-style 404 on stopService still counts the service as stopped', async () => {
    const { lease } = makeLease()
    lease.spriteClient.stopService = async () => {
        throw new SpritesError('not_found', 'service not found', 404)
    }

    const message = await lease.stopService(baseRuntime() as never)

    assert.equal(message, undefined)
})
