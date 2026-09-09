import assert from 'node:assert/strict'
import test from 'node:test'
import { ApiError, type NcaClient } from '@manyfold/sdk'
import type { FrameworkUpgradeEvent } from '@manyfold/shared'
import { apiErrorMessage } from '../src/lib/errorMessage'
import type { BatchStep } from '../src/lib/updateCenter'
import { updateRunStore, type RowRun } from '../src/lib/updateRunStore'

// Mirrors the store's constant: the pacing window is identified by its delay,
// so the harness can assert what the loop waited for.
const DAEMON_RATE_WINDOW_MS = 62_000

const clock = { now: 0 }
let sleeps: number[] = []
let onSleep: ((ms: number) => void) | null = null

test.beforeEach(() => {
    clock.now = 0
    sleeps = []
    onSleep = null
    updateRunStore.setTimers({
        now: () => clock.now,
        sleep: async (ms) => {
            sleeps.push(ms)
            onSleep?.(ms)
            clock.now += ms
        }
    })
})

test.afterEach(() => {
    updateRunStore.clear()
    updateRunStore.setTimers(null)
})

interface SkillBatchBody {
    skillId: string
    agentIds: string[]
}

interface SkillBatchResult {
    results: Array<{
        agentId: string
        status: 'installed' | 'failed'
        error?: string
    }>
}

interface CliCall {
    id: string
    targetVersion: string | undefined
}

interface Calls {
    order: string[]
    installBatch: SkillBatchBody[]
    upgradeCli: CliCall[]
    upgradeHost: CliCall[]
    upgradeFramework: Array<{ agentId: string; targetVersion: string }>
    upgradeFrameworkStream: Array<{ agentId: string; targetVersion: string }>
}

interface Overrides {
    installBatch?: (body: SkillBatchBody) => Promise<SkillBatchResult>
    upgradeCli?: (sandboxId: string) => Promise<unknown>
    upgradeHost?: (hostId: string) => Promise<unknown>
    upgradeFramework?: (
        agentId: string,
        targetVersion: string
    ) => Promise<unknown>
    upgradeFrameworkStream?: (
        agentId: string,
        targetVersion: string,
        onEvent: (event: FrameworkUpgradeEvent) => void
    ) => Promise<unknown>
}

// Only the five methods the driver calls. Every default call advances the fake
// clock by a second so pacing arithmetic has something to measure.
const fakeClient = (
    over: Overrides = {}
): { client: NcaClient; calls: Calls } => {
    const calls: Calls = {
        order: [],
        installBatch: [],
        upgradeCli: [],
        upgradeHost: [],
        upgradeFramework: [],
        upgradeFrameworkStream: []
    }
    const client = {
        skills: {
            installBatch: async (
                body: SkillBatchBody
            ): Promise<SkillBatchResult> => {
                calls.order.push('installBatch')
                calls.installBatch.push(body)
                clock.now += 1_000
                if (over.installBatch) return over.installBatch(body)
                return {
                    results: body.agentIds.map((agentId) => ({
                        agentId,
                        status: 'installed' as const
                    }))
                }
            }
        },
        sandboxes: {
            upgradeCli: async (
                sandboxId: string,
                targetVersion?: string
            ): Promise<unknown> => {
                calls.order.push('upgradeCli')
                calls.upgradeCli.push({ id: sandboxId, targetVersion })
                clock.now += 1_000
                return over.upgradeCli ? over.upgradeCli(sandboxId) : {}
            }
        },
        daemons: {
            upgradeHost: async (
                hostId: string,
                targetVersion?: string
            ): Promise<unknown> => {
                calls.order.push('upgradeHost')
                calls.upgradeHost.push({ id: hostId, targetVersion })
                clock.now += 1_000
                return over.upgradeHost
                    ? over.upgradeHost(hostId)
                    : { ok: true }
            }
        },
        agents: {
            upgradeFramework: async (
                agentId: string,
                targetVersion: string
            ): Promise<unknown> => {
                calls.order.push('upgradeFramework')
                calls.upgradeFramework.push({ agentId, targetVersion })
                clock.now += 1_000
                return over.upgradeFramework
                    ? over.upgradeFramework(agentId, targetVersion)
                    : {}
            },
            upgradeFrameworkStream: async (
                agentId: string,
                targetVersion: string,
                onEvent: (event: FrameworkUpgradeEvent) => void
            ): Promise<unknown> => {
                calls.order.push('upgradeFrameworkStream')
                calls.upgradeFrameworkStream.push({ agentId, targetVersion })
                clock.now += 1_000
                return over.upgradeFrameworkStream
                    ? over.upgradeFrameworkStream(
                          agentId,
                          targetVersion,
                          onEvent
                      )
                    : undefined
            }
        }
    }
    return { client: client as unknown as NcaClient, calls }
}

