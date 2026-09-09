import type { VersionedFramework } from '@manyfold/shared'
import { isVersionedFramework } from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import EmptyState from '@/components/EmptyState'
import FrameworkInstallGuide from '@/components/FrameworkInstallGuide'
import { Ghost } from '@/components/Loading'
import { StatusTag, type TagTone } from '@/components/Tag'
import WorkbenchSelect from '@/components/WorkbenchSelect'
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
import { FrameworkLogo, frameworkLabel } from '@/lib/frameworkMeta'
import { useI18n, type TFn } from '@/lib/i18n'
import {
    blockerStatus,
    buildUpdateRows,
    filterRowsByKind,
    groupUpdateRows,
    parseKindParam,
    planBatch,
    updateGroupDims,
    type UpdateGroupBy,
    type UpdateKind,
    type UpdateRow,
    type UpdateStatus,
    type UpdateTargetKind
} from '@/lib/updateCenter'
import {
    updateRunStore,
    useIsUpdateBatchRunning,
    useUpdateBatch,
    useUpdateRuns,
    type RowRun
} from '@/lib/updateRunStore'
import { useUpdateCenterData } from '@/lib/useUpdateCenterData'

const GHOST_ROWS = [0, 1, 2, 3]
const ghostSubjectWidth = ['w-28', 'w-36', 'w-24', 'w-32']
const ghostTargetWidth = ['w-24', 'w-20', 'w-28', 'w-20']

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

const FromCell: FC<{ row: UpdateRow }> = ({ row }): ReactNode => {
    const { t } = useI18n()
    return (
        <span className='text-muted text-ui font-mono whitespace-nowrap'>
            {row.installedVersion ?? t('web.updates.versionUnknown')}
        </span>
    )
}

// A picker only when there is something to pick between; one option is not a
// choice, it is the answer. The `bare` variant is the one select that costs no
// row height (§8.9: py-0.5 with a cancelling -my-0.5), which is what lets the
// target sit inline in a table cell instead of boxing every row.
const ToCell: FC<{
    row: UpdateRow
    value: string | null
    disabled: boolean
    onPick: (version: string) => void
}> = ({ row, value, disabled, onPick }): ReactNode => {
    const { t } = useI18n()
    if (row.targetChoices.length < 2)
        return (
            <span className='text-fg text-ui font-mono whitespace-nowrap'>
                {value ?? '—'}
            </span>
        )
    return (
        <WorkbenchSelect
            bare
            mono
            // Sized to a version plus its chevron rather than to the column:
            // `bare` justifies the two apart, so a wider box just opens a gap
            // between the value and the control that changes it. A long dev
            // build truncates here and reads in full in the menu.
            className='w-24'
            menuClassName='min-w-44'
            ariaLabel={t('web.updates.pickTarget', {
                name: `${row.subjectLabel} · ${row.targetLabel}`
            })}
            disabled={disabled}
            value={value ?? ''}
            options={row.targetChoices.map((version) => ({
                value: version,
                label: version
            }))}
            onChange={onPick}
        />
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
            <StatusTag
                tone={tone}
                pulse={run.state === 'running'}
                label={t(`web.updates.run.${run.state}`)}
            />
        )
    }
    // One tag, two axes. The tone answers "how urgent" and the label answers
    // "what is in the way", which is why severity has to override the
    // blocker's own tone instead of picking one of the two facts to drop.
    const status = blockerStatus(row)
    const tone: TagTone =
        row.severity === 'required' ? 'error' : statusTones[status]
    return <StatusTag tone={tone} label={t(statusLabelKeys[status])} />
}

