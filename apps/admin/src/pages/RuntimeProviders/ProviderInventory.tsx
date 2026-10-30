import type {
    ProviderMachineList,
    ProviderMachineSummary,
    RuntimeHostPowerState,
    RuntimeProviderSummary
} from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { getLocale, t } from '@manyfold/i18n'
import { useApiClient } from '@/lib/apiClient'
import { powerLabel } from '@/lib/hostStatus'
import {
    filterMachines,
    machineErrorMessage,
    machinePowerTone,
    tallyMachines,
    type MachineFilters,
    type TrackingFilter
} from '@/lib/providerInventory'
import { useShellPolling } from '@/lib/useShellPolling'
import { useTableSort, type SortAccessors } from '@/lib/useTableSort'
import { adminRoutes } from '@/routes'
import {
    Badge,
    Button,
    Card,
    CardBody,
    DetailPage,
    Input,
    SortHeader
} from '@/ui'
import { RuntimeProviderHeader } from './RuntimeProviderHeader'

// The provider caches a listing for a few seconds; polling slower than that
// keeps one open page from re-listing the account on every tick.
const POLL_MS = 30_000

const selectClass =
    'border-border text-caption text-heading focus:border-brand focus:ring-brand block h-8 rounded border bg-white px-2 focus:ring-1 focus:outline-none'

type SortKey =
    | 'name'
    | 'status'
    | 'sandbox'
    | 'agents'
    | 'version'
    | 'lastRunning'
    | 'created'

const accessors: SortAccessors<ProviderMachineSummary, SortKey> = {
    name: (m) => m.name,
    status: (m) => m.power,
    sandbox: (m) => m.host?.name ?? null,
    agents: (m) => m.host?.agentsCount ?? null,
    version: (m) => m.version,
    lastRunning: (m) => m.lastRunningAt,
    created: (m) => m.createdAt
}

const when = (iso: string | null): string =>
    iso ? new Date(iso).toLocaleString(getLocale()) : '—'

const StatTile: FC<{ label: string; value: ReactNode; sub?: string }> = ({
    label,
    value,
    sub
}): ReactNode => (
    <Card elevation='ambient'>
        <CardBody>
            <p className='text-caption-sm text-body font-normal'>{label}</p>
            <p className='text-h3 text-heading tnum mt-1 font-light'>{value}</p>
            {sub && <p className='text-caption-sm text-body mt-1'>{sub}</p>}
        </CardBody>
    </Card>
)

const limitOf = (limit: number | null | undefined): string | undefined =>
    limit
        ? t('admin.runtimeProviders.inventory.tiles.ofLimit', { limit })
        : undefined

