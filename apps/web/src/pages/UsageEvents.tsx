import type {
    AgentFramework,
    AgentSummary,
    UsageEventSummary
} from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useApiClient } from '@/lib/apiClient'
import { apiErrorMessage } from '@/lib/errorMessage'
import { frameworkLabel } from '@/lib/frameworkMeta'
import { daysAgoIso, fmt } from '@/lib/usageFormat'
import { Spinner } from '@/components/Loading'
import SettingsPageHeader from '@/components/SettingsPageHeader'
import UsageEventsTable from '@/components/UsageEventsTable'
import WorkbenchSelect from '@/components/WorkbenchSelect'
import { useI18n, type TFn } from '@/lib/i18n'

type RangePreset = '7d' | '30d' | '90d' | 'custom'

const RANGE_PRESETS: { value: RangePreset; days?: number }[] = [
    { value: '7d', days: 7 },
    { value: '30d', days: 30 },
    { value: '90d', days: 90 },
    { value: 'custom' }
]

const rangePresetLabel = (range: RangePreset, t: TFn): string => {
    switch (range) {
        case '7d':
            return t('web.usage.range7Days')
        case '30d':
            return t('web.usage.range30Days')
        case '90d':
            return t('web.usage.range90Days')
        case 'custom':
            return t('web.usage.rangeCustom')
    }
}

const FRAMEWORKS: AgentFramework[] = [
    'claude-code',
    'codex',
    'gemini-cli',
    'openclaw',
    'hermes'
]

const PAGE_SIZE = 50

