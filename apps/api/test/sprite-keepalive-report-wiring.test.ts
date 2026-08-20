import assert from 'node:assert/strict'
import test from 'node:test'
import type { ExecOptions, ExecResult, SpriteWriteFileArgs } from '@manyfold/sprites'
import { SpriteKeepAliveLeaseService } from '../src/modules/agents/keep-alive/sprite-keepalive-lease.service'

// Keep-alive report wiring (#108) through writeStartScript — the single choke
// point behind every service start path. These tests pin: the DB-first fence
// invariant, the 600/700 report asset modes, the degradation rule (reporting
// must never break a wake), the wake-path fence rotation, and the two
// platform-only service_status transitions (starting on ensure, stopped on
// stop — the ONLY downward writer).

const API_BASE_URL = 'https://api.example.test'
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

// One ordered event stream across DB updates, sprite file writes and service
// calls — the fence-before-disk and clear-before-stop contracts are pure
// ordering claims, so the assertions need a single timeline.
type TimelineEvent =
    | { kind: 'runtime-update'; fenceChangedTo?: string | null }
    | { kind: 'write'; path: string; mode?: string; body: string }
    | { kind: 'mv'; from: string; to: string }
    | { kind: 'stop-service' }
    | { kind: 'service-status'; status: string }

const baseRuntime = (over: Record<string, unknown> = {}) => ({
    id: 'art_x',
    framework: 'hermes',
    kind: 'sprites',
    accountId: 'acc_1',
    spriteName: 'sprite-x',
    homeDir: '/home/sprite/.hermes',
    capabilitiesJson: null as Record<string, unknown> | null,
    updatedAt: new Date('2026-06-11T00:00:00.000Z'),
    ...over
})

const keepAlive = (over: Record<string, unknown> = {}) => ({
    serviceName: 'hermes',
    taskPrefix: 'nca-hermes-x-',
    taskName: 'nca-hermes-x-gen0',
    generation: 'gen0',
    ttlSec: 300,
    refreshSec: 60,
    desiredState: 'stopped',
    stateDir: '/home/sprite/.hermes/.nca/keepalive',
    startScriptPath: '/home/sprite/.hermes/start.sh',
    exec: ['hermes', 'gateway'],
    legacyTaskNames: ['hermes-keepalive'],
    ...over
})

class TestLease extends SpriteKeepAliveLeaseService {
    timeline: TimelineEvent[] = []
    taskList: ExecResult = ok('{"tasks":[]}')
    spriteClient: Record<string, unknown> = {}

    protected async clientFor(): Promise<{
        account: never
        client: never
        spriteName: string
    } | null> {
        return {
            account: {} as never,
            client: this.spriteClient as never,
            spriteName: 'sprite-x'
        }
    }

    protected async exec(
        _client: never,
        _spriteName: string,
        opts: ExecOptions
    ): Promise<ExecResult> {
        if (opts.cmd[0] === 'mv')
            this.timeline.push({
                kind: 'mv',
                from: opts.cmd[2],
                to: opts.cmd[3]
            })
        return opts.cmd.includes('/v1/tasks')
            ? this.taskList
            : ok(CLEAN_SUMMARY)
    }

    protected async writeFile(
        _client: never,
        _spriteName: string,
        args: SpriteWriteFileArgs
    ): Promise<void> {
        this.timeline.push({
            kind: 'write',
            path: args.absPath,
            mode: args.mode,
            body: Buffer.isBuffer(args.body) ? args.body.toString('utf8') : ''
        })
    }
}

