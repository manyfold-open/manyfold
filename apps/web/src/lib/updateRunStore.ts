import { ApiError, type NcaClient } from '@manyfold/sdk'
import type { FrameworkUpgradeStep } from '@manyfold/shared'
import { create } from 'zustand'
import { apiErrorMessage } from '@/lib/errorMessage'
import type {
    BatchStep,
    UpdateCenterInputs,
    UpdateRow
} from '@/lib/updateCenter'

export type RunState =
    'pending' | 'running' | 'succeeded' | 'failed' | 'deferred' | 'installing'

// Structured rather than a string: the page translates and formats these at
// render time, so a language switch mid-batch re-renders the caption and the
// store itself carries no i18n dependency.
export type RunDetail =
    | { kind: 'waiting' }
    | { kind: 'phase'; phase: FrameworkUpgradeStep }
    | { kind: 'text'; text: string }
    | { kind: 'materializing'; revision: string | null; updatedAt: string }
    | { kind: 'deferred'; activeSessions: number; targetVersion: string | null }

export interface RowRun {
    state: RunState
    detail: RunDetail | null
}

export interface UpdateBatch {
    id: string
    state: 'running' | 'finished'
    succeeded: number
    failed: number
    awaiting: number
    rowIds: string[]
    startedAt: number
    finishedAt: number | null
}

export interface UpdateRunState {
    runs: Record<string, RowRun>
    batch: UpdateBatch | null
}

// The server allows 5 daemon upgrades per 60s per actor and does not forward a
// retry hint: the rate limiter puts `retryAfter` at the top level of the body,
// where the global exception filter (which only passes through code, message
// and details) drops it, and the Retry-After header is emitted only for the
// differently-named `retryAfterSec`. So the queue paces itself to the same
// window rather than reading a number that never arrives.
const DAEMON_UPGRADES_PER_WINDOW = 5
const DAEMON_RATE_WINDOW_MS = 62_000

interface Timers {
    now: () => number
    sleep: (ms: number) => Promise<void>
}

const realTimers: Timers = {
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
}

// Injected rather than imported so the test runner can drive the 62s daemon
// pacing window without waiting for it.
let timers: Timers = realTimers

const setTimers = (next: Timers | null): void => {
    timers = next ?? realTimers
}

const useUpdateRunState = create<UpdateRunState>(() => ({
    runs: {},
    batch: null
}))

// The queue lives here, outside any component, so leaving the Update Center
// does not stop it: the page is only a view of this store. The epoch is the
// one thing that does stop a loop — clear() (tests) and a hot reload of this
// module bump it, and a loop from an older epoch quits at its next step
// boundary instead of writing into a store nobody reads.
let epoch = 0
let batchSeq = 0

const writeRuns = (
    rowIds: string[],
    state: RunState,
    detail: RunDetail | null
): void =>
    useUpdateRunState.setState((prev) => {
        const runs = { ...prev.runs }
        for (const id of rowIds) runs[id] = { state, detail }
        return { runs }
    })

const patchBatch = (patch: Partial<UpdateBatch>): void =>
    useUpdateRunState.setState((prev) =>
        prev.batch ? { batch: { ...prev.batch, ...patch } } : prev
    )

