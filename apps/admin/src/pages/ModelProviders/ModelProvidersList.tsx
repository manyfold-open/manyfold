import {
    AdminUserModelProviderSummary,
    brandFor,
    lookupBuiltIn
} from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { getLocale } from '@manyfold/i18n'
import { useApiClient } from '@/lib/apiClient'
import { useTableSort, type SortAccessors } from '@/lib/useTableSort'
import { Badge, Button, Card, Heading, SortHeader, type BadgeTone } from '@/ui'

type WindowKey = '24h' | '7d' | '30d' | '90d' | 'all'

const WINDOW_OPTIONS: Array<{
    key: WindowKey
    label: string
    days: number | null
}> = [
    { key: '24h', label: 'Last 24h', days: 1 },
    { key: '7d', label: 'Last 7 days', days: 7 },
    { key: '30d', label: 'Last 30 days', days: 30 },
    { key: '90d', label: 'Last 90 days', days: 90 },
    { key: 'all', label: 'All time', days: null }
]

type ProvidersSortKey =
    | 'providerName'
    | 'owner'
    | 'source'
    | 'agents'
    | 'cost'
    | 'inputTokens'
    | 'outputTokens'
    | 'events'
    | 'lastUsedAt'
    | 'createdAt'

const sortAccessors: SortAccessors<
    AdminUserModelProviderSummary,
    ProvidersSortKey
> = {
    providerName: (r) => r.providerName,
    owner: (r) => r.userEmail ?? r.userId,
    source: (r) => r.source,
    agents: (r) => r.boundAgentCount,
    cost: (r) => r.usage.costUsd ?? -1,
    inputTokens: (r) => r.usage.inputTokens,
    outputTokens: (r) => r.usage.outputTokens,
    events: (r) => r.usage.eventCount,
    lastUsedAt: (r) => r.usage.lastUsedAt,
    createdAt: (r) => r.createdAt
}

const fromIsoForWindow = (days: number | null): string | undefined => {
    if (days === null) return undefined
    const d = new Date()
    d.setUTCHours(0, 0, 0, 0)
    d.setUTCDate(d.getUTCDate() - (days - 1))
    return d.toISOString()
}

const formatNumber = (n: number): string =>
    new Intl.NumberFormat(getLocale()).format(n)

const formatCost = (n: number | null): string =>
    n === null || n === 0
        ? n === 0
            ? '$0.00'
            : '—'
        : new Intl.NumberFormat(getLocale(), {
              style: 'currency',
              currency: 'USD',
              maximumFractionDigits: 2
          }).format(n)

const sourceTone = (source: string): BadgeTone =>
    source === 'managed' ? 'brand' : 'neutral'

const providerDisplayName = (row: AdminUserModelProviderSummary): string => {
    if (row.builtInId) {
        const entry = lookupBuiltIn(row.builtInId)
        if (entry) return entry.label
    }
    return row.providerName
}

const brandLabel = (row: AdminUserModelProviderSummary): string | null => {
    const brand = brandFor({
        builtInId: row.builtInId,
        inferenceProtocol: row.inferenceProtocol,
        source: row.source,
        managedBrand: row.managedBrand
    })
    if (!brand) return null
    return brand
}

