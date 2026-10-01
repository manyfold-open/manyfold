import { ApiError, type NcaClient } from '@manyfold/sdk'
import {
    DAEMON_UPGRADES_PER_WINDOW,
    DAEMON_UPGRADE_WINDOW_MS,
    type BatchStep,
    type FrameworkUpgradeStep,
    type UpdateRow
} from '@manyfold/shared'
import { duration } from '@/commands/doctor/describe'
import { normalizeCliError } from '@/output'

export interface UpdateTimers {
    now: () => number
    sleep: (ms: number) => Promise<void>
}

export const realTimers: UpdateTimers = {
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
}

export type RowOutcome =
    | { state: 'updated' }
    | { state: 'pending'; message: string }
    | { state: 'failed'; code: string; message: string }

export type RunEvent =
    | { type: 'start'; rowIds: string[] }
    | { type: 'waiting'; rowIds: string[]; ms: number }
    | { type: 'phase'; rowIds: string[]; phase: FrameworkUpgradeStep }
    | { type: 'done'; rowId: string; outcome: RowOutcome }

const sessions = (n: number): string =>
    `${n} active ${n === 1 ? 'session' : 'sessions'}`

// The same calls, in the same order, as the web's batch runner. A step that
// fails marks its rows and the run goes on to the next.
export const runUpdateSteps = async (
    client: NcaClient,
    steps: BatchStep[],
    rows: ReadonlyMap<string, UpdateRow>,
    opts: { timers?: UpdateTimers; onEvent?: (event: RunEvent) => void } = {}
): Promise<Map<string, RowOutcome>> => {
    const timers = opts.timers ?? realTimers
    const emit = opts.onEvent ?? ((): void => {})
    const outcomes = new Map<string, RowOutcome>()
    const finish = (rowId: string, outcome: RowOutcome): void => {
        outcomes.set(rowId, outcome)
        emit({ type: 'done', rowId, outcome })
    }

    // The server charges a computer's CLI and herdr updates to one window per
    // user, so both count against it here.
    let inWindow = 0
    let windowStartedAt = timers.now()
    const paced = async <T>(
        rowIds: string[],
        call: () => Promise<T>
    ): Promise<T> => {
        if (inWindow >= DAEMON_UPGRADES_PER_WINDOW) {
            const wait =
                DAEMON_UPGRADE_WINDOW_MS - (timers.now() - windowStartedAt)
            if (wait > 0) {
                emit({ type: 'waiting', rowIds, ms: wait })
                await timers.sleep(wait)
            }
            inWindow = 0
        }
        if (inWindow === 0) windowStartedAt = timers.now()
        inWindow += 1
        try {
            return await call()
        } catch (err) {
            // The window is shared with every other session of the account,
            // so it can be spent before this run's own fifth call.
            if (!(err instanceof ApiError) || err.status !== 429) throw err
            emit({ type: 'waiting', rowIds, ms: DAEMON_UPGRADE_WINDOW_MS })
            await timers.sleep(DAEMON_UPGRADE_WINDOW_MS)
            inWindow = 1
            windowStartedAt = timers.now()
            return call()
        }
    }

    for (const step of steps) {
        const rowIds = step.type === 'skillBatch' ? step.rowIds : [step.rowId]
        emit({ type: 'start', rowIds })
        try {
            switch (step.type) {
                case 'skillBatch': {
                    const result = await client.skills.installBatch({
                        skillId: step.skillId,
                        agentIds: step.agentIds
                    })
                    step.rowIds.forEach((rowId, index) => {
                        const item = result.results[index]
                        if (!item)
                            finish(rowId, {
                                state: 'failed',
                                code: 'install_failed',
                                message: 'the install answered without this agent'
                            })
                        else if (item.status !== 'installed')
                            finish(rowId, {
                                state: 'failed',
                                code: 'install_failed',
                                message: item.error ?? 'the install failed'
                            })
                        else if (item.skill?.materializeStatus === 'installing')
                            finish(rowId, {
                                state: 'pending',
                                message:
                                    'still installing; mf updates list shows when it is done'
                            })
                        else finish(rowId, { state: 'updated' })
                    })
                    break
                }
                case 'sandboxCli': {
                    const before = rows.get(step.rowId)?.installedVersion ?? null
                    const after = await client.sandboxes.upgradeCli(
                        step.hostId,
                        step.targetVersion ?? undefined
                    )
                    const deferred = after.cliUpdateDeferred
                    // As `mf sandbox update` reports it: a sandbox busy with
                    // work takes the update once its sessions end.
                    finish(
                        step.rowId,
                        deferred
                            ? {
                                  state: 'pending',
                                  message: `waits for ${sessions(deferred.activeSessions)} to finish, within ${duration(Math.max(0, Date.parse(deferred.deadline) - timers.now()))} at the latest`
                              }
                            : after.cliVersion !== before
                              ? { state: 'updated' }
                              : {
                                    state: 'pending',
                                    message:
                                        'has not reported the new Manyfold CLI yet; mf updates list shows when it does'
                                }
                    )
                    break
                }
                case 'sandboxHerdr':
                    await client.sandboxes.upgradeHerdr(step.hostId)
                    finish(step.rowId, { state: 'updated' })
                    break
                case 'sandboxFramework':
                    await client.sandboxes.installFramework(
                        step.hostId,
                        step.framework,
                        step.targetVersion
                    )
                    finish(step.rowId, { state: 'updated' })
                    break
                case 'podHostCli':
                    await client.podHosts.upgradeCli(step.podHostId)
                    finish(step.rowId, { state: 'updated' })
                    break
                case 'daemonHerdr':
                    await paced(rowIds, () =>
                        client.daemons.upgradeHerdr(step.hostId)
                    )
                    finish(step.rowId, { state: 'updated' })
                    break
                case 'daemonCli': {
                    const response = await paced(rowIds, () =>
                        client.daemons.upgradeHost(
                            step.hostId,
                            step.targetVersion ?? undefined
                        )
                    )
                    finish(
                        step.rowId,
                        response.deferred
                            ? {
                                  state: 'pending',
                                  message: `waits for ${sessions(response.activeSessions ?? 0)} to finish, then takes ${response.toVersion}`
                              }
                            : { state: 'updated' }
                    )
                    break
                }
                case 'framework':
                    if (step.mode === 'rebuild')
                        await client.agentRuntimes.upgradeFrameworkStream(
                            step.runtimeId,
                            step.targetVersion,
                            (event) => {
                                if (event.type === 'step')
                                    emit({
                                        type: 'phase',
                                        rowIds,
                                        phase: event.step
                                    })
                            }
                        )
                    else
                        await client.agentRuntimes.upgradeFramework(
                            step.runtimeId,
                            step.targetVersion
                        )
                    finish(step.rowId, { state: 'updated' })
                    break
            }
        } catch (err) {
            const { code, message } = normalizeCliError(err).error
            for (const rowId of rowIds)
                if (!outcomes.has(rowId))
                    finish(rowId, { state: 'failed', code, message })
        }
    }
    return outcomes
}
