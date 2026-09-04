import {
    BUILT_IN_PROVIDERS,
    BuiltInProviderEntry,
    InferenceProtocol,
    ModelPriceEntryView,
    ProtocolModelMap,
    UserModelProvider,
    UserModelProviderSummary,
    UserModelProviderUsageReport,
    lookupBuiltIn
} from '@manyfold/shared'
import type { FC, FormEvent, ReactNode } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import anthropicIcon from '@lobehub/icons-static-svg/icons/anthropic.svg'
import geminiIcon from '@lobehub/icons-static-svg/icons/gemini-color.svg'
import openaiIcon from '@lobehub/icons-static-svg/icons/openai.svg'
import openrouterIcon from '@lobehub/icons-static-svg/icons/openrouter.svg'
import EmptyState from '@/components/EmptyState'
import { CascadeShell } from '@/components/CascadeShell'
import { CreateMenu, type CreateMenuOption } from '@/components/CreateMenu'
import {
    GroupByControl,
    type GroupByOption,
    GroupHeader,
    type Health,
    useCascadeState
} from '@/lib/cascade'
import { useI18n, type TFn } from '@/lib/i18n'
import { useProductConfirm } from '@/components/ProductConfirmDialog'
import Breadcrumb from '@/components/Breadcrumb'
import {
    BoxIcon,
    ChevronDownIcon,
    ChevronUpIcon,
    ListViewIcon,
    PlugIcon,
    PlusIcon,
    ZapIcon
} from '@/components/icons'
import { Ghost, Spinner } from '@/components/Loading'
import { useLoadingGate } from '@/components/useLoadingGate'
import { useApiClient } from '@/lib/apiClient'
import { NetmindSignInDialog } from '@/components/NetmindSignInDialog'
import { NetmindMark } from '@/lib/brandMarks'
import { apiErrorMessage } from '@/lib/errorMessage'
import ModelProvidersDashboard from '@/pages/Settings/ModelProvidersDashboard'
import { spendWindowFrom, type SpendWindow } from '@/lib/modelProviderSpend'
import { formatLocalDateTime } from '@/lib/usageFormat'
import {
    ManagedView,
    NetmindRowExtras,
    SidebarManagedRow,
    useManagedProviderAccount,
    useNetmindConnect,
    type ManagedProviderState
} from '@/pages/Settings/managedProviderSlots'
import ModelProviderFields, {
    emptyModelProviderForm,
    inferenceProtocolLabel,
    type ModelProviderFormState
} from '@/pages/Settings/ModelProviderFields'

export const ALL_TAB_KEY = '__all'

// The create menu's rows, shared by the rail header, the rail footer and the
// dashboard so the three affordances cannot offer different providers.
const newProviderOptions = (
    t: TFn,
    onPick: (next: Selection) => void
): CreateMenuOption[] => [
    ...BUILT_IN_PROVIDERS.map((entry) => ({
        key: entry.id,
        lead: <BuiltInLogo entry={entry} />,
        label: entry.label,
        onSelect: () => onPick({ kind: 'builtin', builtInId: entry.id })
    })),
    {
        key: 'custom-new',
        icon: PlusIcon,
        label: t('web.modelProviders.customProvider'),
        onSelect: () => onPick({ kind: 'custom-new' })
    }
]

type ProviderGroupBy = 'none' | 'provider' | 'protocol' | 'status'

const PROVIDER_DIMS = ['none', 'provider', 'protocol', 'status'] as const

interface ProviderGroup {
    key: string
    label: string
    count: number
    health: Health
    items: UserModelProviderSummary[]
}

// A group is only as healthy as its worst key: one failed connection test is
// worth surfacing on a collapsed header.
const providerGroupHealth = (items: UserModelProviderSummary[]): Health =>
    items.some((r) => r.lastTestStatus === 'error') ? 'error' : null

import {
    DASHBOARD_SEGMENT,
    providerSelectionFor,
    selectionsEqual,
    selectionToParam,
    type Selection
} from '@/pages/Settings/modelProviderSelection'

import {
    buildModelGroups,
    countModelPairs,
    enabledPairCount,
    type ModelGroup
} from '@/lib/modelListView'
import {
    flattenProtocolMap,
    ModelPricePanel,
    ModelPriceSummary,
    totalModelCounts
} from '@/pages/Settings/modelProviderPricing'