const skillStep = (skillId: string, agentIds: string[]): BatchStep => ({
    type: 'skillBatch',
    skillId,
    agentIds,
    rowIds: agentIds.map((agentId) => `skill:${agentId}:${skillId}`)
})
const sandboxStep = (
    n: number,
    targetVersion: string | null = null
): BatchStep => ({
    type: 'sandboxCli',
    rowId: `cli:sandbox:sbx_${n}`,
    sandboxId: `sbx_${n}`,
    targetVersion
})
const daemonStep = (
    n: number,
    targetVersion: string | null = null
): BatchStep => ({
    type: 'daemonCli',
    rowId: `cli:daemon:dmn_${n}`,
    hostId: `dmn_${n}`,
    targetVersion
})
const frameworkStep = (mode: 'npm' | 'rebuild', n: number): BatchStep => ({
    type: 'framework',
    rowId: `framework:art_${n}`,
    agentId: `agt_${n}`,
    framework: mode === 'rebuild' ? 'hermes' : 'claude-code',
    mode,
    targetVersion: '2.1.0'
})
const rowIdsOf = (steps: BatchStep[]): string[] =>
    steps.flatMap((step) =>
        step.type === 'skillBatch' ? step.rowIds : [step.rowId]
    )

const runOf = (id: string): RowRun | undefined =>
    updateRunStore.getState().runs[id]
const finished = (): boolean =>
    updateRunStore.getState().batch?.state === 'finished'

const tick = (): Promise<void> =>
    new Promise((resolve) => setImmediate(resolve))

const waitFor = async (predicate: () => boolean): Promise<void> => {
    for (let i = 0; i < 1_000; i += 1) {
        if (predicate()) return
        await tick()
    }
    throw new Error('condition not reached')
}

const settle = async (): Promise<void> => {
    for (let i = 0; i < 20; i += 1) await tick()
}

const deferred = <T>(): {
    promise: Promise<T>
    resolve: (value: T) => void
} => {
    let resolve: (value: T) => void = () => undefined
    const promise = new Promise<T>((r) => {
        resolve = r
    })
    return { promise, resolve }
}

test('a started batch dispatches every step with no page mounted and no subscriber', async () => {
    const { client, calls } = fakeClient()
    const steps = [
        skillStep('skl_a', ['agt_1', 'agt_2']),
        sandboxStep(1),
        frameworkStep('npm', 1)
    ]
    const rowIds = rowIdsOf(steps)
    clock.now = 5_000

    assert.equal(updateRunStore.start(client, steps, rowIds), true)
    await waitFor(finished)

    const { batch, runs } = updateRunStore.getState()
    assert.deepEqual(calls.order, [
        'installBatch',
        'upgradeCli',
        'upgradeFramework'
    ])
    assert.deepEqual(calls.installBatch, [
        { skillId: 'skl_a', agentIds: ['agt_1', 'agt_2'] }
    ])
    assert.deepEqual(calls.upgradeCli, [
        { id: 'sbx_1', targetVersion: undefined }
    ])
    assert.deepEqual(calls.upgradeFramework, [
        { agentId: 'agt_1', targetVersion: '2.1.0' }
    ])
    assert.deepEqual(batch, {
        id: batch?.id,
        state: 'finished',
        succeeded: 4,
        failed: 0,
        rowIds,
        startedAt: 5_000,
        finishedAt: 8_000
    })
    for (const id of rowIds)
        assert.deepEqual(runs[id], { state: 'succeeded', detail: null })
})

test('rows move pending → running → succeeded one step at a time', async () => {
    assert.deepEqual(updateRunStore.getState(), { runs: {}, batch: null })
    const seen: Array<[RowRun | undefined, RowRun | undefined]> = []
    const { client } = fakeClient({
        upgradeCli: async () => {
            seen.push([runOf('cli:sandbox:sbx_1'), runOf('cli:sandbox:sbx_2')])
            return {}
        }
    })
    const steps = [sandboxStep(1), sandboxStep(2)]

    updateRunStore.start(client, steps, rowIdsOf(steps))
    await waitFor(finished)

    assert.deepEqual(seen, [
        [
            { state: 'running', detail: null },
            { state: 'pending', detail: null }
        ],
        [
            { state: 'succeeded', detail: null },
            { state: 'running', detail: null }
        ]
    ])
    assert.deepEqual(runOf('cli:sandbox:sbx_1'), {
        state: 'succeeded',
        detail: null
    })
    assert.deepEqual(runOf('cli:sandbox:sbx_2'), {
        state: 'succeeded',
        detail: null
    })
})