const runSteps = async (
    client: NcaClient,
    steps: BatchStep[]
): Promise<void> => {
    const myEpoch = epoch
    const stale = (): boolean => epoch !== myEpoch
    const setRun = (
        ids: string[],
        state: RunState,
        detail: RunDetail | null
    ): void => {
        if (!stale()) writeRuns(ids, state, detail)
    }
    let daemonsThisWindow = 0
    let windowStartedAt = timers.now()

    const fail = (ids: string[], err: unknown): void => {
        setRun(ids, 'failed', { kind: 'text', text: apiErrorMessage(err) })
    }
    const succeed = (ids: string[]): void => {
        setRun(ids, 'succeeded', null)
    }

    try {
        for (const step of steps) {
            if (stale()) return
            const ids = step.type === 'skillBatch' ? step.rowIds : [step.rowId]
            setRun(ids, 'running', null)
            try {
                switch (step.type) {
                    case 'skillBatch': {
                        const result = await client.skills.installBatch({
                            skillId: step.skillId,
                            agentIds: step.agentIds
                        })
                        result.results.forEach((item, index) => {
                            const id = step.rowIds[index]
                            if (id === undefined) return
                            if (item.status === 'installed') {
                                if (
                                    item.skill?.materializeStatus ===
                                    'installing'
                                )
                                    setRun([id], 'installing', {
                                        kind: 'materializing',
                                        revision: item.skill.installedRevision,
                                        updatedAt: item.skill.updatedAt
                                    })
                                else setRun([id], 'succeeded', null)
                            } else {
                                setRun(
                                    [id],
                                    'failed',
                                    item.error
                                        ? { kind: 'text', text: item.error }
                                        : null
                                )
                            }
                        })
                        break
                    }
                    case 'sandboxCli':
                        await client.sandboxes.upgradeCli(
                            step.sandboxId,
                            step.targetVersion ?? undefined
                        )
                        succeed(ids)
                        break
                    case 'sandboxHerdr':
                        await client.sandboxes.upgradeHerdr(step.sandboxId)
                        succeed(ids)
                        break
                    case 'daemonHerdr':
                        await client.daemons.upgradeHerdr(step.hostId)
                        succeed(ids)
                        break
                    case 'daemonCli': {
                        if (daemonsThisWindow >= DAEMON_UPGRADES_PER_WINDOW) {
                            const wait =
                                DAEMON_RATE_WINDOW_MS -
                                (timers.now() - windowStartedAt)
                            if (wait > 0) {
                                setRun(ids, 'running', { kind: 'waiting' })
                                await timers.sleep(wait)
                                if (stale()) return
                            }
                            daemonsThisWindow = 0
                            windowStartedAt = timers.now()
                            setRun(ids, 'running', null)
                        }
                        if (daemonsThisWindow === 0)
                            windowStartedAt = timers.now()
                        daemonsThisWindow += 1
                        const target = step.targetVersion ?? undefined
                        let response
                        try {
                            response = await client.daemons.upgradeHost(
                                step.hostId,
                                target
                            )
                        } catch (err) {
                            // The window is server-side and shared with every
                            // other session for this account, so it can be
                            // spent before this queue reaches its own fifth
                            // call.
                            if (
                                !(err instanceof ApiError) ||
                                err.status !== 429
                            )
                                throw err
                            setRun(ids, 'running', { kind: 'waiting' })
                            await timers.sleep(DAEMON_RATE_WINDOW_MS)
                            if (stale()) return
                            daemonsThisWindow = 1
                            windowStartedAt = timers.now()
                            response = await client.daemons.upgradeHost(
                                step.hostId,
                                target
                            )
                        }
                        if (response.deferred)
                            setRun(ids, 'deferred', {
                                kind: 'deferred',
                                activeSessions: response.activeSessions ?? 0,
                                targetVersion: response.toVersion
                            })
                        else succeed(ids)
                        break
                    }
                    case 'framework':
                        if (step.mode === 'rebuild')
                            await client.agents.upgradeFrameworkStream(
                                step.agentId,
                                step.targetVersion,
                                (event) => {
                                    if (event.type === 'step')
                                        setRun(ids, 'running', {
                                            kind: 'phase',
                                            phase: event.step
                                        })
                                }
                            )
                        else
                            await client.agents.upgradeFramework(
                                step.agentId,
                                step.targetVersion
                            )
                        succeed(ids)
                        break
                }
            } catch (err) {
                fail(ids, err)
            }
        }
    } finally {
        // Also reached by an unexpected throw outside a step's own try/catch,
        // so a batch can never stay 'running' with nothing driving it.
        if (!stale())
            patchBatch({
                state: 'finished',
                ...batchCounts(
                    useUpdateRunState.getState().runs,
                    useUpdateRunState.getState().batch?.rowIds ?? []
                ),
                finishedAt: timers.now()
            })
    }
}

// One batch at a time. Keep accepted work awaiting server confirmation across
// batches; counters describe only the latest batch's rowIds.
const start = (
    client: NcaClient,
    steps: BatchStep[],
    rowIds: string[]
): boolean => {
    if (steps.length === 0) return false
    if (useUpdateRunState.getState().batch?.state === 'running') return false
    if (
        rowIds.some((id) =>
            isTargetUpdating(useUpdateRunState.getState().runs, id)
        )
    )
        return false
    batchSeq += 1
    const runs: Record<string, RowRun> = Object.fromEntries(
        Object.entries(useUpdateRunState.getState().runs).filter(
            ([, run]) => run.state === 'deferred' || run.state === 'installing'
        )
    )
    for (const id of rowIds) runs[id] = { state: 'pending', detail: null }
    useUpdateRunState.setState({
        batch: {
            id: `batch-${batchSeq}`,
            state: 'running',
            succeeded: 0,
            failed: 0,
            awaiting: 0,
            rowIds,
            startedAt: timers.now(),
            finishedAt: null
        },
        runs
    })
    void runSteps(client, steps)
    return true
}