const ModelProviders: FC = (): ReactNode => {
    const { t } = useI18n()
    const client = useApiClient()
    const [searchParams, setSearchParams] = useSearchParams()
    const navigate = useNavigate()
    // Reserved segment under model-providers/*: provider ids never reach the
    // path (selection is a query param), so a bare word cannot collide.
    const segment = useParams()['*'] ?? ''
    const onDashboard = segment === DASHBOARD_SEGMENT
    const [spendWindow, setSpendWindow] = useState<SpendWindow>('30d')
    const [spend, setSpend] = useState<UserModelProviderUsageReport | null>(
        null
    )
    const [spendLoading, setSpendLoading] = useState(false)
    const [items, setItems] = useState<UserModelProviderSummary[]>([])
    const managed = useManagedProviderAccount()
    const [error, setError] = useState<string | null>(null)
    const [selected, setSelected] = useState<Selection | null>(null)
    const [loaded, setLoaded] = useState(false)
    // §10.8: the rail ghosts on the cold load so the "No providers yet"
    // first-use state never appears before we know it is true.
    const gate = useLoadingGate(!loaded)

    const refresh = async (): Promise<void> => {
        try {
            const rows = await client.modelProviders.list()
            setItems(rows)
            setError(null)
            await managed.refresh()
        } catch (e) {
            setError((e as Error).message)
        } finally {
            setLoaded(true)
        }
    }

    useEffect(() => {
        void refresh()
    }, [client])

    const managedRows = useMemo(
        () => items.filter((r) => r.source === 'managed'),
        [items]
    )
    const nonManagedRows = useMemo(() => {
        return items
            .filter((r) => r.source !== 'managed')
            .slice()
            .sort((a, b) => {
                const aBuiltIn = a.builtInId ? 0 : 1
                const bBuiltIn = b.builtInId ? 0 : 1
                if (aBuiltIn !== bBuiltIn) return aBuiltIn - bBuiltIn
                return a.createdAt.localeCompare(b.createdAt)
            })
    }, [items])
    const hasManaged = managedRows.length > 0 || managed.hasAccount

    const selectedParam = searchParams.get('selected')
    useEffect(() => {
        // Includes leaving a provider for the dashboard: that segment resolves
        // to no selection, and dropping the early return this had is what lets
        // the pane actually switch back.
        const next = providerSelectionFor({
            onDashboard,
            param: selectedParam,
            items,
            hasManaged
        })
        setSelected((prev) => (selectionsEqual(prev, next) ? prev : next))
    }, [items, hasManaged, nonManagedRows, selectedParam, onDashboard])

    const selectAndPersist = (next: Selection): void => {
        setSelected(next)
        const param = selectionToParam(next)
        if (!param) return
        // navigate(), not setSearchParams(): from /dashboard the latter would
        // keep the segment and produce /dashboard?selected=... Pushing (not
        // replacing) when leaving the dashboard keeps Back going there.
        navigate(
            {
                pathname: '/settings/model-providers',
                search: `?selected=${param}`
            },
            { replace: !onDashboard }
        )
    }

    const onCreated = async (id: string): Promise<void> => {
        await refresh()
        selectAndPersist({ kind: 'configured', id })
    }

    const onDeleted = async (id: string): Promise<void> => {
        await refresh()
        const remaining = nonManagedRows.filter((i) => i.id !== id)
        if (hasManaged) selectAndPersist({ kind: 'managed' })
        else if (remaining.length > 0)
            selectAndPersist({ kind: 'configured', id: remaining[0].id })
        else {
            setSelected(null)
            searchParams.delete('selected')
            setSearchParams(searchParams, { replace: true })
        }
    }

    const hasSelection = Boolean(selectedParam) || onDashboard

    // Dashboard-only fetch: a failure degrades to em-dashes on the cards and
    // never reaches the page error banner.
    useEffect(() => {
        if (hasSelection && !onDashboard) return
        let cancelled = false
        setSpendLoading(true)
        client.modelProviders
            .usage({ from: spendWindowFrom(spendWindow) })
            .then((r) => {
                if (!cancelled) setSpend(r)
            })
            .catch(() => undefined)
            .finally(() => {
                if (!cancelled) setSpendLoading(false)
            })
        return () => {
            cancelled = true
        }
    }, [client, hasSelection, onDashboard, spendWindow])

    return (
        <CascadeShell
            railLabel={t('web.settingsLayout.providers')}
            hasSelection={hasSelection}
            rail={
                <ProviderSidebar
                    managedRows={managedRows}
                    hasManaged={hasManaged}
                    managedState={managed.state}
                    nonManagedRows={nonManagedRows}
                    selected={selected}
                    onSelect={selectAndPersist}
                    loaded={loaded}
                    showLoading={gate.showLoading}
                />
            }
        >
            <div className='mx-auto w-full max-w-3xl px-5 py-6 md:px-6 md:py-7'>
                {!selected && loaded && (
                    <ModelProvidersDashboard
                        providers={items}
                        report={spend}
                        loading={spendLoading}
                        window={spendWindow}
                        onWindowChange={setSpendWindow}
                        onSelect={(id) =>
                            selectAndPersist({ kind: 'configured', id })
                        }
                        createOptions={newProviderOptions(t, selectAndPersist)}
                    />
                )}
                {error && (
                    <div className='workbench-alert-error mb-6'>
                        <pre className='text-caption whitespace-pre-wrap font-mono'>
                            {error}
                        </pre>
                    </div>
                )}
                {selected &&
                    (() => {
                        let crumb = t('web.credentials.provider')
                        if (selected.kind === 'custom-new')
                            crumb = t('web.modelProviders.newProvider')
                        else if (selected.kind === 'builtin')
                            crumb =
                                lookupBuiltIn(selected.builtInId)?.label ??
                                t('web.credentials.provider')
                        else if (selected.kind === 'managed')
                            crumb = t('web.modelProviders.managed')
                        else if (selected.kind === 'configured')
                            crumb =
                                nonManagedRows.find((r) => r.id === selected.id)
                                    ?.providerName ??
                                t('web.credentials.provider')
                        return (
                            <Breadcrumb
                                items={[
                                    {
                                        label: t(
                                            'web.settingsLayout.providers'
                                        ),
                                        to: '/settings/model-providers'
                                    },
                                    { label: crumb }
                                ]}
                            />
                        )
                    })()}
                <div className='space-y-6'>
                    {selected?.kind === 'custom-new' && (
                        <CustomNewView onCreated={(id) => void onCreated(id)} />
                    )}
                    {selected?.kind === 'builtin' && (
                        <BuiltInSetupView
                            entry={
                                lookupBuiltIn(selected.builtInId) ??
                                BUILT_IN_PROVIDERS[0]
                            }
                            onCreated={(id) => void onCreated(id)}
                        />
                    )}
                    {selected?.kind === 'managed' && (
                        <ManagedView
                            rows={managedRows}
                            state={managed.state}
                            onChanged={() => void refresh()}
                        />
                    )}
                    {selected?.kind === 'configured' &&
                        (() => {
                            const row = nonManagedRows.find(
                                (r) => r.id === selected.id
                            )
                            if (!row) return null
                            return (
                                <ConfiguredView
                                    key={row.id}
                                    row={row}
                                    onChanged={() => void refresh()}
                                    onDeleted={() => void onDeleted(row.id)}
                                />
                            )
                        })()}
                </div>
            </div>
        </CascadeShell>
    )
}

interface ProviderSidebarProps {
    managedRows: UserModelProviderSummary[]
    hasManaged: boolean
    managedState: ManagedProviderState
    nonManagedRows: UserModelProviderSummary[]
    selected: Selection | null
    onSelect: (next: Selection) => void
    loaded: boolean
    showLoading: boolean
}

export const providerLeafClass = (
    selected: boolean,
    muted: boolean,
    // Grouped rows sit under a header's chevron column; ungrouped ones sit at
    // the rail's own left edge. The cloud managed row passes nothing and keeps
    // the ungrouped indent, because it is never inside a group.
    indentClass = 'pl-2'
): string =>
    [
        'flex w-full items-center gap-2.5 rounded-sm py-2 pr-2.5 text-left transition-colors',
        indentClass,
        selected
            ? 'bg-active-session'
            : muted
              ? 'opacity-75 hover:bg-rail-hover hover:opacity-100'
              : 'hover:bg-rail-hover'
    ].join(' ')

const ProviderTag: FC<{ label: string }> = ({ label }): ReactNode => (
    <span className='tag tag-neutral'>{label}</span>
)

const ghostProviderWidth = ['w-2/3', 'w-1/2', 'w-3/5']