test('a skill batch fans its per-agent results back onto the rows', async () => {
    const { client } = fakeClient({
        installBatch: async () => ({
            results: [
                { agentId: 'agt_1', status: 'installed' },
                { agentId: 'agt_2', status: 'failed', error: 'boom' },
                { agentId: 'agt_3', status: 'failed' }
            ]
        })
    })
    const steps = [skillStep('skl_a', ['agt_1', 'agt_2', 'agt_3'])]

    updateRunStore.start(client, steps, rowIdsOf(steps))
    await waitFor(finished)

    assert.deepEqual(runOf('skill:agt_1:skl_a'), {
        state: 'succeeded',
        detail: null
    })
    assert.deepEqual(runOf('skill:agt_2:skl_a'), {
        state: 'failed',
        detail: { kind: 'text', text: 'boom' }
    })
    assert.deepEqual(runOf('skill:agt_3:skl_a'), {
        state: 'failed',
        detail: null
    })
    const { batch } = updateRunStore.getState()
    assert.equal(batch?.succeeded, 1)
    assert.equal(batch?.failed, 2)
})

test('the sixth daemon upgrade waits out the rate window and says so', async () => {
    const observed: Array<RowRun | undefined> = []
    onSleep = () => observed.push(runOf('cli:daemon:dmn_6'))
    const { client, calls } = fakeClient()
    const steps = [1, 2, 3, 4, 5, 6].map((n) => daemonStep(n))

    updateRunStore.start(client, steps, rowIdsOf(steps))
    await waitFor(finished)

    assert.deepEqual(sleeps, [DAEMON_RATE_WINDOW_MS - 5_000])
    assert.deepEqual(observed, [
        { state: 'running', detail: { kind: 'waiting' } }
    ])
    assert.equal(calls.upgradeHost.length, 6)
    assert.deepEqual(runOf('cli:daemon:dmn_6'), {
        state: 'succeeded',
        detail: null
    })
    assert.equal(updateRunStore.getState().batch?.succeeded, 6)
})

test('a 429 from the shared daemon window sleeps the window and retries once', async () => {
    let attempts = 0
    const { client, calls } = fakeClient({
        upgradeHost: async () => {
            attempts += 1
            if (attempts === 1)
                throw new ApiError({
                    status: 429,
                    statusText: 'Too Many Requests',
                    code: 'too_many_requests',
                    message: 'rate limited',
                    body: ''
                })
            return { ok: true }
        }
    })
    const steps = [daemonStep(1)]

    updateRunStore.start(client, steps, rowIdsOf(steps))
    await waitFor(finished)

    assert.deepEqual(sleeps, [DAEMON_RATE_WINDOW_MS])
    assert.equal(calls.upgradeHost.length, 2)
    assert.deepEqual(runOf('cli:daemon:dmn_1'), {
        state: 'succeeded',
        detail: null
    })
})

test('any other error marks the row failed with the API message and moves on', async () => {
    const err = new ApiError({
        status: 500,
        statusText: 'Internal Server Error',
        code: 'internal_error',
        message: 'exploded',
        body: ''
    })
    const { client, calls } = fakeClient({
        upgradeHost: async () => {
            throw err
        }
    })
    const steps = [daemonStep(1), sandboxStep(1)]

    updateRunStore.start(client, steps, rowIdsOf(steps))
    await waitFor(finished)

    assert.deepEqual(sleeps, [])
    assert.equal(calls.upgradeHost.length, 1)
    assert.deepEqual(runOf('cli:daemon:dmn_1'), {
        state: 'failed',
        detail: { kind: 'text', text: apiErrorMessage(err) }
    })
    assert.deepEqual(runOf('cli:sandbox:sbx_1'), {
        state: 'succeeded',
        detail: null
    })
    const { batch } = updateRunStore.getState()
    assert.equal(batch?.succeeded, 1)
    assert.equal(batch?.failed, 1)
})