// The long-form half of a row's state, rendered in a row of its own beneath it.
// It used to live in the ~120px Status cell, where a sentence stretched the row
// and squeezed every other column; from a full-width cell it structurally
// cannot, and a row with nothing to say costs no extra markup at all.
const rowDetail = (
    row: UpdateRow,
    run: RowRun | undefined,
    t: TFn
): { text: string; error: boolean } | null => {
    if (run) {
        if (run.detail === null) return null
        if (run.detail.kind === 'waiting')
            return { text: t('web.updates.run.waiting'), error: false }
        if (run.detail.kind === 'phase')
            return { text: run.detail.phase.replace(/_/g, ' '), error: false }
        return { text: run.detail.text, error: run.state === 'failed' }
    }
    // Names the blocked range the INSTALLED version sits inside, which is why
    // the row is required rather than merely available.
    return row.blockedReason ? { text: row.blockedReason, error: true } : null
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
                    className='workbench-button-secondary h-8 px-3'
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
            className='workbench-button-secondary h-8 px-3'
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
    // Picked target versions, keyed by row id. Deliberately not part of the
    // row: buildUpdateRows is memoized on `inputs`, and choosing a version
    // must not rebuild the table.
    const [targets, setTargets] = useState<Record<string, string>>({})
    const [guideRow, setGuideRow] = useState<UpdateRow | null>(null)
    const runs = useUpdateRuns()
    const batch = useUpdateBatch()
    const running = useIsUpdateBatchRunning()

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
    // A pick is dropped on the same event, plus when the refreshed catalog no
    // longer offers it: a release withdrawn mid-session would otherwise leave
    // the row pointing at a version the server will refuse.
    useEffect(() => {
        setSelected((prev) => {
            if (prev.size === 0) return prev
            const live = new Set(allRows.map((r) => r.id))
            const next = new Set([...prev].filter((id) => live.has(id)))
            return next.size === prev.size ? prev : next
        })
        setTargets((prev) => {
            const entries = Object.entries(prev)
            if (entries.length === 0) return prev
            const byId = new Map(allRows.map((r) => [r.id, r]))
            const kept = entries.filter(([id, version]) =>
                byId.get(id)?.targetChoices.includes(version)
            )
            return kept.length === entries.length
                ? prev
                : Object.fromEntries(kept)
        })
    }, [allRows])

    // The queue runs in updateRunStore, so leaving this page does not stop it.
    // Only a batch this mount saw running gets the finish treatment: one that
    // ended while the page was away is already covered by the mount-time
    // fetch, and the self-clearing guard keeps StrictMode's doubled effect
    // from refreshing twice.
    const watchedBatch = useRef<string | null>(null)
    useEffect(() => {
        if (!batch) return
        if (batch.state === 'running') {
            watchedBatch.current = batch.id
            return
        }
        if (watchedBatch.current !== batch.id) return
        watchedBatch.current = null
        setSelected(new Set())
        void refresh()
    }, [batch, refresh])

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

    const targetOf = (row: UpdateRow): string | null =>
        targets[row.id] ?? row.latestVersion
    const pickTarget = (row: UpdateRow, version: string): void =>
        setTargets((prev) => ({ ...prev, [row.id]: version }))

    const runSelected = (): void => {
        updateRunStore.start(
            client,
            planBatch(selectedRows, targets),
            selectedRows.filter((r) => r.blocker === null).map((r) => r.id)
        )
    }
    const runOne = (row: UpdateRow): void => {
        updateRunStore.start(client, planBatch([row], targets), [row.id])
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
        <div className='workbench-page-wide'>
            <div className='mb-4 flex items-start justify-between gap-4'>
                <div>
                    <h1 className='text-h2 text-fg'>{t('web.updates.title')}</h1>
                    <p className='text-caption text-muted mt-1'>
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

            <div className='mb-2 flex flex-wrap items-center gap-x-3 gap-y-1.5'>
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
                {batch?.state === 'finished' && (
                    <span className='text-caption text-muted'>
                        {t('web.updates.batchSummary', {
                            done: String(batch.succeeded),
                            failed: String(batch.failed)
                        })}
                    </span>
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
                        <table className='workbench-table min-w-[880px]'>
                            <thead className='workbench-table-head'>
                                <tr className='text-caption text-muted'>
                                    <th className='w-10 px-3 py-2'>
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
                                    <th className='px-3 py-2 font-medium'>
                                        {t('web.updates.colUpdate')}
                                    </th>
                                    <th className='px-3 py-2 font-medium'>
                                        {t('web.updates.colTarget')}
                                    </th>
                                    <th className='px-3 py-2 font-medium'>
                                        {t('web.updates.colFrom')}
                                    </th>
                                    <th className='px-3 py-2 font-medium'>
                                        {t('web.updates.colTo')}
                                    </th>
                                    <th className='px-3 py-2 font-medium'>
                                        {t('web.updates.colStatus')}
                                    </th>
                                    <th className='px-3 py-2 text-right font-medium'>
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
                                            <td className='px-3 py-2'>
                                                <Ghost
                                                    variant='cap'
                                                    className='h-4 w-4'
                                                />
                                            </td>
                                            <td className='px-3 py-2'>
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
                                            <td className='px-3 py-2'>
                                                <Ghost
                                                    variant='cap'
                                                    className={
                                                        ghostTargetWidth[row]
                                                    }
                                                />
                                            </td>
                                            <td className='px-3 py-2'>
                                                <Ghost
                                                    variant='cap'
                                                    className='w-16'
                                                />
                                            </td>
                                            <td className='px-3 py-2'>
                                                <Ghost
                                                    variant='cap'
                                                    className='w-16'
                                                />
                                            </td>
                                            <td className='px-3 py-2'>
                                                <Ghost
                                                    variant='cap'
                                                    className='w-20'
                                                />
                                            </td>
                                            <td className='px-3 py-2'>
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
                                                        colSpan={7}
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
                                                    const run = runs[row.id]
                                                    const detail = rowDetail(
                                                        row,
                                                        run,
                                                        t
                                                    )
                                                    return (
                                                        <Fragment key={row.id}>
                                                            <tr className='text-ui text-fg border-divider/60 border-t'>
                                                                <td className='px-3 py-2 align-middle'>
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
                                                                <td className='px-3 py-2 align-middle'>
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
                                                                        {groupBy !==
                                                                            'kind' && (
                                                                            <span className='text-caption text-subtle shrink-0'>
                                                                                {t(
                                                                                    kindLabelKeys[
                                                                                        row
                                                                                            .kind
                                                                                    ]
                                                                                )}
                                                                            </span>
                                                                        )}
                                                                    </span>
                                                                </td>
                                                                <td className='text-muted px-3 py-2 align-middle'>
                                                                    <span className='flex items-center gap-2'>
                                                                        <TargetIcon className='text-subtle h-4 w-4 shrink-0' />
                                                                        <span className='min-w-0 truncate'>
                                                                            {
                                                                                row.targetLabel
                                                                            }
                                                                        </span>
                                                                    </span>
                                                                </td>
                                                                <td className='px-3 py-2 align-middle'>
                                                                    <FromCell
                                                                        row={
                                                                            row
                                                                        }
                                                                    />
                                                                </td>
                                                                <td className='px-3 py-2 align-middle'>
                                                                    <ToCell
                                                                        row={
                                                                            row
                                                                        }
                                                                        value={targetOf(
                                                                            row
                                                                        )}
                                                                        disabled={
                                                                            running
                                                                        }
                                                                        onPick={(
                                                                            version
                                                                        ) =>
                                                                            pickTarget(
                                                                                row,
                                                                                version
                                                                            )
                                                                        }
                                                                    />
                                                                </td>
                                                                <td className='px-3 py-2 align-middle'>
                                                                    <RowStatus
                                                                        row={
                                                                            row
                                                                        }
                                                                        run={
                                                                            run
                                                                        }
                                                                    />
                                                                </td>
                                                                <td className='px-3 py-2 text-right align-middle'>
                                                                    <RowAction
                                                                        row={
                                                                            row
                                                                        }
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
                                                            {detail && (
                                                                <tr className='border-none'>
                                                                    <td />
                                                                    <td
                                                                        colSpan={
                                                                            6
                                                                        }
                                                                        className={[
                                                                            'text-caption px-3 pt-0 pb-2',
                                                                            detail.error
                                                                                ? 'text-error'
                                                                                : 'text-muted'
                                                                        ].join(
                                                                            ' '
                                                                        )}
                                                                    >
                                                                        {
                                                                            detail.text
                                                                        }
                                                                    </td>
                                                                </tr>
                                                            )}
                                                        </Fragment>
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