const ProviderSidebar: FC<ProviderSidebarProps> = ({
    managedRows,
    hasManaged,
    managedState,
    nonManagedRows,
    selected,
    onSelect,
    loaded,
    showLoading
}): ReactNode => {
    const { t } = useI18n()
    const options = newProviderOptions(t, onSelect)
    const { groupBy, setGroupBy, expanded, toggle, collapseAll, expandAll } =
        useCascadeState('mf.modelProviders.cascade.v1', PROVIDER_DIMS, 'none')

    const total = (hasManaged ? 1 : 0) + nonManagedRows.length

    const groups = useMemo<ProviderGroup[]>(() => {
        // None renders one unheadered group, so the header-only fields stay
        // empty — the rail lists every provider flat, in its existing order.
        if (groupBy === 'none')
            return nonManagedRows.length === 0
                ? []
                : [
                      {
                          key: 'all',
                          label: '',
                          count: nonManagedRows.length,
                          health: null,
                          items: nonManagedRows
                      }
                  ]

        const bucket = (
            row: UserModelProviderSummary
        ): { key: string; label: string } => {
            if (groupBy === 'provider') {
                const entry = row.builtInId
                    ? lookupBuiltIn(row.builtInId)
                    : null
                return entry
                    ? { key: `bi:${entry.id}`, label: entry.label }
                    : { key: 'bi:custom', label: t('web.credentials.custom') }
            }
            if (groupBy === 'protocol')
                return row.inferenceProtocol
                    ? {
                          key: `pr:${row.inferenceProtocol}`,
                          label: inferenceProtocolLabel[row.inferenceProtocol]
                      }
                    : { key: 'pr:none', label: t('web.credentials.custom') }
            if (row.lastTestStatus === 'ok')
                return {
                    key: 'st:ok',
                    label: t('web.runtimesDashboard.testPassed')
                }
            if (row.lastTestStatus === 'error')
                return {
                    key: 'st:error',
                    label: t('web.runtimesDashboard.testFailed')
                }
            return {
                key: 'st:none',
                label: t('web.runtimesDashboard.neverTested')
            }
        }

        // Insertion order preserved, so groups follow the same built-in-first
        // ordering the flat list already uses.
        const out: ProviderGroup[] = []
        const byKey = new Map<string, ProviderGroup>()
        for (const row of nonManagedRows) {
            const { key, label } = bucket(row)
            let group = byKey.get(key)
            if (!group) {
                group = { key, label, count: 0, health: null, items: [] }
                byKey.set(key, group)
                out.push(group)
            }
            group.items.push(row)
        }
        for (const group of out) {
            group.count = group.items.length
            group.health = providerGroupHealth(group.items)
        }
        return out
    }, [nonManagedRows, groupBy, t])

    const allKeys = useMemo(() => groups.map((g) => g.key), [groups])
    const isOpen = (key: string): boolean => expanded.has(key)
    const anyExpanded = expanded.size > 0

    const groupByOptions: ReadonlyArray<GroupByOption<ProviderGroupBy>> = [
        {
            value: 'none',
            label: t('web.modelProviders.groupBy.none'),
            icon: ListViewIcon
        },
        {
            value: 'provider',
            label: t('web.modelProviders.groupBy.provider'),
            icon: BoxIcon
        },
        {
            value: 'protocol',
            label: t('web.modelProviders.groupBy.protocol'),
            icon: PlugIcon
        },
        {
            value: 'status',
            label: t('web.modelProviders.groupBy.status'),
            icon: ZapIcon
        }
    ]

    return (
        <>
            <div className='shrink-0 space-y-2.5 p-3'>
                <div className='flex items-center justify-between'>
                    <Link
                        to='/settings/model-providers/dashboard'
                        aria-current={selected === null ? 'page' : undefined}
                        className='hover:bg-rail-hover -mx-1.5 flex min-w-0 items-center gap-2 rounded-sm px-1.5 py-1 transition-colors'
                    >
                        <h2 className='text-h3 text-fg'>
                            {t('web.settingsLayout.providers')}
                        </h2>
                        <span className='tag tag-neutral tabular-nums'>
                            {total}
                        </span>
                    </Link>
                    <CreateMenu
                        options={options}
                        variant='header'
                        triggerLabel={t('web.modelProviders.newProviderButton')}
                        sheetTitle={t('web.modelProviders.newProvider')}
                    />
                </div>
                <div className='flex items-center justify-between gap-2'>
                    <GroupByControl
                        value={groupBy}
                        onChange={setGroupBy}
                        options={groupByOptions}
                    />
                    {groupBy !== 'none' && (
                        <button
                            type='button'
                            onClick={
                                anyExpanded
                                    ? collapseAll
                                    : () => expandAll(allKeys)
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
                </div>
            </div>

            <div className='min-h-0 flex-1 overflow-y-auto px-2 pb-2'>
                {showLoading ? (
                    <div aria-busy='true'>
                        {[0, 1, 2].map((row) => (
                            <div
                                key={row}
                                className='flex items-center gap-2.5 px-3 py-2.5'
                            >
                                <Ghost
                                    variant='tile'
                                    className='h-6 w-6 shrink-0'
                                />
                                <Ghost
                                    variant='line'
                                    className={ghostProviderWidth[row]}
                                />
                            </div>
                        ))}
                    </div>
                ) : !loaded ? null : total === 0 ? (
                    <div className='text-caption text-subtle px-3 py-4'>
                        {t('web.modelProviders.noProviders')}
                    </div>
                ) : (
                    <>
                        {hasManaged && (
                            <SidebarManagedRow
                                rows={managedRows}
                                state={managedState}
                                selected={selected?.kind === 'managed'}
                                onClick={() => onSelect({ kind: 'managed' })}
                            />
                        )}
                        {groups.map((group) => (
                            <div key={group.key}>
                                {groupBy !== 'none' && (
                                    <GroupHeader
                                        label={group.label}
                                        count={group.count}
                                        open={isOpen(group.key)}
                                        health={group.health}
                                        onToggle={() => toggle(group.key)}
                                    />
                                )}
                                {(groupBy === 'none' || isOpen(group.key)) &&
                                    group.items.map((row) => (
                                        <SidebarRow
                                            key={row.id}
                                            row={row}
                                            indentClass={
                                                groupBy === 'none'
                                                    ? 'pl-2'
                                                    : 'pl-8'
                                            }
                                            selected={
                                                selected?.kind ===
                                                    'configured' &&
                                                selected.id === row.id
                                            }
                                            onClick={() =>
                                                onSelect({
                                                    kind: 'configured',
                                                    id: row.id
                                                })
                                            }
                                        />
                                    ))}
                            </div>
                        ))}
                    </>
                )}
            </div>

            <div className='shrink-0 p-2'>
                <CreateMenu
                    options={options}
                    variant='footer'
                    triggerLabel={t('web.modelProviders.newProviderButton')}
                    sheetTitle={t('web.modelProviders.newProvider')}
                />
            </div>
        </>
    )
}

const SidebarRow: FC<{
    row: UserModelProviderSummary
    indentClass: string
    selected: boolean
    onClick: () => void
}> = ({ row, indentClass, selected, onClick }): ReactNode => {
    const { t } = useI18n()
    const builtInEntry = row.builtInId ? lookupBuiltIn(row.builtInId) : null
    const counts = totalModelCounts(row)
    const tag = row.builtInId
        ? t('web.credentials.builtIn')
        : t('web.credentials.custom')
    const protocol =
        builtInEntry?.label ??
        (row.inferenceProtocol
            ? inferenceProtocolLabel[row.inferenceProtocol]
            : t('web.credentials.custom'))
    return (
        <button
            type='button'
            onClick={onClick}
            aria-current={selected ? 'true' : undefined}
            className={providerLeafClass(selected, false, indentClass)}
        >
            <span className='flex h-5 w-5 shrink-0 items-center justify-center'>
                {builtInEntry ? (
                    <BuiltInLogo entry={builtInEntry} />
                ) : (
                    <span className='text-caption text-muted font-mono'>
                        {row.providerName.charAt(0).toUpperCase()}
                    </span>
                )}
            </span>
            <span className='min-w-0 flex-1'>
                <span className='text-ui text-fg block truncate'>
                    {row.providerName}
                </span>
                <span className='text-caption text-subtle block truncate'>
                    {protocol}
                    {counts.total > 0 && (
                        <>
                            {' · '}
                            {t('web.modelProviders.modelsFraction', {
                                enabled: counts.enabled,
                                total: counts.total
                            })}
                        </>
                    )}
                </span>
            </span>
            <ProviderTag label={tag} />
        </button>
    )
}

const BuiltInSetupView: FC<{
    entry: BuiltInProviderEntry
    onCreated: (id: string) => void
}> = ({ entry, onCreated }): ReactNode => {
    const { t } = useI18n()
    const client = useApiClient()
    const [apiKey, setApiKey] = useState('')
    const [name, setName] = useState('')
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const netmindConnect = useNetmindConnect()
    const [connectOpen, setConnectOpen] = useState(false)
    const showConnect = entry.id === 'netmind' && netmindConnect

    useEffect(() => {
        setApiKey('')
        setName('')
        setError(null)
        setConnectOpen(false)
    }, [entry.id])

    const submit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
        e.preventDefault()
        setBusy(true)
        setError(null)
        try {
            const created = await client.modelProviders.createBuiltIn({
                builtInId: entry.id,
                providerName: name.trim() || undefined,
                apiKey
            })
            onCreated(created.id)
        } catch (err) {
            setError(apiErrorMessage(err))
        } finally {
            setBusy(false)
        }
    }

    return (
        <section className='workbench-panel space-y-4 p-5 md:p-6'>
            <header className='space-y-2'>
                <div className='flex flex-wrap items-center gap-2'>
                    <h2 className='text-h3 text-fg'>
                        {entry.label}
                    </h2>
                    <span className='tag tag-neutral'>
                        {t('web.credentials.builtIn')}
                    </span>
                </div>
                {entry.description && (
                    <p className='text-caption text-muted'>
                        {entry.description}
                    </p>
                )}
                <div className='flex flex-wrap gap-2'>
                    {entry.protocols.map((p) => (
                        <span key={p.protocol} className='tag tag-neutral'>
                            {inferenceProtocolLabel[p.protocol]}
                        </span>
                    ))}
                </div>
            </header>
            {showConnect && (
                <div className='space-y-3'>
                    <button
                        type='button'
                        onClick={() => setConnectOpen(true)}
                        className='workbench-button-primary h-9'
                    >
                        {t('web.modelProviders.connectNetmind')}
                    </button>
                    <p className='text-caption text-muted'>
                        {t('web.modelProviders.netmindHint')}
                    </p>
                    <div
                        className='flex items-center gap-3'
                        role='separator'
                        aria-label={t('web.modelProviders.pasteApiKey')}
                    >
                        <span className='bg-divider h-px flex-1' />
                        <span className='text-caption text-muted'>
                            {t('web.modelProviders.pasteApiKey')}
                        </span>
                        <span className='bg-divider h-px flex-1' />
                    </div>
                </div>
            )}
            <form onSubmit={submit} className='space-y-4'>
                <label className='block'>
                    <span className='workbench-field-label'>
                        {t('web.modelProviders.name')}
                    </span>
                    <input
                        type='text'
                        pattern='^[A-Za-z0-9][A-Za-z0-9_\- .]*$'
                        maxLength={64}
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder={entry.label}
                        className='workbench-input'
                    />
                    <p className='workbench-hint'>
                        {t('web.modelProviders.optionalNameHint', {
                            provider: entry.label
                        })}
                    </p>
                </label>
                <label className='block'>
                    <span className='workbench-field-label'>
                        {t('web.modelProviders.apiKey')}
                    </span>
                    <input
                        type='password'
                        autoComplete='off'
                        required
                        minLength={10}
                        value={apiKey}
                        onChange={(e) => setApiKey(e.target.value)}
                        placeholder={t('web.modelProviders.pasteKey')}
                        className='workbench-input font-mono'
                    />
                </label>
                {error && (
                    <div className='workbench-alert-error'>
                        <pre className='text-caption whitespace-pre-wrap font-mono'>
                            {error}
                        </pre>
                    </div>
                )}
                <div className='flex justify-end'>
                    <button
                        type='submit'
                        disabled={busy}
                        aria-busy={busy}
                        className='workbench-button-primary h-9'
                    >
                        {busy ? (
                            <>
                                <Spinner size={16} className='mr-2' />
                                {t('common.saving')}
                            </>
                        ) : (
                            t('web.modelProviders.saveProvider')
                        )}
                    </button>
                </div>
            </form>
            {connectOpen && (
                <NetmindSignInDialog
                    title={t('web.account.connectNetmindTitle')}
                    submitLabel={t('web.account.connect')}
                    description={t(
                        'web.modelProviders.connectNetmindDescription'
                    )}
                    onToken={async (loginToken) => {
                        try {
                            const created =
                                await client.modelProviders.connectNetmind({
                                    loginToken
                                })
                            setConnectOpen(false)
                            onCreated(created.id)
                        } catch (err) {
                            throw new Error(apiErrorMessage(err))
                        }
                    }}
                    onClose={() => setConnectOpen(false)}
                />
            )}
        </section>
    )
}

const CustomNewView: FC<{
    onCreated: (id: string) => void
}> = ({ onCreated }): ReactNode => {
    const { t } = useI18n()
    const client = useApiClient()
    const [form, setForm] = useState(emptyModelProviderForm)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const submit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
        e.preventDefault()
        setBusy(true)
        setError(null)
        try {
            const created = await client.modelProviders.create({
                inferenceProtocol: form.inferenceProtocol,
                providerName: form.providerName,
                apiKey: form.apiKey,
                baseUrl: form.baseUrl,
                modelsListUrl: form.modelsListUrl || undefined
            })
            onCreated(created.id)
        } catch (err) {
            setError(apiErrorMessage(err))
        } finally {
            setBusy(false)
        }
    }

    return (
        <section className='workbench-panel space-y-4 p-5 md:p-6'>
            <header>
                <h2 className='text-h3 text-fg'>
                    {t('web.modelProviders.createCustom')}
                </h2>
                <p className='text-caption text-muted mt-1'>
                    {t('web.modelProviders.createCustomDescription')}
                </p>
            </header>
            <form onSubmit={submit} className='space-y-4'>
                <ModelProviderFields
                    form={form}
                    onChange={setForm}
                    onTest={(snapshot) =>
                        client.modelProviders.testInline({
                            inferenceProtocol: snapshot.inferenceProtocol,
                            apiKey: snapshot.apiKey,
                            baseUrl: snapshot.baseUrl,
                            modelsListUrl: snapshot.modelsListUrl
                                ? snapshot.modelsListUrl
                                : undefined
                        })
                    }
                />
                {error && (
                    <div className='workbench-alert-error'>
                        <pre className='text-caption whitespace-pre-wrap font-mono'>
                            {error}
                        </pre>
                    </div>
                )}
                <div className='flex justify-end'>
                    <button
                        type='submit'
                        disabled={busy}
                        aria-busy={busy}
                        className='workbench-button-primary h-9'
                    >
                        {busy ? (
                            <>
                                <Spinner size={16} className='mr-2' />
                                {t('common.saving')}
                            </>
                        ) : (
                            t('web.modelProviders.saveProvider')
                        )}
                    </button>
                </div>
            </form>
        </section>
    )
}

interface ConfiguredViewProps {
    row: UserModelProviderSummary
    onChanged: () => void
    onDeleted: () => void
}

const ConfiguredView: FC<ConfiguredViewProps> = ({
    row,
    onChanged,
    onDeleted
}): ReactNode => {
    return (
        <>
            <NetmindRowExtras row={row} />
            {row.builtInId ? (
                <BuiltInEditCard
                    row={row}
                    onChanged={onChanged}
                    onDeleted={onDeleted}
                />
            ) : (
                <CustomEditCard
                    row={row}
                    onChanged={onChanged}
                    onDeleted={onDeleted}
                />
            )}
            <ModelListSection row={row} onChanged={onChanged} />
        </>
    )
}

const BuiltInEditCard: FC<{
    row: UserModelProviderSummary
    onChanged: () => void
    onDeleted: () => void
}> = ({ row, onChanged, onDeleted }): ReactNode => {
    const client = useApiClient()
    const { t } = useI18n()
    const { confirm, confirmDialog } = useProductConfirm()
    const entry = row.builtInId ? lookupBuiltIn(row.builtInId) : null
    const [apiKey, setApiKey] = useState('')
    const [name, setName] = useState(row.providerName)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [revealed, setRevealed] = useState<string | null>(null)

    useEffect(() => {
        setApiKey('')
        setName(row.providerName)
        setRevealed(null)
        setError(null)
    }, [row.id, row.providerName])

    const nameChanged = name.trim() !== row.providerName && name.trim() !== ''
    const dirty = apiKey.length > 0 || nameChanged

    const save = async (): Promise<void> => {
        setBusy(true)
        setError(null)
        try {
            await client.modelProviders.update(row.id, {
                providerName: nameChanged ? name.trim() : undefined,
                apiKey: apiKey || undefined
            })
            setApiKey('')
            onChanged()
        } catch (err) {
            setError(apiErrorMessage(err))
        } finally {
            setBusy(false)
        }
    }

    const reveal = async (): Promise<void> => {
        if (revealed) {
            setRevealed(null)
            return
        }
        try {
            const { apiKey: plain } = await client.modelProviders.reveal(row.id)
            setRevealed(plain)
        } catch (e) {
            setError((e as Error).message)
        }
    }

    const remove = async (): Promise<void> => {
        if (
            !(await confirm({
                title: t('web.modelProviders.deleteKeyTitle'),
                description: t('web.modelProviders.deleteKeyDescription'),
                confirmLabel: t('web.modelProviders.delete'),
                tone: 'danger'
            }))
        ) {
            return
        }
        setBusy(true)
        try {
            await client.modelProviders.delete(row.id)
            onDeleted()
        } catch (e) {
            setError((e as Error).message)
        } finally {
            setBusy(false)
        }
    }

    return (
        <section className='workbench-panel space-y-4 p-5 md:p-6'>
            <header className='space-y-2'>
                <div className='flex flex-wrap items-center gap-2'>
                    <h2 className='text-h3 text-fg'>
                        {row.providerName}
                    </h2>
                    <span className='tag tag-neutral'>
                        {entry?.label ?? t('web.credentials.builtIn')}
                    </span>
                </div>
                {entry?.description && (
                    <p className='text-caption text-muted'>
                        {entry.description}
                    </p>
                )}
                <div className='flex flex-wrap gap-2'>
                    {entry?.protocols.map((p) => (
                        <span key={p.protocol} className='tag tag-neutral'>
                            {inferenceProtocolLabel[p.protocol]}
                        </span>
                    ))}
                </div>
            </header>
            <label className='block'>
                <span className='workbench-field-label'>
                    {t('web.modelProviders.name')}
                </span>
                <input
                    type='text'
                    pattern='^[A-Za-z0-9][A-Za-z0-9_\- .]*$'
                    maxLength={64}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className='workbench-input'
                />
            </label>
            <label className='block'>
                <span className='workbench-field-label'>
                    {t('web.modelProviders.apiKey')}
                </span>
                <div className='flex gap-2'>
                    <input
                        type='password'
                        autoComplete='off'
                        placeholder={
                            revealed ??
                            `${row.apiKeyMasked} (leave blank to keep)`
                        }
                        value={apiKey}
                        onChange={(e) => setApiKey(e.target.value)}
                        className='workbench-input flex-1 font-mono'
                    />
                    <button
                        type='button'
                        onClick={() => void reveal()}
                        className='workbench-button-secondary h-9'
                    >
                        {revealed
                            ? t('web.modelProviders.hide')
                            : t('web.modelProviders.reveal')}
                    </button>
                </div>
                {revealed && (
                    <span className='text-caption text-muted mt-1 block break-all font-mono'>
                        {revealed}
                    </span>
                )}
            </label>
            {error && (
                <div className='workbench-alert-error'>
                    <pre className='text-caption whitespace-pre-wrap font-mono'>
                        {error}
                    </pre>
                </div>
            )}
            <div className='flex flex-wrap items-center justify-between gap-2'>
                <button
                    type='button'
                    onClick={() => void remove()}
                    disabled={busy}
                    className='workbench-button-secondary text-workflow-ship h-9'
                >
                    {t('web.modelProviders.deleteProvider')}
                </button>
                <button
                    type='button'
                    onClick={() => void save()}
                    disabled={busy || !dirty}
                    className='workbench-button-primary h-9'
                >
                    {busy ? (
                        <>
                            <Spinner size={16} className='mr-2' />
                            {t('common.saving')}
                        </>
                    ) : (
                        t('common.save')
                    )}
                </button>
            </div>
            {confirmDialog}
        </section>
    )
}

const CustomEditCard: FC<{
    row: UserModelProviderSummary
    onChanged: () => void
    onDeleted: () => void
}> = ({ row, onChanged, onDeleted }): ReactNode => {
    const client = useApiClient()
    const { t } = useI18n()
    const { confirm, confirmDialog } = useProductConfirm()
    const [form, setForm] = useState<ModelProviderFormState>({
        mode: 'edit',
        id: row.id,
        builtInId: null,
        inferenceProtocol: row.inferenceProtocol ?? 'openai_chat_completions',
        providerName: row.providerName,
        apiKey: '',
        baseUrl: row.baseUrl ?? '',
        modelsListUrl: row.modelsListUrl ?? ''
    })
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [revealed, setRevealed] = useState<string | null>(null)

    useEffect(() => {
        setForm({
            mode: 'edit',
            id: row.id,
            builtInId: null,
            inferenceProtocol:
                row.inferenceProtocol ?? 'openai_chat_completions',
            providerName: row.providerName,
            apiKey: '',
            baseUrl: row.baseUrl ?? '',
            modelsListUrl: row.modelsListUrl ?? ''
        })
        setRevealed(null)
        setError(null)
    }, [row.id])

    const save = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
        e.preventDefault()
        setBusy(true)
        setError(null)
        try {
            await client.modelProviders.update(row.id, {
                providerName: form.providerName,
                inferenceProtocol: form.inferenceProtocol,
                apiKey: form.apiKey || undefined,
                baseUrl: form.baseUrl ? form.baseUrl : null,
                modelsListUrl: form.modelsListUrl ? form.modelsListUrl : null
            })
            setForm((prev) => ({ ...prev, apiKey: '' }))
            onChanged()
        } catch (err) {
            setError(apiErrorMessage(err))
        } finally {
            setBusy(false)
        }
    }

    const reveal = async (): Promise<void> => {
        if (revealed) {
            setRevealed(null)
            return
        }
        try {
            const { apiKey: plain } = await client.modelProviders.reveal(row.id)
            setRevealed(plain)
        } catch (e) {
            setError((e as Error).message)
        }
    }

    const remove = async (): Promise<void> => {
        if (
            !(await confirm({
                title: t('web.modelProviders.deleteKeyTitle'),
                description: t('web.modelProviders.deleteKeyDescription'),
                confirmLabel: t('web.modelProviders.delete'),
                tone: 'danger'
            }))
        ) {
            return
        }
        setBusy(true)
        try {
            await client.modelProviders.delete(row.id)
            onDeleted()
        } catch (e) {
            setError((e as Error).message)
        } finally {
            setBusy(false)
        }
    }

    return (
        <section className='workbench-panel space-y-4 p-5 md:p-6'>
            <header className='flex flex-wrap items-center justify-between gap-2'>
                <div className='flex flex-wrap items-center gap-2'>
                    <h2 className='text-h3 text-fg'>
                        {row.providerName}
                    </h2>
                    <span className='tag tag-neutral'>
                        {t('web.credentials.custom')}
                    </span>
                </div>
                <button
                    type='button'
                    onClick={() => void reveal()}
                    className='workbench-button-secondary h-8 px-3'
                >
                    {revealed
                        ? t('web.modelProviders.hideKey')
                        : t('web.modelProviders.revealKey')}
                </button>
            </header>
            {revealed && (
                <div className='text-caption text-muted break-all font-mono'>
                    {revealed}
                </div>
            )}
            <form onSubmit={save} className='space-y-4'>
                <ModelProviderFields form={form} onChange={setForm} />
                {error && (
                    <div className='workbench-alert-error'>
                        <pre className='text-caption whitespace-pre-wrap font-mono'>
                            {error}
                        </pre>
                    </div>
                )}
                <div className='flex flex-wrap items-center justify-between gap-2'>
                    <button
                        type='button'
                        onClick={() => void remove()}
                        disabled={busy}
                        className='workbench-button-secondary text-workflow-ship h-9'
                    >
                        {t('web.modelProviders.deleteProvider')}
                    </button>
                    <button
                        type='submit'
                        disabled={busy}
                        aria-busy={busy}
                        className='workbench-button-primary h-9'
                    >
                        {busy ? (
                            <>
                                <Spinner size={16} className='mr-2' />
                                {t('common.saving')}
                            </>
                        ) : (
                            t('common.save')
                        )}
                    </button>
                </div>
            </form>
            {confirmDialog}
        </section>
    )
}

