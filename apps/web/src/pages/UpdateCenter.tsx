import type { VersionedFramework } from '@manyfold/shared'
import { isVersionedFramework } from '@manyfold/shared'
import { ApiError } from '@manyfold/sdk'
import type { FC, ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import EmptyState from '@/components/EmptyState'
import FrameworkInstallGuide from '@/components/FrameworkInstallGuide'
import { Ghost } from '@/components/Loading'
import { StatusTag, type TagTone } from '@/components/Tag'
import { useLoadingGate } from '@/components/useLoadingGate'
import {
    AgentIcon,
    ChevronDownIcon,
    ChevronUpIcon,
    CloudComputerIcon,
    LocalDaemonIcon,
    ListViewIcon,
    RefreshIcon,
    RuntimeIcon,
    UpdatesIcon,
    type LucideIcon
} from '@/components/icons'
import { useApiClient } from '@/lib/apiClient'
import {
    GroupByControl,
    GroupHeader,
    useCascadeState,
    type GroupByOption
} from '@/lib/cascade'
import { apiErrorMessage } from '@/lib/errorMessage'
import { FrameworkLogo, frameworkLabel } from '@/lib/frameworkMeta'
import { useI18n, type TFn } from '@/lib/i18n'
import {
    buildUpdateRows,
    displayStatus,
    filterRowsByKind,
    groupUpdateRows,
    parseKindParam,
    planBatch,
    updateGroupDims,
    type BatchStep,
    type UpdateGroupBy,
    type UpdateKind,
    type UpdateRow,
    type UpdateStatus,
    type UpdateTargetKind
} from '@/lib/updateCenter'
import { useUpdateCenterData } from '@/lib/useUpdateCenterData'

const GHOST_ROWS = [0, 1, 2, 3]
const ghostSubjectWidth = ['w-28', 'w-36', 'w-24', 'w-32']
const ghostTargetWidth = ['w-24', 'w-20', 'w-28', 'w-20']

// The server allows 5 daemon upgrades per 60s per actor and does not forward a
// retry hint: the rate limiter puts `retryAfter` at the top level of the body,
// where the global exception filter (which only passes through code, message
// and details) drops it, and the Retry-After header is emitted only for the
// differently-named `retryAfterSec`. So the queue paces itself to the same
// window rather than reading a number that never arrives.
const DAEMON_UPGRADES_PER_WINDOW = 5
const DAEMON_RATE_WINDOW_MS = 62_000

const kindLabelKeys: Record<UpdateKind, string> = {
    cli: 'web.updates.kindCli',
    framework: 'web.updates.kindFramework',
    cliUsage: 'web.updates.kindCliUsage',
    skill: 'web.updates.kindSkill'
}

const statusLabelKeys: Record<UpdateStatus, string> = {
    required: 'web.updates.statusRequired',
    ready: 'web.updates.statusReady',
    manual: 'web.updates.statusManual',
    offline: 'web.updates.statusOffline'
}

const statusTones: Record<UpdateStatus, TagTone> = {
    required: 'error',
    ready: 'info',
    manual: 'idle',
    offline: 'error'
}

const targetIcons: Record<UpdateTargetKind, LucideIcon> = {
    daemon: LocalDaemonIcon,
    sandbox: RuntimeIcon,
    k8s: CloudComputerIcon,
    agent: AgentIcon
}

type RunState = 'pending' | 'running' | 'succeeded' | 'failed'

interface RowRun {
    state: RunState
    detail: string | null
}

const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms))

const VersionCell: FC<{ row: UpdateRow }> = ({ row }): ReactNode => {
    const { t } = useI18n()
    return (
        <span className='font-mono text-sm whitespace-nowrap'>
            <span className='text-muted'>
                {row.installedVersion ?? t('web.updates.versionUnknown')}
            </span>
            <span className='text-subtle px-1.5'>→</span>
            <span className='text-fg'>{row.latestVersion ?? '—'}</span>
        </span>
    )
}

