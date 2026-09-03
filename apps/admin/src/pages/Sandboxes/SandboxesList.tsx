import type {
    SandboxServiceSummary,
    SandboxSummary,
    SandboxTaskSummary,
    SdkUserSummary,
    SpriteStatus
} from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useApiClient } from '@/lib/apiClient'
import { useCurrentUser } from '@/lib/useCurrentUser'
import { adminRoutes } from '@/routes'
import { Badge, Button, Card, Heading, type BadgeTone } from '@/ui'

const statusTone = (status: SpriteStatus | null): BadgeTone => {
    if (status === 'running') return 'success'
    if (status === 'warm') return 'brand'
    return 'neutral'
}

// Active (running) duration this month, hours with one decimal; '—' when none
// has accrued yet.
const formatActiveHours = (seconds: number): string =>
    seconds > 0 ? `${(seconds / 3600).toFixed(1)}h` : '—'

const serviceTone = (status: SandboxServiceSummary['status']): BadgeTone => {
    if (status === 'running') return 'success'
    if (status === 'failed') return 'error'
    if (status === 'starting' || status === 'stopping') return 'warning'
    return 'neutral'
}

const SandboxesList: FC = (): ReactNode => {
    const client = useApiClient()
    const { isAdmin, loading } = useCurrentUser()
    const [rows, setRows] = useState<SandboxSummary[] | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [busyId, setBusyId] = useState<string | null>(null)
    const [refreshingStatus, setRefreshingStatus] = useState(false)
    const [userMap, setUserMap] = useState<Record<string, SdkUserSummary>>({})
    const [servicesOpenId, setServicesOpenId] = useState<string | null>(null)
    const [services, setServices] = useState<SandboxServiceSummary[] | null>(
        null
    )
    const [tasks, setTasks] = useState<SandboxTaskSummary[] | null>(null)
    const [servicesLoading, setServicesLoading] = useState(false)
    const [servicesError, setServicesError] = useState<string | null>(null)
    const [tasksError, setTasksError] = useState<string | null>(null)
    const [deletingService, setDeletingService] = useState<string | null>(null)
    const [deletingTask, setDeletingTask] = useState<string | null>(null)

    const sandboxesApi = isAdmin ? client.admin.sandboxes : client.sandboxes

    const refresh = useCallback((): void => {
        if (loading) return
        sandboxesApi
            .list()
            .then(setRows)
            .catch((e: Error) => setError(e.message))
    }, [sandboxesApi, loading])

    useEffect(() => {
        refresh()
        const t = setInterval(refresh, 10_000)
        return () => clearInterval(t)
    }, [refresh])

    // Force an immediate sprites.dev lifecycle re-read for every sandbox at once
    // (the periodic sync lags up to 30s while warm/cold). Each call returns the
    // authoritative summary, which we merge back so statuses update in place.
    const refreshAllStatus = async (): Promise<void> => {
        if (!rows || rows.length === 0) return
        setRefreshingStatus(true)
        setError(null)
        const results = await Promise.allSettled(
            rows.map((r) => sandboxesApi.refreshStatus(r.id))
        )
        const updates = new Map<string, SandboxSummary>()
        for (const x of results)
            if (x.status === 'fulfilled') updates.set(x.value.id, x.value)
        setRows((prev) =>
            prev ? prev.map((r) => updates.get(r.id) ?? r) : prev
        )
        const failed = results.length - updates.size
        if (failed > 0)
            setError(
                `Failed to refresh ${failed} of ${results.length} sandbox status${
                    results.length === 1 ? '' : 'es'
                }.`
            )
        setRefreshingStatus(false)
    }

    useEffect(() => {
        if (!isAdmin) return
        client.admin.users
            .list()
            .then((rows) => {
                const map: Record<string, SdkUserSummary> = {}
                for (const u of rows) map[u.id] = u
                setUserMap(map)
            })
            .catch(() => {
                // owner column will fall back to userId
            })
    }, [client, isAdmin])

    const remove = async (r: SandboxSummary): Promise<void> => {
        if (
            !window.confirm(
                `Delete sandbox ${r.name}? The VM is destroyed; this cannot be undone.`
            )
        )
            return
        setBusyId(r.id)
        setError(null)
        try {
            await sandboxesApi.delete(r.id)
            refresh()
        } catch (e) {
            setError((e as Error).message)
        } finally {
            setBusyId(null)
        }
    }

    const toggleTerminal = async (r: SandboxSummary): Promise<void> => {
        setBusyId(r.id)
        setError(null)
        try {
            await sandboxesApi.setTerminal(r.id, !r.terminalEnabled)
            refresh()
        } catch (e) {
            setError((e as Error).message)
        } finally {
            setBusyId(null)
        }
    }

    const toggleServices = (id: string): void => {
        if (servicesOpenId === id) {
            setServicesOpenId(null)
            return
        }
        setServicesOpenId(id)
        setServices(null)
        setTasks(null)
        setServicesError(null)
        setTasksError(null)
        setServicesLoading(true)
        Promise.allSettled([
            sandboxesApi.listServices(id),
            sandboxesApi.listTasks(id)
        ])
            .then(([s, t]) => {
                if (s.status === 'fulfilled') setServices(s.value)
                else setServicesError((s.reason as Error)?.message ?? 'failed')
                if (t.status === 'fulfilled') setTasks(t.value)
                else setTasksError((t.reason as Error)?.message ?? 'failed')
            })
            .finally(() => setServicesLoading(false))
    }

    const removeService = async (id: string, name: string): Promise<void> => {
        if (
            !window.confirm(
                `Delete service "${name}"? It will be stopped and removed from the sprite.`
            )
        )
            return
        setDeletingService(name)
        setServicesError(null)
        try {
            await sandboxesApi.deleteService(id, name)
            setServices((prev) =>
                prev ? prev.filter((s) => s.name !== name) : prev
            )
        } catch (e) {
            setServicesError((e as Error).message)
        } finally {
            setDeletingService(null)
        }
    }

    const removeTask = async (id: string, name: string): Promise<void> => {
        if (
            !window.confirm(
                `Delete task "${name}"? Its activity lease is released from the sprite.`
            )
        )
            return
        setDeletingTask(name)
        setTasksError(null)
        try {
            await sandboxesApi.deleteTask(id, name)
            setTasks((prev) =>
                prev ? prev.filter((t) => t.name !== name) : prev
            )
        } catch (e) {
            setTasksError((e as Error).message)
        } finally {
            setDeletingTask(null)
        }
    }

    const stop = async (r: SandboxSummary): Promise<void> => {
        if (
            !window.confirm(
                `Stop sandbox ${r.name}? Agents on it are stopped and keep-alive turned off — they wake on the next message. Non-platform services are stopped and activity tasks removed.`
            )
        )
            return
        setBusyId(r.id)
        setError(null)
        try {
            await sandboxesApi.stop(r.id)
            refresh()
        } catch (e) {
            setError((e as Error).message)
        } finally {
            setBusyId(null)
        }
    }

    return (
        <div className='space-y-2'>
            <div className='flex items-center justify-between'>
                <Heading level={1}>Sandboxes</Heading>
                <div className='flex items-center gap-2'>
                    <Button
                        variant='ghost'
                        size='sm'
                        disabled={
                            refreshingStatus || !rows || rows.length === 0
                        }
                        onClick={(): void => {
                            void refreshAllStatus()
                        }}
                    >
                        {refreshingStatus ? 'Refreshing…' : 'Refresh status'}
                    </Button>
                    <Link to={adminRoutes.sandboxNew}>
                        <Button size='sm'>New sandbox</Button>
                    </Link>
                </div>
            </div>
            <p className='text-caption text-body'>
                Standalone sandbox VMs. A sandbox can run without an agent;
                attach agents to it when creating them. Empty sandboxes are
                auto-removed after 7 days.
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
                        No sandboxes yet. Create one to get started.
                    </p>
                </div>
            )}

            {rows && rows.length > 0 && (
                <Card elevation='ambient' className='overflow-hidden'>
                    <div className='overflow-x-auto'>
                        <table className='admin-table w-full min-w-[900px] text-left'>
                            <thead className='border-border bg-surface-subtle text-caption-sm text-body border-b'>
                                <tr>
                                    <th className='px-2 py-1.5 font-normal'>
                                        Name
                                    </th>
                                    {isAdmin && (
                                        <th className='px-2 py-1.5 font-normal'>
                                            Owner
                                        </th>
                                    )}
                                    <th className='px-2 py-1.5 font-normal'>
                                        Account
                                    </th>
                                    <th className='px-2 py-1.5 font-normal'>
                                        Status
                                    </th>
                                    <th className='px-2 py-1.5 font-normal'>
                                        Agents
                                    </th>
                                    <th className='px-2 py-1.5 font-normal'>
                                        Active (period)
                                    </th>
                                    <th className='px-2 py-1.5 font-normal'>
                                        Terminal
                                    </th>
                                    <th className='px-2 py-1.5 font-normal'>
                                        Created
                                    </th>
                                    <th className='px-2 py-1.5 font-normal'></th>
                                </tr>
                            </thead>
                            <tbody className='divide-border divide-y'>
                                {rows.flatMap((r) => [
                                    <tr
                                        key={r.id}
                                        className='text-caption text-heading'
                                    >
                                        <td className='px-2 py-1.5'>
                                            {r.name}
                                            <div className='text-caption-sm text-body mt-1 font-mono'>
                                                {r.spriteName ?? r.id}
                                            </div>
                                        </td>
                                        {isAdmin && (
                                            <td className='px-2 py-1.5 font-mono'>
                                                {userMap[r.userId]?.email ??
                                                    r.userId}
                                            </td>
                                        )}
                                        <td className='px-2 py-1.5 font-mono'>
                                            {r.accountSlug ?? '—'}
                                        </td>
                                        <td className='px-2 py-1.5'>
                                            <Badge
                                                tone={statusTone(r.spriteStatus)}
                                            >
                                                {r.spriteStatus ?? 'cold'}
                                            </Badge>
                                        </td>
                                        <td className='px-2 py-1.5'>
                                            {r.agentsCount}
                                        </td>
                                        <td className='px-2 py-1.5 font-mono'>
                                            {formatActiveHours(
                                                r.activeSecondsThisPeriod
                                            )}
                                        </td>
                                        <td className='px-2 py-1.5'>
                                            <Button
                                                variant='ghost'
                                                size='sm'
                                                disabled={busyId === r.id}
                                                onClick={(): void => {
                                                    void toggleTerminal(r)
                                                }}
                                            >
                                                {r.terminalEnabled
                                                    ? 'On — disable'
                                                    : 'Off — enable'}
                                            </Button>
                                        </td>
                                        <td className='text-caption-sm text-body px-2 py-1.5'>
                                            {new Date(
                                                r.createdAt
                                            ).toLocaleString()}
                                        </td>
                                        <td className='px-2 py-1.5'>
                                            <div className='flex justify-end gap-1'>
                                                <Button
                                                    variant='ghost'
                                                    size='sm'
                                                    disabled={
                                                        busyId === r.id ||
                                                        r.spriteStatus !==
                                                            'running'
                                                    }
                                                    title={
                                                        r.spriteStatus !==
                                                        'running'
                                                            ? 'Sandbox is already asleep'
                                                            : undefined
                                                    }
                                                    onClick={(): void => {
                                                        void stop(r)
                                                    }}
                                                >
                                                    Stop
                                                </Button>
                                                <Button
                                                    variant='ghost'
                                                    size='sm'
                                                    onClick={(): void => {
                                                        toggleServices(r.id)
                                                    }}
                                                >
                                                    {servicesOpenId === r.id
                                                        ? 'Hide services'
                                                        : 'Services'}
                                                </Button>
                                                <Button
                                                    variant='ghost'
                                                    size='sm'
                                                    disabled={
                                                        busyId === r.id ||
                                                        r.agentsCount > 0
                                                    }
                                                    title={
                                                        r.agentsCount > 0
                                                            ? 'Delete the agents on this sandbox first'
                                                            : undefined
                                                    }
                                                    onClick={(): void => {
                                                        void remove(r)
                                                    }}
                                                >
                                                    Delete
                                                </Button>
                                            </div>
                                        </td>
                                    </tr>,
                                    servicesOpenId === r.id && (
                                        <tr
                                            key={`${r.id}-services`}
                                            className='bg-surface-subtle'
                                        >
                                            <td
                                                colSpan={isAdmin ? 9 : 8}
                                                className='px-2 py-2'
                                            >
                                                <div className='text-caption-sm text-body mb-1'>
                                                    Services
                                                </div>
                                                {servicesLoading ? (
                                                    <p className='text-caption-sm text-body'>
                                                        Loading services…
                                                    </p>
                                                ) : servicesError ? (
                                                    <p className='text-accent-ruby text-caption-sm'>
                                                        {servicesError}
                                                    </p>
                                                ) : services &&
                                                  services.length === 0 ? (
                                                    <p className='text-caption-sm text-body'>
                                                        No managed services
                                                        registered on this
                                                        sprite.
                                                    </p>
                                                ) : (
                                                    <div className='space-y-1'>
                                                        {(services ?? []).map(
                                                            (svc) => (
                                                                <div
                                                                    key={svc.name}
                                                                    className='flex items-center gap-3'
                                                                >
                                                                    <Badge
                                                                        tone={serviceTone(
                                                                            svc.status
                                                                        )}
                                                                    >
                                                                        {svc.status}
                                                                    </Badge>
                                                                    <span className='text-caption-sm text-heading font-mono'>
                                                                        {svc.name}
                                                                        {svc.httpPort !==
                                                                        null
                                                                            ? `:${svc.httpPort}`
                                                                            : ''}
                                                                    </span>
                                                                    <span className='text-caption-sm text-body flex-1 truncate font-mono'>
                                                                        {svc.command}
                                                                    </span>
                                                                    {svc.managed ? (
                                                                        <span
                                                                            className='text-caption-sm text-body'
                                                                            title='Managed by Manyfold — cannot be deleted here.'
                                                                        >
                                                                            Managed
                                                                        </span>
                                                                    ) : (
                                                                        <Button
                                                                            variant='ghost'
                                                                            size='sm'
                                                                            disabled={
                                                                                deletingService ===
                                                                                svc.name
                                                                            }
                                                                            onClick={(): void => {
                                                                                void removeService(
                                                                                    r.id,
                                                                                    svc.name
                                                                                )
                                                                            }}
                                                                        >
                                                                            {deletingService ===
                                                                            svc.name
                                                                                ? 'Deleting…'
                                                                                : 'Delete'}
                                                                        </Button>
                                                                    )}
                                                                </div>
                                                            )
                                                        )}
                                                    </div>
                                                )}
                                                <div className='text-caption-sm text-body mt-3 mb-1'>
                                                    Tasks
                                                </div>
                                                {servicesLoading ? (
                                                    <p className='text-caption-sm text-body'>
                                                        Loading…
                                                    </p>
                                                ) : tasksError ? (
                                                    <p className='text-accent-ruby text-caption-sm'>
                                                        {tasksError}
                                                    </p>
                                                ) : tasks &&
                                                  tasks.length === 0 ? (
                                                    <p className='text-caption-sm text-body'>
                                                        No activity tasks
                                                        (keep-alive leases).
                                                    </p>
                                                ) : (
                                                    <div className='space-y-1'>
                                                        {(tasks ?? []).map(
                                                            (t) => (
                                                                <div
                                                                    key={t.name}
                                                                    className='flex items-center gap-3'
                                                                >
                                                                    <Badge tone='success'>
                                                                        active
                                                                    </Badge>
                                                                    <span className='text-caption-sm text-heading flex-1 truncate font-mono'>
                                                                        {t.name}
                                                                    </span>
                                                                    {t.expiresAt && (
                                                                        <span className='text-caption-sm text-body'>
                                                                            expires{' '}
                                                                            {new Date(
                                                                                t.expiresAt
                                                                            ).toLocaleTimeString()}
                                                                        </span>
                                                                    )}
                                                                    {t.keepAlive ? (
                                                                        <span title='Keep-alive lease — turn off keep-alive on the runtime.'>
                                                                            <Badge tone='neutral'>
                                                                                keep-alive
                                                                            </Badge>
                                                                        </span>
                                                                    ) : (
                                                                        <Button
                                                                            variant='ghost'
                                                                            size='sm'
                                                                            disabled={
                                                                                deletingTask ===
                                                                                t.name
                                                                            }
                                                                            onClick={(): void => {
                                                                                void removeTask(
                                                                                    r.id,
                                                                                    t.name
                                                                                )
                                                                            }}
                                                                        >
                                                                            {deletingTask ===
                                                                            t.name
                                                                                ? 'Deleting…'
                                                                                : 'Delete'}
                                                                        </Button>
                                                                    )}
                                                                </div>
                                                            )
                                                        )}
                                                    </div>
                                                )}
                                            </td>
                                        </tr>
                                    )
                                ])}
                            </tbody>
                        </table>
                    </div>
                </Card>
            )}
        </div>
    )
}

export default SandboxesList