const ModelListSection: FC<{
    row: UserModelProviderSummary
    onChanged: () => void
}> = ({ row, onChanged }): ReactNode => {
    const { t } = useI18n()
    const client = useApiClient()
    const [activeTab, setActiveTab] = useState<string>(ALL_TAB_KEY)
    const [query, setQuery] = useState('')
    const [enabled, setEnabled] = useState<Record<string, Set<string> | 'all'>>(
        {}
    )
    const [testing, setTesting] = useState(false)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [prices, setPrices] = useState<Map<
        string,
        ModelPriceEntryView
    > | null>(null)
    const [openPriceModel, setOpenPriceModel] = useState<string | null>(null)

    useEffect(() => {
        const next: Record<string, Set<string> | 'all'> = {}
        if (row.lastTestModels) {
            for (const [protocol, models] of Object.entries(
                row.lastTestModels
            )) {
                if (row.enabledModels === null) {
                    next[protocol] = 'all'
                } else if (row.enabledModels && protocol in row.enabledModels) {
                    next[protocol] = new Set(row.enabledModels[protocol])
                } else {
                    next[protocol] = new Set(models)
                }
            }
        }
        setEnabled(next)
        setError(null)
    }, [row])

    // Refetched whenever the tested list moves (lastTestedAt changes after a
    // refresh), so a newly discovered model shows its automatic match at once.
    useEffect(() => {
        let cancelled = false
        client.modelProviders.modelPrices
            .list(row.id)
            .then((view) => {
                if (cancelled) return
                setPrices(new Map(view.models.map((m) => [m.modelId, m])))
            })
            .catch(() => {
                if (!cancelled) setPrices(null)
            })
        return () => {
            cancelled = true
        }
    }, [client, row.id, row.lastTestedAt])

    const applyPriceEntry = (next: ModelPriceEntryView): void => {
        setPrices((current) => {
            const map = new Map(current ?? [])
            map.set(next.modelId, next)
            return map
        })
    }

    const reloadPrices = (): void => {
        client.modelProviders.modelPrices
            .list(row.id)
            .then((view) =>
                setPrices(new Map(view.models.map((m) => [m.modelId, m])))
            )
            .catch(() => undefined)
    }

    const protocols = useMemo(() => {
        if (!row.lastTestModels) return [] as string[]
        return Object.keys(row.lastTestModels)
    }, [row.lastTestModels])

    const allModels = useMemo(
        () => flattenProtocolMap(row.lastTestModels),
        [row.lastTestModels]
    )

    const dirty = useMemo(() => {
        if (!row.lastTestModels) return false
        const stored = row.enabledModels
        let allEnabled = true
        const target: ProtocolModelMap = {}
        for (const [protocol, models] of Object.entries(row.lastTestModels)) {
            const state = enabled[protocol]
            if (state === 'all') {
                target[protocol] = models
                continue
            }
            if (!(state instanceof Set)) {
                target[protocol] = []
                allEnabled = false
                continue
            }
            if (
                state.size !== models.length ||
                models.some((m) => !state.has(m))
            )
                allEnabled = false
            target[protocol] = Array.from(state).sort()
        }
        const desired = allEnabled ? null : target
        if (desired === null && stored === null) return false
        if (desired === null || stored === null) return true
        const dKeys = Object.keys(desired)
        const sKeys = Object.keys(stored)
        if (dKeys.length !== sKeys.length) return true
        for (const k of dKeys) {
            const a = desired[k]
            const b = stored[k] ?? []
            if (a.length !== b.length) return true
            const set = new Set(b)
            if (a.some((m) => !set.has(m))) return true
        }
        return false
    }, [row, enabled])

    const toggle = (protocol: string, modelId: string): void => {
        setEnabled((prev) => {
            const list = row.lastTestModels?.[protocol] ?? []
            const cur = prev[protocol]
            const set =
                cur === 'all'
                    ? new Set(list)
                    : cur instanceof Set
                      ? new Set(cur)
                      : new Set<string>()
            if (set.has(modelId)) set.delete(modelId)
            else set.add(modelId)
            return { ...prev, [protocol]: set }
        })
    }

    const enableAll = (protocol: string): void =>
        setEnabled((prev) => ({ ...prev, [protocol]: 'all' }))
    const disableAll = (protocol: string): void =>
        setEnabled((prev) => ({ ...prev, [protocol]: new Set<string>() }))

    const refresh = async (): Promise<void> => {
        setTesting(true)
        setError(null)
        try {
            await client.modelProviders.test(row.id)
            onChanged()
        } catch (e) {
            setError((e as Error).message)
        } finally {
            setTesting(false)
        }
    }

    const save = async (): Promise<void> => {
        setBusy(true)
        setError(null)
        try {
            let allEnabled = true
            const target: ProtocolModelMap = {}
            if (row.lastTestModels) {
                for (const [protocol, models] of Object.entries(
                    row.lastTestModels
                )) {
                    const state = enabled[protocol]
                    if (state === 'all') {
                        target[protocol] = models
                        continue
                    }
                    if (!(state instanceof Set)) {
                        target[protocol] = []
                        allEnabled = false
                        continue
                    }
                    if (
                        state.size !== models.length ||
                        models.some((m) => !state.has(m))
                    )
                        allEnabled = false
                    target[protocol] = Array.from(state).sort()
                }
            }
            const enabledModels = allEnabled ? null : target
            await client.modelProviders.update(row.id, { enabledModels })
            onChanged()
        } catch (e) {
            setError((e as Error).message)
        } finally {
            setBusy(false)
        }
    }

    const lastTestedLine = row.lastTestedAt
        ? t('web.modelProviders.lastTested', {
              time: formatLocalDateTime(row.lastTestedAt)
          })
        : t('web.modelProviders.neverTested')

    if (protocols.length === 0)
        return (
            <section className='settings-section'>
                <div className='mb-3 flex flex-wrap items-center justify-between gap-3'>
                    <div className='min-w-0'>
                        <h3 className='settings-section-label mb-0'>
                            {t('web.modelProviders.models')}
                        </h3>
                        <p className='text-caption text-muted mt-1'>
                            {lastTestedLine}
                        </p>
                    </div>
                    <button
                        type='button'
                        onClick={() => void refresh()}
                        disabled={testing}
                        aria-busy={testing}
                        className='workbench-button-secondary h-9'
                    >
                        {testing ? (
                            <>
                                <Spinner size={16} className='mr-2' />
                                {t('web.modelProviders.refreshing')}
                            </>
                        ) : (
                            t('web.modelProviders.refreshModels')
                        )}
                    </button>
                </div>
                {error && (
                    <div className='workbench-alert-error mb-3'>
                        <pre className='text-caption whitespace-pre-wrap font-mono'>
                            {error}
                        </pre>
                    </div>
                )}
                <EmptyState
                    kind='no-results'
                    tier='stack'
                    title={t('web.emptyState.modelsTitle')}
                    body={t('web.emptyState.modelsBody')}
                />
            </section>
        )

    const tabs = [ALL_TAB_KEY, ...protocols]
    const showAll = activeTab === ALL_TAB_KEY
    const allGroups = buildModelGroups(row.lastTestModels, query)
    const visibleGroups = showAll
        ? allGroups
        : allGroups.filter((group) => group.protocol === activeTab)
    const shownPairs = countModelPairs(visibleGroups)
    const totalPairs = countModelPairs(
        buildModelGroups(row.lastTestModels, '')
    )
    const enabledPairs = enabledPairCount(visibleGroups, enabled)
    const searching = query.trim() !== ''

    return (
        <section className='settings-section'>
            <div className='mb-3 flex flex-wrap items-center justify-between gap-3'>
                <div className='min-w-0 flex-1'>
                    <div className='flex flex-wrap items-baseline gap-x-3 gap-y-1'>
                        <h3 className='settings-section-label mb-0'>
                            {t('web.modelProviders.models')}
                        </h3>
                        <span className='text-caption text-subtle tabular-nums'>
                            {searching
                                ? t('web.modelProviders.searchCount', {
                                      shown: shownPairs,
                                      total: totalPairs
                                  })
                                : t('web.modelProviders.enabledCount', {
                                      enabled: enabledPairs,
                                      total: shownPairs
                                  })}
                        </span>
                    </div>
                    <p className='text-caption text-muted mt-1'>
                        {lastTestedLine}
                    </p>
                </div>
                {/* Search, refresh and save travel as one group: below the
                    breakpoint the whole group wraps, so save never ends up
                    stranded on a line of its own. */}
                <div className='flex shrink-0 items-center gap-2'>
                    <input
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder={t('web.modelProviders.searchModels')}
                        aria-label={t('web.modelProviders.searchModels')}
                        autoComplete='off'
                        className='workbench-input h-9 w-40 min-w-0 sm:w-56'
                    />
                    <button
                        type='button'
                        onClick={() => void refresh()}
                        disabled={testing}
                        aria-busy={testing}
                        className='workbench-button-secondary h-9'
                    >
                        {testing ? (
                            <>
                                <Spinner size={16} className='mr-2' />
                                {t('web.modelProviders.refreshing')}
                            </>
                        ) : (
                            t('web.modelProviders.refreshModels')
                        )}
                    </button>
                    <button
                        type='button'
                        onClick={() => void save()}
                        disabled={busy || !dirty}
                        className='workbench-button-primary h-9'
                    >
                        {busy ? (
                            <>
                                <Spinner size={16} className='mr-2' />
                                {t('common.saving')}
                            </>
                        ) : (
                            t('common.save')
                        )}
                    </button>
                </div>
            </div>
            {error && (
                <div className='workbench-alert-error mb-3'>
                    <pre className='text-caption whitespace-pre-wrap font-mono'>
                        {error}
                    </pre>
                </div>
            )}
            {/* Scrolls rather than wraps: a wrapped row of tabs reads as two
                rows of buttons instead of one segmented control. */}
            <div className='border-divider/70 mb-3 flex gap-1 overflow-x-auto whitespace-nowrap border-b'>
                {tabs.map((tab) => {
                    const isActive = tab === activeTab
                    const label =
                        tab === ALL_TAB_KEY
                            ? t('web.modelProviders.allModels', {
                                  count: totalPairs
                              })
                            : `${inferenceProtocolLabel[tab as InferenceProtocol] ?? tab} (${(row.lastTestModels?.[tab] ?? []).length})`
                    return (
                        <button
                            key={tab}
                            type='button'
                            onClick={() => setActiveTab(tab)}
                            className={[
                                'text-caption -mb-px shrink-0 border-b-2 px-3 py-2 transition-colors',
                                isActive
                                    ? 'border-link text-fg font-medium'
                                    : 'text-muted hover:text-fg border-transparent'
                            ].join(' ')}
                        >
                            {label}
                        </button>
                    )
                })}
            </div>
            {searching && shownPairs === 0 ? (
                <EmptyState
                    kind='no-results'
                    tier='stack'
                    title={t('web.emptyState.modelSearchTitle', { query })}
                    body={t('web.emptyState.modelSearchBody')}
                />
            ) : (
                <ProtocolModelGrid
                    models={allModels}
                    rowMap={row.lastTestModels}
                    enabledMap={enabled}
                    onToggle={toggle}
                    groups={visibleGroups}
                    onEnableAllProtocol={enableAll}
                    onDisableAllProtocol={disableAll}
                    priceCell={(modelId) => (
                        <ModelPriceSummary
                            entry={prices?.get(modelId)}
                            expanded={openPriceModel === modelId}
                            onToggle={() =>
                                setOpenPriceModel((current) =>
                                    current === modelId ? null : modelId
                                )
                            }
                        />
                    )}
                    pricePanel={(modelId) =>
                        openPriceModel === modelId ? (
                            <ModelPricePanel
                                providerId={row.id}
                                modelId={modelId}
                                entry={prices?.get(modelId)}
                                onSaved={applyPriceEntry}
                                onRemoved={() => {
                                    setOpenPriceModel(null)
                                    reloadPrices()
                                }}
                            />
                        ) : null
                    }
                />
            )}
        </section>
    )
}