const makeHarness = (
    input: {
        // null = PUBLIC_API_BASE_URL unset (local dev)
        apiBaseUrl?: string | null
        // null = no agent_credentials row (ensureRuntimeReportToken -> null)
        credentialsToken?: string | null
        runtime?: Record<string, unknown>
    } = {}
) => {
    const store = baseRuntime(input.runtime)
    const timeline: TimelineEvent[] = []
    const servicePatches: Array<{
        id: string
        serviceStatus?: string
        serviceStatusAt?: Date
    }> = []
    const credentialsRow =
        input.credentialsToken == null
            ? null
            : {
                  runtimeId: store.id,
                  payloadCiphertext: JSON.stringify({
                      gatewayToken: 'gw-sibling',
                      runtimeReportToken: input.credentialsToken
                  }),
                  keyVersion: 1
              }
    const db = {
        select: () => ({
            from: () => ({
                where: () => ({
                    limit: () => ({
                        // credential-merge takes a row lock (.for('update'));
                        // the thenable keeps the plain non-locking await path
                        for: async () =>
                            credentialsRow ? [credentialsRow] : [],
                        then: (
                            resolve: (rows: unknown[]) => unknown
                        ): unknown =>
                            resolve(credentialsRow ? [credentialsRow] : [])
                    })
                })
            })
        }),
        update: () => ({
            set: (payload: Record<string, unknown>) => {
                // agent_credentials updates carry payloadCiphertext, runtime
                // patches carry capabilitiesJson — only the latter can move
                // the fence.
                if (payload.capabilitiesJson !== undefined) {
                    const report = (value: unknown): string | undefined =>
                        (
                            (value as Record<string, unknown> | null)
                                ?.serviceReport as
                                | { generation?: string }
                                | undefined
                        )?.generation
                    const prev = report(store.capabilitiesJson)
                    const next = report(payload.capabilitiesJson)
                    timeline.push({
                        kind: 'runtime-update',
                        fenceChangedTo:
                            next !== prev ? (next ?? null) : undefined
                    })
                    Object.assign(store, payload)
                }
                return { where: async () => undefined }
            }
        }),
        transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db)
    }
    const runtimes = {
        findById: async () => store,
        applyServiceReportPatch: async (
            id: string,
            patch: { serviceStatus?: string; serviceStatusAt?: Date }
        ) => {
            timeline.push({
                kind: 'service-status',
                status: patch.serviceStatus ?? ''
            })
            servicePatches.push({ id, ...patch })
        }
    }
    const crypto = {
        decrypt: ({ ciphertext }: { ciphertext: string }) => ciphertext,
        encrypt: (plain: string) => ({ ciphertext: plain, keyVersion: 2 })
    }
    const apiBaseUrl =
        input.apiBaseUrl === null ? undefined : (input.apiBaseUrl ?? API_BASE_URL)
    const config = {
        get: (key: string) =>
            key === 'PUBLIC_API_BASE_URL' ? apiBaseUrl : undefined
    }
    const lease = new TestLease(
        db as never,
        {} as never,
        runtimes as never,
        { event: () => undefined } as never,
        {} as never,
        crypto as never,
        config as never
    )
    lease.timeline = timeline
    lease.spriteClient = {
        getService: async () => ({ state: { status: 'stopped' } }),
        startService: async () => ({ state: { status: 'running' } }),
        stopService: async () => {
            timeline.push({ kind: 'stop-service' })
            return { state: { status: 'stopped' } }
        }
    }
    return { lease, store, timeline, servicePatches }
}

const installInput = () => ({
    runtimeId: 'art_x',
    framework: 'hermes' as const,
    serviceName: 'hermes' as const,
    client: {} as never,
    spriteName: 'sprite-x',
    homeDir: '/home/sprite/.hermes',
    exec: ['hermes', 'gateway'],
    legacyTaskNames: ['hermes-keepalive'],
    reportToken: 'tok-install'
})

const writesTo = (timeline: TimelineEvent[], suffix: string) =>
    timeline.filter(
        (event): event is Extract<TimelineEvent, { kind: 'write' }> =>
            event.kind === 'write' && event.path.endsWith(suffix)
    )

test('writeStartScript records the fence generation in the DB BEFORE any sprite write', async () => {
    const { lease, timeline } = makeHarness()

    const meta = await lease.install(installInput())

    const fenceIdx = timeline.findIndex(
        (event) =>
            event.kind === 'runtime-update' &&
            event.fenceChangedTo === meta.generation
    )
    const firstWriteIdx = timeline.findIndex((event) => event.kind === 'write')
    assert.notEqual(
        fenceIdx,
        -1,
        'capabilitiesJson.serviceReport must record the new generation'
    )
    assert.notEqual(firstWriteIdx, -1, 'install must write the report assets')
    assert.ok(
        fenceIdx < firstWriteIdx,
        'DB-first invariant: every generation that ever exists on sprite disk must already be recorded in the DB — a disk-first order would let a fast boot POST a truthful report the handler cannot verify and reject it'
    )
})