const RowStatus: FC<{ row: UpdateRow; run: RowRun | undefined }> = ({
    row,
    run
}): ReactNode => {
    const { t } = useI18n()
    if (run) {
        const tone: TagTone =
            run.state === 'succeeded'
                ? 'success'
                : run.state === 'failed'
                  ? 'error'
                  : run.state === 'running'
                    ? 'info'
                    : 'idle'
        return (
            <span className='flex flex-col items-start gap-1'>
                <StatusTag
                    tone={tone}
                    pulse={run.state === 'running'}
                    label={t(`web.updates.run.${run.state}`)}
                />
                {run.detail && (
                    <span
                        className={[
                            'text-caption',
                            run.state === 'failed' ? 'text-error' : 'text-muted'
                        ].join(' ')}
                    >
                        {run.detail}
                    </span>
                )}
            </span>
        )
    }
    const status = displayStatus(row)
    // A required row that nobody can drive from here still has to say so: the
    // tag carries the urgency, the caption carries how it gets done.
    const aside =
        status === 'required' && row.blocker !== null
            ? t(
                  row.blocker === 'offline'
                      ? 'web.updates.statusOffline'
                      : 'web.updates.statusManual'
              )
            : null
    return (
        <span className='flex flex-col items-start gap-1'>
            <StatusTag tone={statusTones[status]} label={t(statusLabelKeys[status])} />
            {aside && <span className='text-caption text-muted'>{aside}</span>}
            {row.blockedReason && (
                <span className='text-caption text-error'>
                    {row.blockedReason}
                </span>
            )}
        </span>
    )
}

const RowAction: FC<{
    row: UpdateRow
    busy: boolean
    onRun: (row: UpdateRow) => void
    onGuide: (row: UpdateRow) => void
}> = ({ row, busy, onRun, onGuide }): ReactNode => {
    const { t } = useI18n()
    if (row.exec.type === 'none') {
        if (row.exec.guideFramework)
            return (
                <button
                    type='button'
                    onClick={() => onGuide(row)}
                    className='workbench-button-secondary'
                >
                    {/* The ellipsis is the product's mark for "opens a dialog";
                        without it this reads as the button that runs the
                        update, which on someone's own machine it never is. */}
                    {t('web.agentRuntimesList.update')}…
                </button>
            )
        if (row.exec.href)
            return (
                <Link
                    to={row.exec.href}
                    className='text-link text-ui hover:underline'
                >
                    {t('web.updates.viewTarget')}
                </Link>
            )
        return <span className='text-subtle'>—</span>
    }
    return (
        <button
            type='button'
            disabled={busy}
            onClick={() => onRun(row)}
            className='workbench-button-secondary'
        >
            {t('web.updates.updateOne')}
        </button>
    )
}