const Switch: FC<{
    checked: boolean
    indeterminate?: boolean
    disabled?: boolean
    onChange: () => void
}> = ({
    checked,
    indeterminate = false,
    disabled = false,
    onChange
}): ReactNode => {
    const state = checked ? 'on' : indeterminate ? 'mid' : 'off'
    const trackBg =
        state === 'on'
            ? 'bg-strong'
            : state === 'mid'
              ? 'bg-strong/40'
              : 'bg-soft'
    const thumbX =
        state === 'on'
            ? 'left-[18px]'
            : state === 'mid'
              ? 'left-[10px]'
              : 'left-0.5'
    return (
        <span className='relative inline-block h-5 w-9 shrink-0'>
            <input
                type='checkbox'
                role='switch'
                aria-checked={indeterminate ? 'mixed' : checked}
                checked={checked}
                disabled={disabled}
                ref={(el) => {
                    if (el) el.indeterminate = indeterminate
                }}
                onChange={onChange}
                className='absolute inset-0 h-full w-full cursor-pointer appearance-none rounded-full disabled:cursor-not-allowed'
            />
            <span
                aria-hidden
                className={[
                    'shadow-ring-light pointer-events-none absolute inset-0 rounded-full transition-colors',
                    trackBg,
                    disabled ? 'opacity-50' : ''
                ].join(' ')}
            />
            <span
                aria-hidden
                className={[
                    'pointer-events-none absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all',
                    thumbX
                ].join(' ')}
            />
        </span>
    )
}