const ProviderInventory: FC = (): ReactNode => {
    const { id = '' } = useParams<{ id: string }>()
    const client = useApiClient()
    const [provider, setProvider] = useState<RuntimeProviderSummary | null>(
        null
    )
    const [list, setList] = useState<ProviderMachineList | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [refreshing, setRefreshing] = useState(false)
    const [filters, setFilters] = useState<MachineFilters>({
        search: '',
        tracking: 'all',
        power: 'all'
    })

    useEffect(() => {
        client.admin.runtimeProviders
            .get(id)
            .then(setProvider)
            .catch((e: unknown) => setError(machineErrorMessage(e)))
    }, [client, id])

    const load = useCallback(
        (refresh = false): Promise<void> =>
            client.admin.runtimeProviders.machines
                .list(id, { refresh })
                .then((next) => {
                    setList(next)
                    setError(null)
                })
                .catch((e: unknown) => setError(machineErrorMessage(e))),
        [client, id]
    )

    useShellPolling(load, POLL_MS)

    const refreshNow = async (): Promise<void> => {
        setRefreshing(true)
        await load(true)
        setRefreshing(false)
    }

    const machines = useMemo(
        () => (list ? filterMachines(list.machines, filters) : []),
        [list, filters]
    )
    const {
        sorted,
        sortKey: activeKey,
        direction,
        toggle
    } = useTableSort<ProviderMachineSummary, SortKey>(
        machines,
        accessors,
        'name',
        'asc'
    )
    const tally = list ? tallyMachines(list.machines) : null
    const sortProps = (key: SortKey) => ({
        sortKey: key,
        activeKey,
        direction,
        onToggle: toggle
    })

    return (
        <DetailPage>
            <RuntimeProviderHeader
                providerId={id}
                provider={provider}
                active='inventory'
            />
            <p className='admin-page-description mb-3 max-w-2xl'>
                {t('admin.runtimeProviders.inventory.subtitle')}
            </p>

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

            {list === null && !error && (
                <p className='text-caption text-body'>{t('common.loading')}</p>
            )}

            {list && tally && (
                <>
                    <Card elevation='flat' className='border-border mb-2 p-2'>
                        <p className='text-caption-sm text-body'>
                            {t('admin.runtimeProviders.inventory.sharedNotice')}
                        </p>
                        {list.sharedWith.length > 0 && (
                            <p className='text-caption-sm text-body mt-1'>
                                {t(
                                    'admin.runtimeProviders.inventory.sharedWith',
                                    {
                                        providers: list.sharedWith
                                            .map((row) => row.name)
                                            .join(', ')
                                    }
                                )}
                            </p>
                        )}
                        {!list.complete && (
                            <p className='text-caption-sm text-accent-lemon mt-1'>
                                {t(
                                    'admin.runtimeProviders.inventory.incomplete'
                                )}
                            </p>
                        )}
                    </Card>

                    <div className='mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4'>
                        <StatTile
                            label={t(
                                'admin.runtimeProviders.inventory.tiles.total'
                            )}
                            value={tally.total}
                            sub={t(
                                'admin.runtimeProviders.inventory.tiles.split',
                                {
                                    tracked: tally.tracked,
                                    untracked: tally.untracked
                                }
                            )}
                        />
                        <StatTile
                            label={powerLabel('running')}
                            value={list.capacity?.running ?? '—'}
                            sub={limitOf(list.capacity?.runningLimit)}
                        />
                        <StatTile
                            label={powerLabel('suspended')}
                            value={list.capacity?.suspended ?? '—'}
                            sub={limitOf(list.capacity?.suspendedLimit)}
                        />
                        <StatTile
                            label={powerLabel('stopped')}
                            value={list.capacity?.stopped ?? '—'}
                        />
                    </div>

                    <div className='mb-2 flex flex-wrap items-end gap-2'>
                        <div className='w-72'>
                            <Input
                                id='inventory-search'
                                label={t(
                                    'admin.runtimeProviders.inventory.filters.search'
                                )}
                                placeholder={t(
                                    'admin.runtimeProviders.inventory.filters.searchPlaceholder'
                                )}
                                value={filters.search}
                                onChange={(event): void =>
                                    setFilters({
                                        ...filters,
                                        search: event.target.value
                                    })
                                }
                            />
                        </div>
                        <label className='text-caption text-label block'>
                            {t(
                                'admin.runtimeProviders.inventory.filters.tracking'
                            )}
                            <select
                                className={`${selectClass} mt-1`}
                                value={filters.tracking}
                                onChange={(event): void =>
                                    setFilters({
                                        ...filters,
                                        tracking: event.target
                                            .value as TrackingFilter
                                    })
                                }
                            >
                                <option value='all'>
                                    {t(
                                        'admin.runtimeProviders.inventory.filters.all'
                                    )}
                                </option>
                                <option value='tracked'>
                                    {t(
                                        'admin.runtimeProviders.inventory.tracked'
                                    )}
                                </option>
                                <option value='untracked'>
                                    {t(
                                        'admin.runtimeProviders.inventory.untracked'
                                    )}
                                </option>
                            </select>
                        </label>
                        <label className='text-caption text-label block'>
                            {t(
                                'admin.runtimeProviders.inventory.filters.power'
                            )}
                            <select
                                className={`${selectClass} mt-1`}
                                value={filters.power}
                                onChange={(event): void =>
                                    setFilters({
                                        ...filters,
                                        power: event.target.value as
                                            | RuntimeHostPowerState
                                            | 'all'
                                    })
                                }
                            >
                                <option value='all'>
                                    {t(
                                        'admin.runtimeProviders.inventory.filters.all'
                                    )}
                                </option>
                                {(
                                    ['running', 'suspended', 'stopped'] as const
                                ).map((power) => (
                                    <option key={power} value={power}>
                                        {powerLabel(power)}
                                    </option>
                                ))}
                            </select>
                        </label>
                        <div className='ml-auto flex items-center gap-2'>
                            <span className='text-caption-sm text-body tnum'>
                                {t(
                                    'admin.runtimeProviders.inventory.listedAt',
                                    {
                                        time: when(list.listedAt)
                                    }
                                )}
                            </span>
                            <Button
                                variant='ghost'
                                disabled={refreshing}
                                onClick={(): void => {
                                    void refreshNow()
                                }}
                            >
                                {t('admin.runtimeProviders.inventory.refresh')}
                            </Button>
                        </div>
                    </div>

                    {list.machines.length === 0 ? (
                        <div className='border-border-dashed rounded-lg border border-dashed bg-white p-4 text-center'>
                            <p className='admin-page-description'>
                                {t('admin.runtimeProviders.inventory.empty')}
                            </p>
                        </div>
                    ) : (
                        <Card elevation='ambient' className='overflow-hidden'>
                            <div className='overflow-x-auto'>
                                <table className='admin-table w-full min-w-[960px] text-left'>
                                    <thead className='border-border bg-surface-subtle text-caption-sm text-body border-b'>
                                        <tr>
                                            <SortHeader {...sortProps('name')}>
                                                {t(
                                                    'admin.runtimeProviders.inventory.cols.name'
                                                )}
                                            </SortHeader>
                                            <SortHeader
                                                {...sortProps('status')}
                                            >
                                                {t(
                                                    'admin.runtimeProviders.inventory.cols.status'
                                                )}
                                            </SortHeader>
                                            <SortHeader
                                                {...sortProps('sandbox')}
                                            >
                                                {t(
                                                    'admin.runtimeProviders.inventory.cols.sandbox'
                                                )}
                                            </SortHeader>
                                            <SortHeader
                                                {...sortProps('agents')}
                                                align='right'
                                            >
                                                {t(
                                                    'admin.runtimeProviders.inventory.cols.agents'
                                                )}
                                            </SortHeader>
                                            <SortHeader
                                                {...sortProps('version')}
                                            >
                                                {t(
                                                    'admin.runtimeProviders.inventory.cols.version'
                                                )}
                                            </SortHeader>
                                            <SortHeader
                                                {...sortProps('lastRunning')}
                                            >
                                                {t(
                                                    'admin.runtimeProviders.inventory.cols.lastRunning'
                                                )}
                                            </SortHeader>
                                            <SortHeader
                                                {...sortProps('created')}
                                            >
                                                {t(
                                                    'admin.runtimeProviders.inventory.cols.created'
                                                )}
                                            </SortHeader>
                                        </tr>
                                    </thead>
                                    <tbody className='divide-border divide-y'>
                                        {sorted.map((m) => (
                                            <tr
                                                key={m.name}
                                                className='text-caption text-heading hover:bg-surface-muted transition-colors'
                                            >
                                                <td className='px-2 py-1.5'>
                                                    <Link
                                                        to={adminRoutes.runtimeProviderMachine(
                                                            id,
                                                            m.name
                                                        )}
                                                        className='text-brand hover:text-brand-hover font-mono'
                                                    >
                                                        {m.name}
                                                    </Link>
                                                    {m.id && (
                                                        <div className='text-caption-sm text-body mt-1 font-mono'>
                                                            {m.id}
                                                        </div>
                                                    )}
                                                </td>
                                                <td className='px-2 py-1.5'>
                                                    <Badge
                                                        tone={machinePowerTone(
                                                            m.power
                                                        )}
                                                    >
                                                        <span title={m.status}>
                                                            {powerLabel(
                                                                m.power
                                                            )}
                                                        </span>
                                                    </Badge>
                                                </td>
                                                <td className='px-2 py-1.5'>
                                                    {m.host ? (
                                                        <>
                                                            {m.host.name}
                                                            <div className='text-caption-sm text-body mt-1 font-mono'>
                                                                {m.host
                                                                    .ownerEmail ??
                                                                    m.host
                                                                        .userId}
                                                            </div>
                                                        </>
                                                    ) : (
                                                        <Badge tone='neutral'>
                                                            {t(
                                                                'admin.runtimeProviders.inventory.untracked'
                                                            )}
                                                        </Badge>
                                                    )}
                                                </td>
                                                <td className='tnum px-2 py-1.5 text-right'>
                                                    {m.host
                                                        ? m.host.agentsCount
                                                        : '—'}
                                                </td>
                                                <td className='px-2 py-1.5 font-mono'>
                                                    {m.version ?? '—'}
                                                </td>
                                                <td className='tnum px-2 py-1.5'>
                                                    {when(m.lastRunningAt)}
                                                </td>
                                                <td className='tnum px-2 py-1.5'>
                                                    {when(m.createdAt)}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                            {sorted.length === 0 && (
                                <p className='text-caption text-body p-2'>
                                    {t(
                                        'admin.runtimeProviders.inventory.noMatches'
                                    )}
                                </p>
                            )}
                        </Card>
                    )}
                </>
            )}
        </DetailPage>
    )
}

export default ProviderInventory