const UpdateCenter: FC = (): ReactNode => {
    const client = useApiClient()
    const { t } = useI18n()
    const [searchParams, setSearchParams] = useSearchParams()
    const { inputs, loaded, loading, error, refresh } = useUpdateCenterData(true)
    const gate = useLoadingGate(loading && !loaded)
    const [selected, setSelected] = useState<Set<string>>(new Set())
    const [runs, setRuns] = useState<Record<string, RowRun>>({})
    const [running, setRunning] = useState(false)
    const [summary, setSummary] = useState<string | null>(null)
    const [guideRow, setGuideRow] = useState<UpdateRow | null>(null)
    // Leaving the page abandons the queue: the steps are dispatched from here,
    // so there is nothing left to drive them once this component is gone.
    const abandoned = useRef(false)

    useEffect(() => {
        abandoned.current = false
        return () => {
            abandoned.current = true
        }
    }, [])

    const {
        groupBy,
        setGroupBy,
        expanded,
        toggle,
        collapseAll,
        expandAll,
        reveal
    } =
        useCascadeState<UpdateGroupBy>(
            'mf.updates.cascade.v1',
            updateGroupDims,
            'kind'
        )

    const allRows = useMemo(
        () => buildUpdateRows(inputs, frameworkLabel),
        [inputs]
    )
    const kindFilter = parseKindParam(searchParams.get('kind'))
    const rows = useMemo(
        () => filterRowsByKind(allRows, kindFilter),
        [allRows, kindFilter]
    )

    const groups = useMemo(
        () =>
            groupUpdateRows(rows, groupBy, {
                kind: (kind) => t(kindLabelKeys[kind]),
                status: (status) => t(statusLabelKeys[status]),
                all: t('web.updates.title')
            }),
        [rows, groupBy, t]
    )
    const groupKeys = useMemo(() => groups.map((g) => g.key), [groups])
    const anyExpanded = groupKeys.some((key) => expanded.has(key))

    // Groups arrive collapsed from the cascade store, which suits a navigation
    // rail but not a page whose whole job is to show what needs updating — a
    // first visit would be four empty headers. Open each group the first time
    // it is seen, and never again, so collapsing one makes it stay collapsed.
    const autoExpanded = useRef(new Set<string>())
    useEffect(() => {
        const unseen = groupKeys.filter((key) => !autoExpanded.current.has(key))
        if (unseen.length === 0) return
        for (const key of unseen) autoExpanded.current.add(key)
        reveal(unseen)
    }, [groupKeys, reveal])

    // A row that finished, or vanished because its update landed, must not stay
    // selected — the next batch would then plan work for an id nobody renders.
    useEffect(() => {
        setSelected((prev) => {
            if (prev.size === 0) return prev
            const live = new Set(allRows.map((r) => r.id))
            const next = new Set([...prev].filter((id) => live.has(id)))
            return next.size === prev.size ? prev : next
        })
    }, [allRows])

    const selectableRows = rows.filter((row) => row.blocker === null)
    const selectedRows = allRows.filter((row) => selected.has(row.id))
    const allSelectableSelected =
        selectableRows.length > 0 &&
        selectableRows.every((row) => selected.has(row.id))

    const toggleRow = (id: string): void =>
        setSelected((prev) => {
            const next = new Set(prev)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return next
        })

    const toggleAll = (): void =>
        setSelected((prev) => {
            const next = new Set(prev)
            if (allSelectableSelected)
                for (const row of selectableRows) next.delete(row.id)
            else for (const row of selectableRows) next.add(row.id)
            return next
        })

    const setRun = useCallback(
        (rowIds: string[], state: RunState, detail: string | null): void =>
            setRuns((prev) => {
                const next = { ...prev }
                for (const id of rowIds) next[id] = { state, detail }
                return next
            }),
        []
    )

    const runSteps = useCallback(
        async (steps: BatchStep[], rowIds: string[]): Promise<void> => {
            if (steps.length === 0) return
            setRunning(true)
            setSummary(null)
            setRun(rowIds, 'pending', null)
            let succeeded = 0
            let failed = 0
            let daemonsThisWindow = 0
            let windowStartedAt = Date.now()

            const fail = (ids: string[], err: unknown): void => {
                failed += ids.length
                setRun(ids, 'failed', apiErrorMessage(err))
            }
            const succeed = (ids: string[]): void => {
                succeeded += ids.length
                setRun(ids, 'succeeded', null)
            }

            for (const step of steps) {
                if (abandoned.current) return
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
                                    succeeded += 1
                                    setRun([id], 'succeeded', null)
                                } else {
                                    failed += 1
                                    setRun(
                                        [id],
                                        'failed',
                                        item.error ??
                                            t('web.updates.run.failed')
                                    )
                                }
                            })
                            break
                        }
                        case 'sandboxCli':
                            await client.sandboxes.upgradeCli(step.sandboxId)
                            succeed(ids)
                            break
                        case 'daemonCli': {
                            if (
                                daemonsThisWindow >= DAEMON_UPGRADES_PER_WINDOW
                            ) {
                                const wait =
                                    DAEMON_RATE_WINDOW_MS -
                                    (Date.now() - windowStartedAt)
                                if (wait > 0) {
                                    setRun(ids, 'running', t('web.updates.run.waiting'))
                                    await sleep(wait)
                                    if (abandoned.current) return
                                }
                                daemonsThisWindow = 0
                                windowStartedAt = Date.now()
                                setRun(ids, 'running', null)
                            }
                            if (daemonsThisWindow === 0)
                                windowStartedAt = Date.now()
                            daemonsThisWindow += 1
                            try {
                                await client.daemons.upgradeHost(step.hostId)
                            } catch (err) {
                                // The window is server-side and shared with
                                // every other session for this account, so it
                                // can be spent before this queue reaches its
                                // own fifth call.
                                if (
                                    !(err instanceof ApiError) ||
                                    err.status !== 429
                                )
                                    throw err
                                setRun(ids, 'running', t('web.updates.run.waiting'))
                                await sleep(DAEMON_RATE_WINDOW_MS)
                                if (abandoned.current) return
                                daemonsThisWindow = 1
                                windowStartedAt = Date.now()
                                await client.daemons.upgradeHost(step.hostId)
                            }
                            succeed(ids)
                            break
                        }
                        case 'framework':
                            if (step.mode === 'rebuild')
                                await client.agents.upgradeFrameworkStream(
                                    step.agentId,
                                    step.targetVersion,
                                    (event) => {
                                        if (event.type === 'step')
                                            setRun(
                                                ids,
                                                'running',
                                                event.step.replace(/_/g, ' ')
                                            )
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

            if (abandoned.current) return
            setRunning(false)
            setSummary(
                t('web.updates.batchSummary', {
                    done: String(succeeded),
                    failed: String(failed)
                })
            )
            setSelected(new Set())
            await refresh()
        },
        [client, refresh, setRun, t]
    )

    const runSelected = (): void => {
        void runSteps(
            planBatch(selectedRows),
            selectedRows.filter((r) => r.blocker === null).map((r) => r.id)
        )
    }
    const runOne = (row: UpdateRow): void => {
        void runSteps(planBatch([row]), [row.id])
    }

    const clearKindFilter = (): void => {
        const next = new URLSearchParams(searchParams)
        next.delete('kind')
        setSearchParams(next, { replace: true })
    }

    const showGhosts = gate.showLoading
    const empty = loaded && !showGhosts && rows.length === 0
    const guideFramework: VersionedFramework | null =
        guideRow?.exec.type === 'none' &&
        guideRow.exec.guideFramework &&
        isVersionedFramework(guideRow.exec.guideFramework)
            ? guideRow.exec.guideFramework
            : null

    return (
        <div className='workbench-page'>
            <div className='mb-6 flex items-start justify-between gap-4'>
                <div>
                    <h1 className='text-h1 text-fg'>{t('web.updates.title')}</h1>
                    <p className='text-ui text-muted mt-1.5'>
                        {t('web.updates.subtitle')}
                    </p>
                </div>
                <div className='flex shrink-0 items-center gap-2'>
                    <button
                        type='button'
                        onClick={() => void refresh()}
                        disabled={running || loading}
                        className='workbench-button-secondary gap-1.5'
                    >
                        <RefreshIcon className='h-4 w-4' />
                        {t('web.updates.refresh')}
                    </button>
                    <button
                        type='button'
                        onClick={runSelected}
                        disabled={running || selected.size === 0}
                        className='workbench-button-primary gap-1.5'
                    >
                        <UpdatesIcon className='h-4 w-4' />
                        {t('web.updates.updateSelected', {
                            count: String(selected.size)
                        })}
                    </button>
                </div>
            </div>

            {error && <div className='workbench-alert-error mb-5'>{error}</div>}

            <div className='mb-3 flex flex-wrap items-center gap-3'>
                <GroupByControl
                    value={groupBy}
                    onChange={setGroupBy}
                    options={groupByOptions(t)}
                />
                {groupBy !== 'none' && groups.length > 0 && (
                    <button
                        type='button'
                        onClick={
                            anyExpanded
                                ? collapseAll
                                : () => expandAll(groupKeys)
                        }
                        className='text-caption text-muted hover:text-fg inline-flex items-center gap-1 transition-colors'
                    >
                        {anyExpanded ? (
                            <ChevronUpIcon className='h-3.5 w-3.5' />
                        ) : (
                            <ChevronDownIcon className='h-3.5 w-3.5' />
                        )}
                        {anyExpanded
                            ? t('web.channels.settings.collapseAll')
                            : t('web.channels.settings.expandAll')}
                    </button>
                )}
                {kindFilter && (
                    <span className='text-caption text-muted inline-flex items-center gap-2'>
                        {t('web.updates.filteredNotice', {
                            kind: t(kindLabelKeys[kindFilter])
                        })}
                        <button
                            type='button'
                            onClick={clearKindFilter}
                            className='text-link hover:underline'
                        >
                            {t('web.updates.clearFilter')}
                        </button>
                    </span>
                )}
                {running && (
                    <span className='text-caption text-muted'>
                        {t('web.updates.runningNotice')}
                    </span>
                )}
                {summary && !running && (
                    <span className='text-caption text-muted'>{summary}</span>
                )}
            </div>

            {empty ? (
                <EmptyState
                    kind='all-clear'
                    tier='stack'
                    icon={UpdatesIcon}
                    title={t('web.updates.emptyTitle')}
                    body={t('web.updates.emptyBody')}
                />
            ) : (
                <div className='workbench-table-shell' aria-busy={showGhosts}>
                    <div className='overflow-x-auto'>
                        <table className='workbench-table min-w-[760px]'>
                            <thead className='workbench-table-head'>
                                <tr className='text-caption text-muted tracking-wider uppercase'>
                                    <th className='w-10 px-4 py-3'>
                                        <input
                                            type='checkbox'
                                            aria-label={t(
                                                'web.updates.selectAll'
                                            )}
                                            checked={allSelectableSelected}
                                            disabled={
                                                running ||
                                                selectableRows.length === 0
                                            }
                                            onChange={toggleAll}
                                        />
                                    </th>
                                    <th className='px-4 py-3 font-medium'>
                                        {t('web.updates.colUpdate')}
                                    </th>
                                    <th className='px-4 py-3 font-medium'>
                                        {t('web.updates.colTarget')}
                                    </th>
                                    <th className='px-4 py-3 font-medium'>
                                        {t('web.updates.colVersion')}
                                    </th>
                                    <th className='px-4 py-3 font-medium'>
                                        {t('web.updates.colStatus')}
                                    </th>
                                    <th className='px-4 py-3 text-right font-medium'>
                                        <span className='sr-only'>
                                            {t('web.updates.colAction')}
                                        </span>
                                    </th>
                                </tr>
                            </thead>
                            {showGhosts ? (
                                <tbody>
                                    {GHOST_ROWS.map((row) => (
                                        <tr
                                            key={`ghost-${row}`}
                                            className='border-divider/60 border-t'
                                        >
                                            <td className='px-4 py-3'>
                                                <Ghost
                                                    variant='cap'
                                                    className='h-4 w-4'
                                                />
                                            </td>
                                            <td className='px-4 py-3'>
                                                <span className='flex items-center gap-2'>
                                                    <Ghost
                                                        variant='circle'
                                                        className='h-[18px] w-[18px] shrink-0'
                                                    />
                                                    <Ghost
                                                        variant='cap'
                                                        className={
                                                            ghostSubjectWidth[
                                                                row
                                                            ]
                                                        }
                                                    />
                                                </span>
                                            </td>
                                            <td className='px-4 py-3'>
                                                <Ghost
                                                    variant='cap'
                                                    className={
                                                        ghostTargetWidth[row]
                                                    }
                                                />
                                            </td>
                                            <td className='px-4 py-3'>
                                                <Ghost
                                                    variant='cap'
                                                    className='w-28'
                                                />
                                            </td>
                                            <td className='px-4 py-3'>
                                                <Ghost
                                                    variant='cap'
                                                    className='w-20'
                                                />
                                            </td>
                                            <td className='px-4 py-3'>
                                                <Ghost
                                                    variant='cap'
                                                    className='ml-auto w-16'
                                                />
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            ) : (
                                groups.map((group) => {
                                    const grouped = groupBy !== 'none'
                                    const open =
                                        !grouped || expanded.has(group.key)
                                    return (
                                        <tbody key={group.key}>
                                            {grouped && (
                                                <tr className='border-divider/60 bg-surface-subtle border-t'>
                                                    <td
                                                        colSpan={6}
                                                        className='px-2 py-0'
                                                    >
                                                        <GroupHeader
                                                            label={group.label}
                                                            count={
                                                                group.rows
                                                                    .length
                                                            }
                                                            open={open}
                                                            health={groupHealth(
                                                                group.rows
                                                            )}
                                                            onToggle={() =>
                                                                toggle(
                                                                    group.key
                                                                )
                                                            }
                                                        />
                                                    </td>
                                                </tr>
                                            )}
                                            {open &&
                                                group.rows.map((row) => {
                                                    const TargetIcon =
                                                        targetIcons[
                                                            row.targetKind
                                                        ]
                                                    return (
                                                        <tr
                                                            key={row.id}
                                                            className='text-ui text-fg border-divider/60 border-t'
                                                        >
                                                            <td className='px-4 py-3 align-top'>
                                                                <input
                                                                    type='checkbox'
                                                                    aria-label={t(
                                                                        'web.updates.selectRow',
                                                                        {
                                                                            name: `${row.subjectLabel} · ${row.targetLabel}`
                                                                        }
                                                                    )}
                                                                    checked={selected.has(
                                                                        row.id
                                                                    )}
                                                                    disabled={
                                                                        running ||
                                                                        row.blocker !==
                                                                            null
                                                                    }
                                                                    onChange={() =>
                                                                        toggleRow(
                                                                            row.id
                                                                        )
                                                                    }
                                                                />
                                                            </td>
                                                            <td className='px-4 py-3 align-top'>
                                                                <span className='flex items-center gap-2'>
                                                                    {row.framework ? (
                                                                        <FrameworkLogo
                                                                            framework={
                                                                                row.framework
                                                                            }
                                                                            size={
                                                                                18
                                                                            }
                                                                        />
                                                                    ) : (
                                                                        <UpdatesIcon className='text-muted h-[18px] w-[18px] shrink-0' />
                                                                    )}
                                                                    <span className='min-w-0 truncate font-medium'>
                                                                        {
                                                                            row.subjectLabel
                                                                        }
                                                                    </span>
                                                                </span>
                                                                {groupBy !==
                                                                    'kind' && (
                                                                    <span className='text-caption text-subtle mt-0.5 block'>
                                                                        {t(
                                                                            kindLabelKeys[
                                                                                row
                                                                                    .kind
                                                                            ]
                                                                        )}
                                                                    </span>
                                                                )}
                                                            </td>
                                                            <td className='text-muted px-4 py-3 align-top'>
                                                                <span className='flex items-center gap-2'>
                                                                    <TargetIcon className='text-subtle h-4 w-4 shrink-0' />
                                                                    <span className='min-w-0 truncate'>
                                                                        {
                                                                            row.targetLabel
                                                                        }
                                                                    </span>
                                                                </span>
                                                            </td>
                                                            <td className='px-4 py-3 align-top'>
                                                                <VersionCell
                                                                    row={row}
                                                                />
                                                            </td>
                                                            <td className='px-4 py-3 align-top'>
                                                                <RowStatus
                                                                    row={row}
                                                                    run={
                                                                        runs[
                                                                            row
                                                                                .id
                                                                        ]
                                                                    }
                                                                />
                                                            </td>
                                                            <td className='px-4 py-3 text-right align-top'>
                                                                <RowAction
                                                                    row={row}
                                                                    busy={
                                                                        running
                                                                    }
                                                                    onRun={
                                                                        runOne
                                                                    }
                                                                    onGuide={
                                                                        setGuideRow
                                                                    }
                                                                />
                                                            </td>
                                                        </tr>
                                                    )
                                                })}
                                        </tbody>
                                    )
                                })
                            )}
                        </table>
                    </div>
                </div>
            )}

            {guideRow && guideFramework && (
                <FrameworkInstallGuide
                    framework={guideFramework}
                    mode='upgrade'
                    hostName={guideRow.targetLabel}
                    onClose={() => setGuideRow(null)}
                />
            )}
        </div>
    )
}

const groupByOptions = (t: TFn): GroupByOption<UpdateGroupBy>[] => [
    { value: 'kind', label: t('web.updates.groupKind'), icon: UpdatesIcon },
    { value: 'target', label: t('web.updates.groupTarget'), icon: RuntimeIcon },
    { value: 'status', label: t('web.updates.groupStatus'), icon: ListViewIcon },
    { value: 'none', label: t('web.channels.settings.groupBy.none'), icon: ListViewIcon }
]

// A collapsed group still has to say whether anything inside needs attention.
const groupHealth = (rows: UpdateRow[]): 'error' | 'warn' | null => {
    if (rows.some((row) => row.severity === 'required')) return 'error'
    if (rows.some((row) => row.blocker !== null)) return 'warn'
    return null
}

export default UpdateCenter