export const SingleProtocolModels: FC<{
    protocol: InferenceProtocol
    models: string[]
    enabled: Set<string> | 'all' | undefined
    onToggle: (modelId: string) => void
    onEnableAll: () => void
    onDisableAll: () => void
}> = ({
    protocol,
    models,
    enabled,
    onToggle,
    onEnableAll,
    onDisableAll
}): ReactNode => {
    const { t } = useI18n()
    const isAll = enabled === 'all'
    const enabledCount = isAll
        ? models.length
        : enabled instanceof Set
          ? enabled.size
          : 0
    return (
        <div className='space-y-2'>
            <div className='flex flex-wrap items-center justify-between gap-2'>
                <span className='text-caption text-muted'>
                    {t('web.modelProviders.enabledCount', {
                        enabled: enabledCount,
                        total: models.length
                    })}
                    {isAll ? ` (${t('web.modelProviders.default')})` : ''}
                </span>
                <div className='flex gap-2'>
                    <button
                        type='button'
                        onClick={onEnableAll}
                        disabled={models.length === 0 || isAll}
                        className='workbench-button-secondary h-8 px-3'
                    >
                        {t('web.modelProviders.enableAll')}
                    </button>
                    <button
                        type='button'
                        onClick={onDisableAll}
                        disabled={
                            models.length === 0 ||
                            (enabled instanceof Set && enabled.size === 0)
                        }
                        className='workbench-button-secondary h-8 px-3'
                    >
                        {t('web.modelProviders.disableAll')}
                    </button>
                </div>
            </div>
            <ProtocolModelGrid
                models={models}
                rowMap={{ [protocol]: models }}
                enabledMap={{ [protocol]: enabled ?? new Set<string>() }}
                onToggle={(_p, modelId) => onToggle(modelId)}
            />
        </div>
    )
}