const ModelProvidersList: FC = (): ReactNode => {
    const client = useApiClient()
    const [rows, setRows] = useState<AdminUserModelProviderSummary[] | null>(
        null
    )
    const [error, setError] = useState<string | null>(null)
    const [windowKey, setWindowKey] = useState<WindowKey>('7d')
    const [sourceFilter, setSourceFilter] = useState<'all' | 'byo' | 'managed'>(
        'all'
    )
    const [hideUnused, setHideUnused] = useState<boolean>(false)
    const [ownerFilter, setOwnerFilter] = useState<string>('')

    const windowOption = useMemo(
        () =>
            WINDOW_OPTIONS.find((w) => w.key === windowKey) ??
            WINDOW_OPTIONS[1],
        [windowKey]
    )
    const fromIso = useMemo(
        () => fromIsoForWindow(windowOption.days),
        [windowOption]
    )

    useEffect(() => {
        setError(null)
        setRows(null)
        client.admin.modelProviders
            .list(fromIso ? { from: fromIso } : undefined)
            .then(setRows)
            .catch((e: Error) => setError(e.message))
    }, [client, fromIso])

    const ownerOptions = useMemo(() => {
        if (!rows) return [] as Array<{ id: string; label: string }>
        const seen = new Set<string>()
        const list: Array<{ id: string; label: string }> = []
        for (const r of rows) {
            if (seen.has(r.userId)) continue
            seen.add(r.userId)
            list.push({ id: r.userId, label: r.userEmail ?? r.userId })
        }
        return list.sort((a, b) => a.label.localeCompare(b.label))
    }, [rows])

    const filteredRows = useMemo(() => {
        if (!rows) return [] as AdminUserModelProviderSummary[]
        return rows.filter((r) => {
            if (sourceFilter !== 'all' && r.source !== sourceFilter)
                return false
            if (ownerFilter && r.userId !== ownerFilter) return false
            if (hideUnused && r.usage.eventCount === 0) return false
            return true
        })
    }, [rows, sourceFilter, hideUnused, ownerFilter])

    const {
        sorted: sortedRows,
        sortKey,
        direction,
        toggle
    } = useTableSort<AdminUserModelProviderSummary, ProvidersSortKey>(
        filteredRows,
        sortAccessors,
        'cost',
        'desc'
    )

    const totals = useMemo(() => {
        if (!filteredRows.length) return null
        return filteredRows.reduce(
            (acc, r) => {
                acc.inputTokens += r.usage.inputTokens
                acc.outputTokens += r.usage.outputTokens
                acc.eventCount += r.usage.eventCount
                if (r.usage.costUsd !== null)
                    acc.costUsd = (acc.costUsd ?? 0) + r.usage.costUsd
                return acc
            },
            {
                inputTokens: 0,
                outputTokens: 0,
                eventCount: 0,
                costUsd: null as number | null
            }
        )
    }, [filteredRows])

    const filtersActive =
        sourceFilter !== 'all' || hideUnused || ownerFilter !== ''

    return (
        <div className='mx-auto max-w-none'>
            <div className='mb-3'>
                <Heading level={2} className='mb-2'>
                    Model providers
                </Heading>
                <p className='admin-page-description max-w-2xl'>
                    Every user-configured model provider, with consumption stats
                    over the selected window. Stats are attributed via the
                    provider that was bound to the agent when each chat event
                    fired.
                </p>
            </div>

            <div className='mb-3 flex flex-wrap items-center gap-x-3 gap-y-2'>
                <div className='flex flex-wrap items-center gap-2'>
                    <span className='text-caption-sm text-label'>Window:</span>
                    {WINDOW_OPTIONS.map((w) => {
                        const active = windowKey === w.key
                        return (
                            <button
                                key={w.key}
                                type='button'
                                onClick={(): void => setWindowKey(w.key)}
                                className={`text-caption-sm rounded-full border px-2.5 py-0.5 whitespace-nowrap transition-colors ${
                                    active
                                        ? 'border-brand bg-brand-subtle text-brand'
                                        : 'border-border text-body hover:border-brand/40'
                                }`}
                            >
                                {w.label}
                            </button>
                        )
                    })}
                </div>
                <div className='flex flex-wrap items-center gap-2'>
                    <span className='text-caption-sm text-label'>Source:</span>
                    {(['all', 'byo', 'managed'] as const).map((s) => {
                        const active = sourceFilter === s
                        return (
                            <button
                                key={s}
                                type='button'
                                onClick={(): void => setSourceFilter(s)}
                                className={`text-caption-sm rounded-full border px-2.5 py-0.5 whitespace-nowrap transition-colors ${
                                    active
                                        ? 'border-brand bg-brand-subtle text-brand'
                                        : 'border-border text-body hover:border-brand/40'
                                }`}
                            >
                                {s}
                            </button>
                        )
                    })}
                </div>
                <div className='flex items-center gap-2'>
                    <label
                        htmlFor='provider-owner-filter'
                        className='text-caption-sm text-label'
                    >
                        Owner:
                    </label>
                    <select
                        id='provider-owner-filter'
                        className='border-border text-caption text-heading focus:border-brand focus:ring-brand h-8 rounded border bg-white px-2 transition-colors focus:ring-1 focus:outline-none'
                        value={ownerFilter}
                        onChange={(e): void => setOwnerFilter(e.target.value)}
                    >
                        <option value=''>All</option>
                        {ownerOptions.map((o) => (
                            <option key={o.id} value={o.id}>
                                {o.label}
                            </option>
                        ))}
                    </select>
                </div>
                <label className='text-caption-sm text-label inline-flex items-center gap-1'>
                    <input
                        type='checkbox'
                        checked={hideUnused}
                        onChange={(e): void => setHideUnused(e.target.checked)}
                    />
                    Hide unused
                </label>
                {filtersActive && (
                    <Button
                        variant='ghost'
                        size='sm'
                        onClick={(): void => {
                            setSourceFilter('all')
                            setHideUnused(false)
                            setOwnerFilter('')
                        }}
                    >
                        Clear filters
                    </Button>
                )}
            </div>

            {error && (
                <Card
                    elevation='flat'
                    className='border-accent-ruby/30 bg-accent-ruby/5 mb-2 p-2'
                >
                    <pre className='text-caption-sm text-accent-ruby whitespace-pre-wrap'>
                        {error}
                    </pre>
                </Card>
            )}

            {rows === null && !error && (
                <p className='text-caption text-body'>Loading…</p>
            )}

            {rows && rows.length === 0 && (
                <div className='border-border-dashed rounded-lg border border-dashed bg-white p-4 text-center'>
                    <p className='admin-page-description'>
                        No user_model_providers configured yet.
                    </p>
                </div>
            )}

            {rows && rows.length > 0 && (
                <>
                    {totals && (
                        <Card elevation='ambient' className='mb-3'>
                            <div className='grid grid-cols-2 gap-3 p-2 sm:grid-cols-4'>
                                <div>
                                    <p className='text-caption-sm text-body'>
                                        Input tokens
                                    </p>
                                    <p className='text-h3 text-heading tnum font-light'>
                                        {formatNumber(totals.inputTokens)}
                                    </p>
                                </div>
                                <div>
                                    <p className='text-caption-sm text-body'>
                                        Output tokens
                                    </p>
                                    <p className='text-h3 text-heading tnum font-light'>
                                        {formatNumber(totals.outputTokens)}
                                    </p>
                                </div>
                                <div>
                                    <p className='text-caption-sm text-body'>
                                        Cost (USD)
                                    </p>
                                    <p className='text-h3 text-heading tnum font-light'>
                                        {formatCost(totals.costUsd)}
                                    </p>
                                </div>
                                <div>
                                    <p className='text-caption-sm text-body'>
                                        Events
                                    </p>
                                    <p className='text-h3 text-heading tnum font-light'>
                                        {formatNumber(totals.eventCount)}
                                    </p>
                                </div>
                            </div>
                        </Card>
                    )}

                    {sortedRows.length === 0 ? (
                        <div className='border-border-dashed rounded-lg border border-dashed bg-white p-4 text-center'>
                            <p className='admin-page-description'>
                                No providers match the current filters.
                            </p>
                        </div>
                    ) : (
                        <Card elevation='ambient' className='overflow-hidden'>
                            <div className='overflow-x-auto'>
                                <table className='admin-table w-full min-w-[1200px] text-left'>
                                    <thead className='border-border bg-surface-subtle text-caption-sm text-body border-b'>
                                        <tr>
                                            <SortHeader
                                                sortKey='providerName'
                                                activeKey={sortKey}
                                                direction={direction}
                                                onToggle={toggle}
                                            >
                                                Provider
                                            </SortHeader>
                                            <SortHeader
                                                sortKey='owner'
                                                activeKey={sortKey}
                                                direction={direction}
                                                onToggle={toggle}
                                            >
                                                Owner
                                            </SortHeader>
                                            <SortHeader
                                                sortKey='source'
                                                activeKey={sortKey}
                                                direction={direction}
                                                onToggle={toggle}
                                            >
                                                Source
                                            </SortHeader>
                                            <SortHeader
                                                sortKey='agents'
                                                activeKey={sortKey}
                                                direction={direction}
                                                onToggle={toggle}
                                                align='right'
                                            >
                                                Agents
                                            </SortHeader>
                                            <SortHeader
                                                sortKey='cost'
                                                activeKey={sortKey}
                                                direction={direction}
                                                onToggle={toggle}
                                                align='right'
                                            >
                                                Cost
                                            </SortHeader>
                                            <SortHeader
                                                sortKey='inputTokens'
                                                activeKey={sortKey}
                                                direction={direction}
                                                onToggle={toggle}
                                                align='right'
                                            >
                                                Input
                                            </SortHeader>
                                            <SortHeader
                                                sortKey='outputTokens'
                                                activeKey={sortKey}
                                                direction={direction}
                                                onToggle={toggle}
                                                align='right'
                                            >
                                                Output
                                            </SortHeader>
                                            <SortHeader
                                                sortKey='events'
                                                activeKey={sortKey}
                                                direction={direction}
                                                onToggle={toggle}
                                                align='right'
                                            >
                                                Events
                                            </SortHeader>
                                            <SortHeader
                                                sortKey='lastUsedAt'
                                                activeKey={sortKey}
                                                direction={direction}
                                                onToggle={toggle}
                                            >
                                                Last used
                                            </SortHeader>
                                            <SortHeader
                                                sortKey='createdAt'
                                                activeKey={sortKey}
                                                direction={direction}
                                                onToggle={toggle}
                                            >
                                                Created
                                            </SortHeader>
                                        </tr>
                                    </thead>
                                    <tbody className='divide-border divide-y'>
                                        {sortedRows.map((r) => {
                                            const brand = brandLabel(r)
                                            return (
                                                <tr
                                                    key={r.id}
                                                    className='text-caption text-heading'
                                                >
                                                    <td className='px-2 py-1.5'>
                                                        <div className='text-heading'>
                                                            {providerDisplayName(
                                                                r
                                                            )}
                                                        </div>
                                                        <div className='text-caption-sm text-body mt-1 font-mono'>
                                                            {r.builtInId ??
                                                                r.id}
                                                            {brand && (
                                                                <span className='ml-2'>
                                                                    · {brand}
                                                                </span>
                                                            )}
                                                        </div>
                                                    </td>
                                                    <td className='px-2 py-1.5 font-mono'>
                                                        {r.userEmail ??
                                                            r.userId}
                                                    </td>
                                                    <td className='px-2 py-1.5'>
                                                        <Badge
                                                            tone={sourceTone(
                                                                r.source
                                                            )}
                                                        >
                                                            {r.source}
                                                        </Badge>
                                                    </td>
                                                    <td className='tnum px-2 py-1.5 text-right'>
                                                        {formatNumber(
                                                            r.boundAgentCount
                                                        )}
                                                    </td>
                                                    <td className='tnum px-2 py-1.5 text-right'>
                                                        {formatCost(
                                                            r.usage.costUsd
                                                        )}
                                                    </td>
                                                    <td className='tnum px-2 py-1.5 text-right'>
                                                        {formatNumber(
                                                            r.usage.inputTokens
                                                        )}
                                                    </td>
                                                    <td className='tnum px-2 py-1.5 text-right'>
                                                        {formatNumber(
                                                            r.usage.outputTokens
                                                        )}
                                                    </td>
                                                    <td className='tnum px-2 py-1.5 text-right'>
                                                        {formatNumber(
                                                            r.usage.eventCount
                                                        )}
                                                    </td>
                                                    <td className='tnum text-caption-sm text-body px-2 py-1.5'>
                                                        {r.usage.lastUsedAt
                                                            ? new Date(
                                                                  r.usage
                                                                      .lastUsedAt
                                                              ).toLocaleString(
                                                                  getLocale()
                                                              )
                                                            : '—'}
                                                    </td>
                                                    <td className='tnum text-caption-sm text-body px-2 py-1.5'>
                                                        {new Date(
                                                            r.createdAt
                                                        ).toLocaleString(
                                                            getLocale()
                                                        )}
                                                    </td>
                                                </tr>
                                            )
                                        })}
                                    </tbody>
                                </table>
                            </div>
                        </Card>
                    )}
                </>
            )}
        </div>
    )
}

export default ModelProvidersList