test('a rebuild forwards streamed phases into the row; npm mode never streams', async () => {
    const seen: Array<RowRun | undefined> = []
    const { client, calls } = fakeClient({
        upgradeFrameworkStream: async (_agentId, _targetVersion, onEvent) => {
            onEvent({ type: 'step', step: 'rebuilding' })
            seen.push(runOf('framework:art_1'))
            onEvent({ type: 'step', step: 'verifying' })
            seen.push(runOf('framework:art_1'))
        }
    })
    const steps = [frameworkStep('rebuild', 1), frameworkStep('npm', 2)]

    updateRunStore.start(client, steps, rowIdsOf(steps))
    await waitFor(finished)

    assert.deepEqual(seen, [
        { state: 'running', detail: { kind: 'phase', phase: 'rebuilding' } },
        { state: 'running', detail: { kind: 'phase', phase: 'verifying' } }
    ])
    assert.deepEqual(calls.upgradeFrameworkStream, [
        { agentId: 'agt_1', targetVersion: '2.1.0' }
    ])
    assert.deepEqual(calls.upgradeFramework, [
        { agentId: 'agt_2', targetVersion: '2.1.0' }
    ])
    assert.deepEqual(runOf('framework:art_1'), {
        state: 'succeeded',
        detail: null
    })
    assert.deepEqual(runOf('framework:art_2'), {
        state: 'succeeded',
        detail: null
    })
})

test('start() is refused while a batch is running, and for an empty plan', async () => {
    const gate = deferred<unknown>()
    const { client, calls } = fakeClient({ upgradeCli: () => gate.promise })

    assert.equal(
        updateRunStore.start(client, [sandboxStep(1)], ['cli:sandbox:sbx_1']),
        true
    )
    await waitFor(() => calls.upgradeCli.length === 1)

    const before = updateRunStore.getState()
    assert.equal(
        updateRunStore.start(client, [sandboxStep(2)], ['cli:sandbox:sbx_2']),
        false
    )
    assert.equal(updateRunStore.getState(), before)

    gate.resolve({})
    await waitFor(finished)
    assert.deepEqual(calls.upgradeCli, [
        { id: 'sbx_1', targetVersion: undefined }
    ])
    assert.equal(updateRunStore.start(client, [], []), false)
    assert.equal(updateRunStore.getState().batch?.state, 'finished')
})

test('clear() empties the store and a loop released afterwards writes nothing', async () => {
    const gate = deferred<unknown>()
    const { client, calls } = fakeClient({ upgradeCli: () => gate.promise })
    const steps = [sandboxStep(1), sandboxStep(2)]

    updateRunStore.start(client, steps, rowIdsOf(steps))
    await waitFor(() => calls.upgradeCli.length === 1)
    updateRunStore.clear()
    assert.deepEqual(updateRunStore.getState(), { runs: {}, batch: null })

    gate.resolve({})
    await settle()

    assert.deepEqual(updateRunStore.getState(), { runs: {}, batch: null })
    assert.deepEqual(calls.upgradeCli, [
        { id: 'sbx_1', targetVersion: undefined }
    ])
})

test('a picked target version reaches the CLI endpoints', async () => {
    const { client, calls } = fakeClient()
    const steps = [sandboxStep(1, '0.29.0'), daemonStep(1, '0.30.0')]

    updateRunStore.start(client, steps, rowIdsOf(steps))
    await waitFor(finished)

    assert.deepEqual(calls.upgradeCli, [
        { id: 'sbx_1', targetVersion: '0.29.0' }
    ])
    assert.deepEqual(calls.upgradeHost, [
        { id: 'dmn_1', targetVersion: '0.30.0' }
    ])
})

test('no picked version omits the parameter rather than sending null', async () => {
    // The endpoints read an absent targetVersion as "the channel's latest";
    // a literal null would fail validation.
    const { client, calls } = fakeClient()
    const steps = [sandboxStep(1), daemonStep(1)]

    updateRunStore.start(client, steps, rowIdsOf(steps))
    await waitFor(finished)

    assert.deepEqual(calls.upgradeCli, [
        { id: 'sbx_1', targetVersion: undefined }
    ])
    assert.deepEqual(calls.upgradeHost, [
        { id: 'dmn_1', targetVersion: undefined }
    ])
})

test('the rate-limit retry re-sends the same target version', async () => {
    // The retry is a second call, not a resumed one, so it has to carry the
    // pick again or the wait silently installs a different version.
    let attempts = 0
    const { client, calls } = fakeClient({
        upgradeHost: async () => {
            attempts += 1
            if (attempts === 1)
                throw new ApiError({
                    status: 429,
                    statusText: 'Too Many Requests',
                    code: 'too_many_requests',
                    message: 'rate limited',
                    body: ''
                })
            return { ok: true }
        }
    })
    const steps = [daemonStep(1, '0.30.0')]

    updateRunStore.start(client, steps, rowIdsOf(steps))
    await waitFor(finished)

    assert.deepEqual(sleeps, [DAEMON_RATE_WINDOW_MS])
    assert.deepEqual(calls.upgradeHost, [
        { id: 'dmn_1', targetVersion: '0.30.0' },
        { id: 'dmn_1', targetVersion: '0.30.0' }
    ])
})
