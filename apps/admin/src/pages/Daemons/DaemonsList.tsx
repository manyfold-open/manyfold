import type {
    AdminDaemonHostSummary,
    DetectedFramework
} from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useApiClient } from '@/lib/apiClient'
import { useShellPolling } from '@/lib/useShellPolling'
import { useTableSort, type SortAccessors } from '@/lib/useTableSort'
import { Badge, Button, Card, Heading, SortHeader, type BadgeTone } from '@/ui'

type DaemonsSortKey = 'name' | 'owner' | 'status' | 'lastSeenAt' | 'createdAt'

const sortAccessors: SortAccessors<AdminDaemonHostSummary, DaemonsSortKey> = {
    name: (r) => r.name,
    owner: (r) => r.userEmail ?? r.userId,
    status: (r) => (r.online ? 'online' : r.status),
    lastSeenAt: (r) => r.lastSeenAt,
    createdAt: (r) => r.createdAt
}

const statusTone = (online: boolean): BadgeTone =>
    online ? 'success' : 'neutral'

const REFRESH_INTERVAL_MS = 30_000

type OnlineFilter = 'all' | 'online' | 'offline'

const DaemonsList: FC = (): ReactNode => {
    const client = useApiClient()
    const [rows, setRows] = useState<AdminDaemonHostSummary[] | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [busyId, setBusyId] = useState<string | null>(null)
    const [deleteTarget, setDeleteTarget] =
        useState<AdminDaemonHostSummary | null>(null)
    const [deleteName, setDeleteName] = useState('')
    const [ownerFilter, setOwnerFilter] = useState<string>('')
    const [frameworkFilter, setFrameworkFilter] = useState<
        Set<DetectedFramework['framework']>
    >(new Set())
    const [onlineFilter, setOnlineFilter] = useState<OnlineFilter>('all')

    const refresh = useCallback(
        (): Promise<void> =>
            client.admin.daemons
                .listHosts()
                .then(setRows)
                .catch((e: Error) => setError(e.message)),
        [client]
    )

    const refreshNow = useShellPolling(refresh, REFRESH_INTERVAL_MS)

    useEffect(() => {
        if (!deleteTarget) return
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key === 'Escape' && busyId !== deleteTarget.id) {
                setDeleteTarget(null)
                setDeleteName('')
            }
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
    }, [busyId, deleteTarget])

    const upgradeHost = async (r: AdminDaemonHostSummary): Promise<void> => {
        if (
            !window.confirm(
                `Upgrade ${r.name} to mf ${r.latestCliVersion ?? 'latest'} and restart the daemon? Agents running on this machine will be stopped briefly.`
            )
        )
            return
        setBusyId(r.id)
        setError(null)
        try {
            const res = await client.admin.daemons.upgradeHost(r.id)
            if (res.deferred)
                window.alert(
                    `${r.name} has ${res.activeSessions ?? 'running'} active session(s); the upgrade applies automatically once they end. New sessions are paused until the daemon restarts.`
                )
            refreshNow()
        } catch (e) {
            setError((e as Error).message)
        } finally {
            setBusyId(null)
        }
    }

    const deleteHost = async (): Promise<void> => {
        if (!deleteTarget || deleteName !== deleteTarget.name) return
        setBusyId(deleteTarget.id)
        setError(null)
        try {
            await client.admin.daemons.deleteHost(deleteTarget.id)
            setDeleteTarget(null)
            setDeleteName('')
            refreshNow()
        } catch (e) {
            setError((e as Error).message)
        } finally {
            setBusyId(null)
        }
    }

    const ownerOptions = useMemo(() => {
        if (!rows) return [] as Array<{ id: string; label: string }>
        const seen = new Set<string>()
        const options: Array<{ id: string; label: string }> = []
        for (const r of rows) {
            if (seen.has(r.userId)) continue
            seen.add(r.userId)
            options.push({
                id: r.userId,
                label: r.userEmail ?? r.userId
            })
        }
        return options.sort((a, b) => a.label.localeCompare(b.label))
    }, [rows])

    const frameworkOptions = useMemo(() => {
        if (!rows) return [] as Array<DetectedFramework['framework']>
        const seen = new Set<DetectedFramework['framework']>()
        for (const r of rows)
            for (const f of r.detectedFrameworks) seen.add(f.framework)
        return [...seen].sort()
    }, [rows])

    const filteredRows = useMemo(() => {
        if (!rows) return [] as AdminDaemonHostSummary[]
        return rows.filter((r) => {
            if (ownerFilter && r.userId !== ownerFilter) return false
            if (onlineFilter === 'online' && !r.online) return false
            if (onlineFilter === 'offline' && r.online) return false
            if (frameworkFilter.size > 0) {
                const has = r.detectedFrameworks.some((f) =>
                    frameworkFilter.has(f.framework)
                )
                if (!has) return false
            }
            return true
        })
    }, [rows, ownerFilter, onlineFilter, frameworkFilter])

    const {
        sorted: sortedRows,
        sortKey,
        direction,
        toggle
    } = useTableSort<AdminDaemonHostSummary, DaemonsSortKey>(
        filteredRows,
        sortAccessors,
        'lastSeenAt',
        'desc'
    )

    const toggleFramework = (fw: DetectedFramework['framework']): void => {
        setFrameworkFilter((s) => {
            const next = new Set(s)
            if (next.has(fw)) next.delete(fw)
            else next.add(fw)
            return next
        })
    }

    const filtersActive =
        ownerFilter !== '' || frameworkFilter.size > 0 || onlineFilter !== 'all'

    return (
        <div className='space-y-2'>
            <Heading level={2}>Self-owned computers</Heading>
            <p className='text-caption text-body'>
                All machines users have registered through the local NCA daemon.
            </p>

            {error && (
                <Card elevation='ambient' className='border-accent-ruby/30'>
                    <pre className='text-accent-ruby text-caption-sm p-2'>
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
                        No self-owned computers have been registered yet.
                    </p>
                </div>
            )}

            {rows && rows.length > 0 && (
                <>
                    <div className='flex flex-wrap items-center gap-x-3 gap-y-2'>
                        <div className='flex items-center gap-2'>
                            <label
                                htmlFor='daemon-owner-filter'
                                className='text-caption-sm text-label'
                            >
                                Owner:
                            </label>
                            <select
                                id='daemon-owner-filter'
                                className='border-border text-caption text-heading focus:border-brand focus:ring-brand h-8 rounded border bg-white px-2 transition-colors focus:outline-none focus:ring-1'
                                value={ownerFilter}
                                onChange={(e): void =>
                                    setOwnerFilter(e.target.value)
                                }
                            >
                                <option value=''>All</option>
                                {ownerOptions.map((o) => (
                                    <option key={o.id} value={o.id}>
                                        {o.label}
                                    </option>
                                ))}
                            </select>
                        </div>
                        <div className='flex flex-wrap items-center gap-2'>
                            <span className='text-caption-sm text-label'>
                                Framework:
                            </span>
                            {frameworkOptions.map((fw) => {
                                const active = frameworkFilter.has(fw)
                                return (
                                    <button
                                        key={fw}
                                        type='button'
                                        onClick={(): void =>
                                            toggleFramework(fw)
                                        }
                                        className={`text-caption-sm whitespace-nowrap rounded-full border px-2.5 py-0.5 transition-colors ${
                                            active
                                                ? 'border-brand bg-brand-subtle text-brand'
                                                : 'border-border text-body hover:border-brand/40'
                                        }`}
                                    >
                                        {fw}
                                    </button>
                                )
                            })}
                        </div>
                        <div className='flex flex-wrap items-center gap-2'>
                            <span className='text-caption-sm text-label'>
                                Status:
                            </span>
                            {(
                                ['all', 'online', 'offline'] as OnlineFilter[]
                            ).map((s) => {
                                const active = onlineFilter === s
                                return (
                                    <button
                                        key={s}
                                        type='button'
                                        onClick={(): void => setOnlineFilter(s)}
                                        className={`text-caption-sm whitespace-nowrap rounded-full border px-2.5 py-0.5 transition-colors ${
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
                        {filtersActive && (
                            <Button
                                variant='ghost'
                                size='sm'
                                onClick={(): void => {
                                    setOwnerFilter('')
                                    setFrameworkFilter(new Set())
                                    setOnlineFilter('all')
                                }}
                            >
                                Clear filters
                            </Button>
                        )}
                    </div>

                    <Card elevation='ambient' className='overflow-hidden'>
                        <div className='overflow-x-auto'>
                            <table className='admin-table w-full min-w-[1100px] text-left'>
                                <thead className='border-border bg-surface-subtle text-caption-sm text-body border-b'>
                                    <tr>
                                        <SortHeader
                                            sortKey='name'
                                            activeKey={sortKey}
                                            direction={direction}
                                            onToggle={toggle}
                                        >
                                            Machine
                                        </SortHeader>
                                        <SortHeader
                                            sortKey='owner'
                                            activeKey={sortKey}
                                            direction={direction}
                                            onToggle={toggle}
                                        >
                                            Owner
                                        </SortHeader>
                                        <th className='px-2 py-1.5 font-normal'>
                                            OS / arch
                                        </th>
                                        <th className='px-2 py-1.5 font-normal'>
                                            NCA version
                                        </th>
                                        <th className='px-2 py-1.5 font-normal'>
                                            Frameworks
                                        </th>
                                        <th className='px-2 py-1.5 font-normal'>
                                            Runtimes
                                        </th>
                                        <th className='px-2 py-1.5 font-normal'>
                                            Tokens
                                        </th>
                                        <SortHeader
                                            sortKey='status'
                                            activeKey={sortKey}
                                            direction={direction}
                                            onToggle={toggle}
                                        >
                                            Status
                                        </SortHeader>
                                        <SortHeader
                                            sortKey='lastSeenAt'
                                            activeKey={sortKey}
                                            direction={direction}
                                            onToggle={toggle}
                                        >
                                            Last seen
                                        </SortHeader>
                                        <SortHeader
                                            sortKey='createdAt'
                                            activeKey={sortKey}
                                            direction={direction}
                                            onToggle={toggle}
                                        >
                                            Created
                                        </SortHeader>
                                        <th className='px-2 py-1.5 font-normal'>
                                            Actions
                                        </th>
                                    </tr>
                                </thead>
                                <tbody className='divide-border divide-y'>
                                    {sortedRows.map((r) => (
                                        <tr
                                            key={r.id}
                                            className='text-caption text-heading'
                                        >
                                            <td className='px-2 py-1.5'>
                                                {r.name}
                                                <div className='text-caption-sm text-body mt-1 font-mono'>
                                                    {r.id}
                                                </div>
                                            </td>
                                            <td className='px-2 py-1.5 font-mono'>
                                                {r.userEmail ?? r.userId}
                                            </td>
                                            <td className='px-2 py-1.5'>
                                                {r.os ?? '—'} / {r.arch ?? '—'}
                                            </td>
                                            <td className='px-2 py-1.5 font-mono'>
                                                {r.cliVersion ?? '—'}
                                                {r.updateAvailable &&
                                                    r.latestCliVersion &&
                                                    (r.canRemoteUpgrade ? (
                                                        <Button
                                                            variant='ghost'
                                                            size='sm'
                                                            disabled={
                                                                busyId === r.id
                                                            }
                                                            onClick={(): void => {
                                                                void upgradeHost(
                                                                    r
                                                                )
                                                            }}
                                                            className='ml-2'
                                                        >
                                                            ↑{' '}
                                                            {r.latestCliVersion}
                                                        </Button>
                                                    ) : (
                                                        <span
                                                            className='text-body ml-2'
                                                            title='Remote upgrade needs the daemon online, autostart-managed, and on a recent CLI.'
                                                        >
                                                            →{' '}
                                                            {r.latestCliVersion}
                                                        </span>
                                                    ))}
                                            </td>
                                            <td className='px-2 py-1.5'>
                                                {r.detectedFrameworks
                                                    .map(
                                                        (f) =>
                                                            `${f.framework}${f.version ? ` ${f.version}` : ''}`
                                                    )
                                                    .join(', ') || '—'}
                                            </td>
                                            <td className='px-2 py-1.5'>
                                                {r.runtimes.length}
                                            </td>
                                            <td className='px-2 py-1.5'>
                                                {r.tokenCount}
                                            </td>
                                            <td className='px-2 py-1.5'>
                                                <Badge
                                                    tone={statusTone(r.online)}
                                                >
                                                    {r.online
                                                        ? 'online'
                                                        : r.status}
                                                </Badge>
                                            </td>
                                            <td className='text-caption-sm text-body px-2 py-1.5'>
                                                {r.lastSeenAt
                                                    ? new Date(
                                                          r.lastSeenAt
                                                      ).toLocaleString()
                                                    : '—'}
                                            </td>
                                            <td className='text-caption-sm text-body px-2 py-1.5'>
                                                {new Date(
                                                    r.createdAt
                                                ).toLocaleString()}
                                            </td>
                                            <td className='px-2 py-1.5'>
                                                {r.status === 'revoked' && (
                                                    <Button
                                                        variant='neutral'
                                                        size='sm'
                                                        disabled={
                                                            busyId === r.id
                                                        }
                                                        className='!border-accent-ruby !text-accent-ruby hover:!bg-accent-ruby/5'
                                                        onClick={(): void => {
                                                            setDeleteTarget(r)
                                                            setDeleteName('')
                                                        }}
                                                    >
                                                        Delete
                                                    </Button>
                                                )}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </Card>
                </>
            )}

            {deleteTarget && (
                <div className='fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4'>
                    <div
                        role='dialog'
                        aria-modal='true'
                        aria-labelledby='delete-machine-title'
                        className='border-border shadow-deep w-full max-w-md rounded-lg border bg-white p-4'
                    >
                        <Heading
                            id='delete-machine-title'
                            level={3}
                            className='mb-2'
                        >
                            Delete machine
                        </Heading>
                        <p className='text-caption text-body'>
                            Permanently delete the {deleteTarget.name} machine
                            registration, its bound daemon tokens, and its agent
                            and runtime records from Manyfold. Workspace data on
                            the machine is kept. This cannot be undone.
                        </p>
                        <label
                            htmlFor='delete-machine-name'
                            className='text-caption text-label mt-3 block'
                        >
                            Type{' '}
                            <code className='text-heading font-mono'>
                                {deleteTarget.name}
                            </code>{' '}
                            to confirm
                        </label>
                        <input
                            id='delete-machine-name'
                            value={deleteName}
                            onChange={(event): void =>
                                setDeleteName(event.target.value)
                            }
                            className='border-border text-caption text-heading focus:border-brand focus:ring-brand mt-1 block h-8 w-full rounded border bg-white px-2 font-mono transition-colors focus:outline-none focus:ring-1'
                            spellCheck={false}
                            autoComplete='off'
                            autoFocus
                        />
                        <div className='mt-4 flex justify-end gap-2'>
                            <Button
                                variant='neutral'
                                disabled={busyId === deleteTarget.id}
                                onClick={(): void => {
                                    setDeleteTarget(null)
                                    setDeleteName('')
                                }}
                            >
                                Cancel
                            </Button>
                            <Button
                                variant='neutral'
                                disabled={
                                    busyId === deleteTarget.id ||
                                    deleteName !== deleteTarget.name
                                }
                                className='!border-accent-ruby !bg-accent-ruby hover:!bg-accent-ruby/90 !text-white'
                                onClick={(): void => {
                                    void deleteHost()
                                }}
                            >
                                {busyId === deleteTarget.id
                                    ? 'Deleting…'
                                    : 'Delete machine'}
                            </Button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    )
}

export default DaemonsList