export const ProtocolModelGrid: FC<{
    models: string[]
    rowMap: ProtocolModelMap | null
    enabledMap: Record<string, Set<string> | 'all'>
    onToggle: (protocol: string, modelId: string) => void
    // Pre-built groups (already filtered by a search box, say). Omitted by
    // callers that just hand over the provider's whole map; they get the same
    // grouped view, derived here, rather than a flat list needing a protocol
    // tag on every row.
    groups?: ModelGroup[]
    onEnableAllProtocol?: (protocol: InferenceProtocol) => void
    onDisableAllProtocol?: (protocol: InferenceProtocol) => void
    // Per-model price affordances, injected by the owning section so the grid
    // stays agnostic of where the prices come from.
    priceCell?: (modelId: string) => ReactNode
    pricePanel?: (modelId: string) => ReactNode
}> = ({
    models,
    rowMap,
    enabledMap,
    onToggle,
    groups,
    onEnableAllProtocol,
    onDisableAllProtocol,
    priceCell,
    pricePanel
}): ReactNode => {
    const { t } = useI18n()
    const resolvedGroups =
        groups ??
        buildModelGroups(rowMap).map((group) => ({
            ...group,
            // A caller passing `models` has already decided what to show; keep
            // its order and membership, just grouped.
            models: group.models.filter((modelId) => models.includes(modelId))
        }))
    const visible = resolvedGroups.filter((group) => group.models.length > 0)
    if (visible.length === 0)
        return (
            <div className='text-caption text-muted'>
                {t('web.modelProviders.noModels')}
            </div>
        )
    const isEnabled = (protocol: string, modelId: string): boolean => {
        const state = enabledMap[protocol]
        if (state === 'all') return true
        if (state instanceof Set) return state.has(modelId)
        return false
    }
    const showGroupHeads = visible.length > 1
    return (
        <div className='settings-card overflow-visible'>
            {visible.map((group) => {
                const enabledHere = group.models.filter((modelId) =>
                    isEnabled(group.protocol, modelId)
                ).length
                return (
                    <div key={group.protocol}>
                        {showGroupHeads && (
                            <div className='border-divider/60 bg-surface-subtle/60 flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-t px-4 py-2 first:border-t-0'>
                                <span className='text-caption text-muted font-medium'>
                                    {inferenceProtocolLabel[group.protocol] ??
                                        group.protocol}
                                </span>
                                <span className='text-caption text-subtle tabular-nums'>
                                    {t('web.modelProviders.enabledCount', {
                                        enabled: enabledHere,
                                        total: group.models.length
                                    })}
                                </span>
                                {onEnableAllProtocol &&
                                    onDisableAllProtocol && (
                                        <span className='text-caption ml-auto flex gap-3'>
                                            <button
                                                type='button'
                                                onClick={() =>
                                                    onEnableAllProtocol(
                                                        group.protocol
                                                    )
                                                }
                                                className='text-link hover:underline'
                                            >
                                                {t(
                                                    'web.modelProviders.enableAll'
                                                )}
                                            </button>
                                            <button
                                                type='button'
                                                onClick={() =>
                                                    onDisableAllProtocol(
                                                        group.protocol
                                                    )
                                                }
                                                className='text-link hover:underline'
                                            >
                                                {t(
                                                    'web.modelProviders.disableAll'
                                                )}
                                            </button>
                                        </span>
                                    )}
                            </div>
                        )}
                        {group.models.map((modelId) => (
                            <div key={`${group.protocol}:${modelId}`}>
                                <label className='settings-card-row flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1'>
                                    <Switch
                                        checked={isEnabled(
                                            group.protocol,
                                            modelId
                                        )}
                                        onChange={() =>
                                            onToggle(group.protocol, modelId)
                                        }
                                    />
                                    <span className='text-ui min-w-0 flex-1 break-all font-mono'>
                                        {modelId}
                                    </span>
                                    {/* Wide: the price sits on the row's right
                                        edge, one scannable column. Narrow: it
                                        drops under the id rather than truncating
                                        an id whose tail is the version. */}
                                    <span className='w-full shrink-0 sm:ml-auto sm:w-auto sm:text-right'>
                                        {priceCell?.(modelId)}
                                    </span>
                                </label>
                                {pricePanel?.(modelId)}
                            </div>
                        ))}
                    </div>
                )
            })}
        </div>
    )
}

const providerIconSrc: Record<UserModelProvider, string> = {
    anthropic: anthropicIcon,
    openai: openaiIcon,
    openrouter: openrouterIcon,
    google: geminiIcon,
    antigravity: geminiIcon,
    antigravity_claude: anthropicIcon
}

const builtInIcons: Record<string, FC<{ className?: string }>> = {
    netmind: NetmindMark
}

const ProviderLogo: FC<{ provider: UserModelProvider }> = ({
    provider
}): ReactNode => (
    <img
        src={providerIconSrc[provider]}
        alt=''
        aria-hidden='true'
        className={['h-4 w-4', provider === 'google' ? '' : 'dark:invert'].join(
            ' '
        )}
    />
)

export const BuiltInLogo: FC<{ entry: BuiltInProviderEntry }> = ({
    entry
}): ReactNode => {
    const Icon = builtInIcons[entry.id]
    if (Icon) return <Icon className='text-fg' />
    if (entry.brand) return <ProviderLogo provider={entry.brand} />
    return (
        <span className='text-caption text-muted font-mono'>
            {entry.label.charAt(0).toUpperCase()}
        </span>
    )
}

export default ModelProviders