const clear = (): void => {
    epoch += 1
    useUpdateRunState.setState({ runs: {}, batch: null })
}

export const useUpdateRuns = (): Record<string, RowRun> =>
    useUpdateRunState((state) => state.runs)

export const useUpdateBatch = (): UpdateBatch | null =>
    useUpdateRunState((state) => state.batch)

export const useIsUpdateBatchRunning = (): boolean =>
    useUpdateRunState((state) => state.batch?.state === 'running')

export const isTargetUpdating = (
    runs: Record<string, RowRun>,
    targetKey: string
): boolean => {
    const state = runs[targetKey]?.state
    return state === 'pending' || state === 'running' || state === 'installing'
}

export const useIsTargetUpdating = (targetKey: string): boolean =>
    useUpdateRunState((state) => isTargetUpdating(state.runs, targetKey))

// A live attempt may be retrying an older failure. reconcile() accepts only
// snapshots for that attempt; server state otherwise outranks stale success.
export const effectiveUpdateRun = (
    row: UpdateRow,
    run?: RowRun
): RowRun | undefined => {
    if (
        run?.state === 'pending' ||
        run?.state === 'running' ||
        run?.state === 'installing'
    )
        return run
    if (row.materialization)
        return {
            state: row.materialization.status,
            detail: row.materialization.error
                ? { kind: 'text', text: row.materialization.error }
                : null
        }
    return run
}

const batchCounts = (runs: Record<string, RowRun>, rowIds: string[]) => ({
    succeeded: rowIds.filter((id) => runs[id]?.state === 'succeeded').length,
    failed: rowIds.filter((id) => runs[id]?.state === 'failed').length,
    awaiting: rowIds.filter(
        (id) =>
            runs[id]?.state === 'deferred' || runs[id]?.state === 'installing'
    ).length
})

const reconcile = (
    inputs: Partial<Pick<UpdateCenterInputs, 'daemonHosts' | 'skillGroups'>>
): void => {
    useUpdateRunState.setState((prev) => {
        const runs = { ...prev.runs }
        let changed = false
        for (const host of inputs.daemonHosts ?? []) {
            const id = `cli:daemon:${host.id}`
            const run = runs[id]
            if (
                run?.state === 'deferred' &&
                run.detail?.kind === 'deferred' &&
                run.detail.targetVersion &&
                host.cliVersion === run.detail.targetVersion
            ) {
                runs[id] = { state: 'succeeded', detail: null }
                changed = true
            }
        }
        for (const group of inputs.skillGroups ?? []) {
            for (const skill of group.skills) {
                for (const kind of ['skill', 'cliUsage']) {
                    const id = `${kind}:${skill.agentId}:${skill.skillId}`
                    if (
                        runs[id]?.state !== 'installing' ||
                        skill.materializeStatus === 'installing'
                    )
                        continue
                    const detail = runs[id].detail
                    if (
                        detail?.kind === 'materializing' &&
                        ((detail.revision &&
                            detail.revision !== skill.installedRevision) ||
                            Date.parse(skill.updatedAt) <
                                Date.parse(detail.updatedAt))
                    )
                        continue
                    runs[id] =
                        skill.materializeStatus === 'failed'
                            ? {
                                  state: 'failed',
                                  detail: skill.materializeError
                                      ? {
                                            kind: 'text',
                                            text: skill.materializeError
                                        }
                                      : null
                              }
                            : { state: 'succeeded', detail: null }
                    changed = true
                }
            }
        }
        if (!changed) return prev
        return {
            runs,
            batch: prev.batch
                ? { ...prev.batch, ...batchCounts(runs, prev.batch.rowIds) }
                : null
        }
    })
}

export const updateRunStore = {
    start,
    clear,
    setTimers,
    reconcile,
    isTargetUpdating: (targetKey: string): boolean =>
        isTargetUpdating(useUpdateRunState.getState().runs, targetKey),
    getState: (): UpdateRunState => useUpdateRunState.getState()
}

if (import.meta.hot) {
    import.meta.hot.dispose(() => {
        epoch += 1
    })
}