const isoToLocalInput = (iso: string | null): string => {
    if (!iso) return ''
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return ''
    const pad = (n: number): string => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const localInputToIso = (value: string): string | null => {
    if (!value) return null
    const d = new Date(value)
    return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

const UsageEvents: FC = (): ReactNode => {
    const client = useApiClient()
    const { t } = useI18n()
    const [searchParams, setSearchParams] = useSearchParams()

    const qAgentId = searchParams.get('agentId') ?? ''
    const qFramework = searchParams.get('framework') ?? ''
    const qFrom = searchParams.get('from')
    const qTo = searchParams.get('to')
    const qPreset = (searchParams.get('range') as RangePreset | null) ?? null

    const rangePreset: RangePreset = useMemo(() => {
        if (qPreset && RANGE_PRESETS.some((r) => r.value === qPreset))
            return qPreset
        if (qFrom || qTo) return 'custom'
        return '30d'
    }, [qPreset, qFrom, qTo])

    const effectiveFrom = useMemo(() => {
        if (rangePreset === 'custom') return qFrom
        const preset = RANGE_PRESETS.find((r) => r.value === rangePreset)
        return preset?.days ? daysAgoIso(preset.days - 1) : null
    }, [rangePreset, qFrom])

    const effectiveTo = useMemo(
        () => (rangePreset === 'custom' ? qTo : null),
        [rangePreset, qTo]
    )

    const [agents, setAgents] = useState<AgentSummary[]>([])
    const [items, setItems] = useState<UsageEventSummary[]>([])
    const [nextCursor, setNextCursor] = useState<string | null>(null)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        client.agents
            .list()
            .then((rows) => setAgents(rows as AgentSummary[]))
            .catch(() => {
                // best-effort — agent filter will just be empty
            })
    }, [client])

    const fetchPage = useCallback(
        async (opts: { append: boolean; cursor: string | null }) => {
            setLoading(true)
            setError(null)
            try {
                const page = await client.usage.events({
                    limit: PAGE_SIZE,
                    cursor: opts.cursor ?? undefined,
                    ...(effectiveFrom ? { from: effectiveFrom } : {}),
                    ...(effectiveTo ? { to: effectiveTo } : {}),
                    ...(qAgentId ? { agentId: qAgentId } : {}),
                    ...(qFramework
                        ? { framework: qFramework as AgentFramework }
                        : {})
                })
                setItems((prev) =>
                    opts.append ? [...prev, ...page.items] : page.items
                )
                setNextCursor(page.nextCursor)
            } catch (err) {
                setError(apiErrorMessage(err))
            } finally {
                setLoading(false)
            }
        },
        [client, effectiveFrom, effectiveTo, qAgentId, qFramework]
    )

    useEffect(() => {
        void fetchPage({ append: false, cursor: null })
    }, [fetchPage])

    const updateParams = (
        updater: (p: URLSearchParams) => URLSearchParams
    ): void => {
        setSearchParams(updater(new URLSearchParams(searchParams)), {
            replace: true
        })
    }

    const onRangeChange = (value: RangePreset): void => {
        updateParams((p) => {
            if (value === 'custom') {
                p.set('range', 'custom')
            } else {
                p.set('range', value)
                p.delete('from')
                p.delete('to')
            }
            return p
        })
    }

    const onCustomFromChange = (v: string): void => {
        updateParams((p) => {
            const iso = localInputToIso(v)
            if (iso) p.set('from', iso)
            else p.delete('from')
            p.set('range', 'custom')
            return p
        })
    }

    const onCustomToChange = (v: string): void => {
        updateParams((p) => {
            const iso = localInputToIso(v)
            if (iso) p.set('to', iso)
            else p.delete('to')
            p.set('range', 'custom')
            return p
        })
    }

    const onAgentChange = (v: string): void => {
        updateParams((p) => {
            if (v) p.set('agentId', v)
            else p.delete('agentId')
            return p
        })
    }

    const onFrameworkChange = (v: string): void => {
        updateParams((p) => {
            if (v) p.set('framework', v)
            else p.delete('framework')
            return p
        })
    }

    const filtersActive =
        qAgentId !== '' || qFramework !== '' || rangePreset !== '30d'

    const clearFilters = (): void => {
        setSearchParams(new URLSearchParams(), { replace: true })
    }

    const onLoadMore = (): void => {
        if (!nextCursor) return
        void fetchPage({ append: true, cursor: nextCursor })
    }

    const resolveAgentName = (agentId: string | null): string =>
        agents.find((a) => a.id === agentId)?.name ??
        (agentId ? agentId.slice(0, 8) : '—')

    return (
        <div className='settings-page'>
            <SettingsPageHeader
                breadcrumb={[
                    { label: t('web.usage.title'), to: '/settings/usage' },
                    { label: t('web.usage.events') }
                ]}
                title={t('web.usage.events')}
                actions={
                    <div className='text-caption text-muted flex items-center gap-3'>
                        {items.length > 0 && (
                            <span className='tabular-nums'>
                                {t(
                                    items.length === 1
                                        ? 'web.usage.eventsLoadedOne'
                                        : 'web.usage.eventsLoadedMany',
                                    { count: fmt(items.length) }
                                )}
                            </span>
                        )}
                        {filtersActive && (
                            <button
                                type='button'
                                onClick={clearFilters}
                                className='text-link hover:underline'
                            >
                                {t('web.usage.clearFilters')}
                            </button>
                        )}
                    </div>
                }
            />

            <div className='workbench-panel mb-6 p-6'>
                <div className='flex flex-wrap items-end gap-6'>
                    <div>
                        <div className='workbench-field-label mb-2'>
                            {t('web.usage.range')}
                        </div>
                        <div className='flex flex-wrap gap-2'>
                            {RANGE_PRESETS.map((p) => {
                                const active = p.value === rangePreset
                                return (
                                    <button
                                        key={p.value}
                                        type='button'
                                        onClick={() => onRangeChange(p.value)}
                                        className={[
                                            'rounded-pill text-ui px-3 py-1.5 transition-colors',
                                            active
                                                ? 'bg-strong text-strong-fg'
                                                : 'bg-surface-subtle text-muted shadow-ring-light hover:text-fg'
                                        ].join(' ')}
                                    >
                                        {rangePresetLabel(p.value, t)}
                                    </button>
                                )
                            })}
                        </div>
                    </div>

                    {rangePreset === 'custom' && (
                        <>
                            <div>
                                <label
                                    htmlFor='from'
                                    className='workbench-field-label'
                                >
                                    {t('web.usage.from')}
                                </label>
                                <input
                                    id='from'
                                    type='datetime-local'
                                    value={isoToLocalInput(qFrom)}
                                    onChange={(e) =>
                                        onCustomFromChange(e.target.value)
                                    }
                                    className='workbench-input'
                                />
                            </div>
                            <div>
                                <label
                                    htmlFor='to'
                                    className='workbench-field-label'
                                >
                                    {t('web.usage.to')}
                                </label>
                                <input
                                    id='to'
                                    type='datetime-local'
                                    value={isoToLocalInput(qTo)}
                                    onChange={(e) =>
                                        onCustomToChange(e.target.value)
                                    }
                                    className='workbench-input'
                                />
                            </div>
                        </>
                    )}

                    <div>
                        <label
                            htmlFor='agent'
                            className='workbench-field-label'
                        >
                            {t('web.usage.agent')}
                        </label>
                        <WorkbenchSelect
                            id='agent'
                            value={qAgentId}
                            onChange={onAgentChange}
                            options={[
                                {
                                    value: '',
                                    label: t('web.usage.allAgents')
                                },
                                ...agents.map((a) => ({
                                    value: a.id,
                                    label: a.name
                                }))
                            ]}
                        />
                    </div>

                    <div>
                        <label
                            htmlFor='framework'
                            className='workbench-field-label'
                        >
                            {t('web.usage.framework')}
                        </label>
                        <WorkbenchSelect
                            id='framework'
                            value={qFramework}
                            onChange={onFrameworkChange}
                            options={[
                                {
                                    value: '',
                                    label: t('web.usage.allFrameworks')
                                },
                                ...FRAMEWORKS.map((f) => ({
                                    value: f,
                                    label: frameworkLabel(f)
                                }))
                            ]}
                        />
                    </div>
                </div>
            </div>

            {error && <div className='workbench-alert-error mb-6'>{error}</div>}

            <UsageEventsTable
                items={items}
                resolveAgentName={resolveAgentName}
                loading={loading}
                error={error}
            />

            {nextCursor && (
                <div className='mt-6 flex justify-center'>
                    <button
                        type='button'
                        onClick={onLoadMore}
                        disabled={loading}
                        aria-busy={loading}
                        className='workbench-button-primary h-10 px-4'
                    >
                        {loading ? (
                            <>
                                <Spinner size={16} className='mr-2' />
                                {t('web.usage.loadingMore')}
                            </>
                        ) : (
                            t('web.usage.loadMore')
                        )}
                    </button>
                </div>
            )}
        </div>
    )
}

export default UsageEvents