test('report.env is 600 carrying token/generation/healthUrl, report.sh is 700, start.sh spawns the reporter', async () => {
    const { lease, timeline } = makeHarness()

    const meta = await lease.install(installInput())

    const env = writesTo(timeline, '/report.env.tmp')
    assert.equal(env.length, 1, 'exactly one report.env write')
    assert.equal(
        env[0].mode,
        '600',
        'report.env holds the bearer token — owner-only read, never the 755 start.sh exposure class'
    )
    assert.ok(
        timeline.some(
            (event) =>
                event.kind === 'mv' && event.to.endsWith('/report.env')
        ),
        // WHY: the in-flight reporter re-sources report.env on every POST
        // attempt, racing exactly this rewrite — tmp + mv keeps every source
        // atomic, like the start.sh contract.
        'report.env must land via tmp + mv, never a direct write'
    )
    assert.ok(
        env[0].body.includes("RUNTIME_REPORT_TOKEN='tok-install'"),
        'the reporter authenticates with the per-runtime token'
    )
    assert.ok(
        env[0].body.includes(`RUNTIME_REPORT_GENERATION='${meta.generation}'`),
        'the on-disk generation must be the exact value the DB fence records'
    )
    assert.ok(
        env[0].body.includes(
            "RUNTIME_REPORT_HEALTH_URL='http://127.0.0.1:8642/v1/health'"
        ),
        'hermes probes the same unauthenticated path the k8s readiness probe uses in production'
    )
    assert.ok(
        env[0].body.includes(
            `RUNTIME_REPORT_URL='${API_BASE_URL}/api/internal/runtime-reports'`
        ),
        'reports land on the internal endpoint under the global api prefix'
    )
    const script = writesTo(timeline, '/report.sh')
    assert.equal(script.length, 1, 'exactly one report.sh write')
    assert.equal(script[0].mode, '700', 'report.sh is owner-only executable')
    const start = writesTo(timeline, '/start.sh.tmp')
    assert.equal(start.length, 1)
    assert.ok(
        start[0].body.includes(
            "[ -x '/home/sprite/.hermes/.nca/keepalive/report.sh' ] && setsid nohup bash"
        ),
        'start.sh must spawn the reporter guarded and detached on every boot — including the PID-1 thaw re-exec a standalone daemon would miss'
    )
})

test('missing report token (no credentials row) degrades to the plain start.sh without breaking the wake', async () => {
    const { lease, store, timeline } = makeHarness({
        credentialsToken: null,
        runtime: { capabilitiesJson: { keepAlive: keepAlive() } }
    })

    const res = await lease.ensureServiceRunning(store as never)

    // WHY: reporting must never break a wake — a missing credentials row
    // (in-flight provision, legacy fleet) skips the reporter this round.
    assert.deepEqual(res, { started: true })
    const writes = timeline.filter((event) => event.kind === 'write')
    assert.equal(writes.length, 1, 'no report.env / report.sh writes')
    assert.ok(writes[0].path.endsWith('/start.sh.tmp'))
    assert.ok(
        !writes[0].body.includes('report.sh'),
        'degraded start.sh is the plain Phase 2 script — no reporter spawn line'
    )
    assert.ok(
        !timeline.some(
            (event) =>
                event.kind === 'runtime-update' &&
                event.fenceChangedTo !== undefined
        ),
        'no fence may be recorded when no report assets land on disk'
    )
})

test('unset PUBLIC_API_BASE_URL degrades to the plain start.sh even when a token exists', async () => {
    const { lease, store, timeline } = makeHarness({
        apiBaseUrl: null,
        credentialsToken: 'tok-stored',
        runtime: { capabilitiesJson: { keepAlive: keepAlive() } }
    })

    const res = await lease.ensureServiceRunning(store as never)

    // WHY: local dev has no public ingress for the sprite to POST to —
    // the wake must still succeed with the plain Phase 2 start.sh.
    assert.deepEqual(res, { started: true })
    const writes = timeline.filter((event) => event.kind === 'write')
    assert.equal(writes.length, 1, 'no report.env / report.sh writes')
    assert.ok(writes[0].path.endsWith('/start.sh.tmp'))
    assert.ok(!writes[0].body.includes('report.sh'))
    assert.ok(
        !timeline.some(
            (event) =>
                event.kind === 'runtime-update' &&
                event.fenceChangedTo !== undefined
        ),
        'no fence may be recorded when no report assets land on disk'
    )
})

test('ensureLease rewrites the fence to its freshly minted generation', async () => {
    const { lease, store, timeline } = makeHarness({
        credentialsToken: 'tok-stored',
        runtime: {
            keepAliveEnabled: true,
            capabilitiesJson: {
                keepAlive: keepAlive(),
                serviceReport: { generation: 'gen0' }
            }
        }
    })
    lease.taskList = ok(
        JSON.stringify({ tasks: [{ name: 'nca-hermes-x-live' }] })
    )

    await lease.ensureLease(store as never)

    const caps = store.capabilitiesJson as {
        keepAlive: { generation: string }
        serviceReport: { generation: string }
    }
    assert.notEqual(
        caps.keepAlive.generation,
        'gen0',
        'ensureLease mints a fresh generation'
    )
    // WHY: the wake path rotates the generation seconds after the service
    // boots (ensureServiceRunning then ensureLease) — if the fence stayed at
    // the boot-time value, every wake would 409 its own ready report.
    assert.equal(
        caps.serviceReport.generation,
        caps.keepAlive.generation,
        'the DB fence must follow the freshly minted generation'
    )
    const env = writesTo(timeline, '/report.env.tmp')
    assert.equal(env.length, 1)
    assert.ok(
        env[0].body.includes(
            `RUNTIME_REPORT_GENERATION='${caps.keepAlive.generation}'`
        ),
        'report.env carries the same minted generation the fence records — the re-sourcing reporter picks it up at ready time'
    )
    const fenceIdx = timeline.findIndex(
        (event) =>
            event.kind === 'runtime-update' &&
            event.fenceChangedTo === caps.keepAlive.generation
    )
    const firstWriteIdx = timeline.findIndex((event) => event.kind === 'write')
    assert.ok(
        fenceIdx !== -1 && fenceIdx < firstWriteIdx,
        'the DB-first invariant holds on the lease path too'
    )
})

test('ensureServiceRunning sets serviceStatus starting only when it actually starts the service', async () => {
    const { lease, store, servicePatches } = makeHarness({
        credentialsToken: 'tok-stored',
        runtime: { capabilitiesJson: { keepAlive: keepAlive() } }
    })

    const res = await lease.ensureServiceRunning(store as never)

    assert.deepEqual(res, { started: true })
    assert.equal(servicePatches.length, 1)
    assert.equal(
        servicePatches[0].serviceStatus,
        'starting',
        'the platform may only assert starting — startService means the process spawned, and ready is reserved for health-probe-backed reports'
    )
    assert.ok(servicePatches[0].serviceStatusAt instanceof Date)

    const idle = makeHarness({
        credentialsToken: 'tok-stored',
        runtime: { capabilitiesJson: { keepAlive: keepAlive() } }
    })
    idle.lease.spriteClient.getService = async () => ({
        state: { status: 'running' }
    })

    const noop = await idle.lease.ensureServiceRunning(idle.store as never)

    assert.deepEqual(noop, { started: false })
    assert.equal(
        idle.servicePatches.length,
        0,
        'a no-op wake on a running service asserts nothing — service_status_at anchors real platform transitions only'
    )
})

test('runStopAndRelease clears the fence BEFORE stopService and writes stopped after', async () => {
    const { lease, store, timeline, servicePatches } = makeHarness({
        credentialsToken: 'tok-stored',
        runtime: {
            capabilitiesJson: {
                keepAlive: keepAlive(),
                serviceReport: { generation: 'gen0' }
            }
        }
    })

    const res = await lease.stopAndRelease(store as never, 'user-stop')

    assert.equal(res.state, 'verified')
    const clearIdx = timeline.findIndex(
        (event) =>
            event.kind === 'runtime-update' && event.fenceChangedTo === null
    )
    const stopIdx = timeline.findIndex((event) => event.kind === 'stop-service')
    const stoppedIdx = timeline.findIndex(
        (event) => event.kind === 'service-status' && event.status === 'stopped'
    )
    assert.notEqual(
        clearIdx,
        -1,
        'stop must clear capabilitiesJson.serviceReport'
    )
    assert.notEqual(stopIdx, -1, 'stopService must be attempted')
    assert.notEqual(stoppedIdx, -1, 'service_status must land on stopped')
    assert.ok(
        clearIdx < stopIdx,
        'fence cleared BEFORE stopService: in-flight reports from the dying boot must 409 as stale even before the stopped guards land'
    )
    assert.ok(
        stopIdx < stoppedIdx,
        'stopped is stamped after the stop attempt — the platform stop path is the ONLY downward writer of service_status; no report-driven path can produce it'
    )
    assert.deepEqual(
        servicePatches.map((patch) => patch.serviceStatus),
        ['stopped'],
        'exactly one service_status write on the stop path'
    )
})