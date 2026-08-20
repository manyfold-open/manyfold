import type {
    K8sClusterHealthStatus,
    K8sClusterSummary
} from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { getLocale, t } from '@manyfold/i18n'
import { useApiClient } from '@/lib/apiClient'
import { adminRoutes } from '@/routes'
import { Badge, Button, ButtonLink, Card, Heading, type BadgeTone } from '@/ui'

const healthTone: Record<K8sClusterHealthStatus, BadgeTone> = {
    ok: 'success',
    failed: 'error',
    unknown: 'neutral'
}

const ClustersList: FC = (): ReactNode => {
    const client = useApiClient()
    const navigate = useNavigate()
    const [rows, setRows] = useState<K8sClusterSummary[] | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [busyId, setBusyId] = useState<string | null>(null)

    const refresh = useCallback((): void => {
        setError(null)
        client.admin.clusters
            .list()
            .then(setRows)
            .catch((e: Error) => setError(e.message))
    }, [client])

    useEffect(refresh, [refresh])

    const onProbe = async (id: string): Promise<void> => {
        setBusyId(id)
        try {
            await client.admin.clusters.probe(id)
            refresh()
        } catch (e) {
            setError((e as Error).message)
        } finally {
            setBusyId(null)
        }
    }

    const onDelete = async (cluster: K8sClusterSummary): Promise<void> => {
        if (!window.confirm(t('admin.clusters.actions.deleteConfirm'))) return
        setBusyId(cluster.id)
        try {
            await client.admin.clusters.delete(cluster.id)
            refresh()
        } catch (e) {
            setError((e as Error).message)
        } finally {
            setBusyId(null)
        }
    }

    return (
        <div className='mx-auto max-w-none'>
            <div className='mb-3 flex items-start justify-between gap-2'>
                <div>
                    <Heading level={2} className='mb-2'>
                        {t('admin.clusters.title')}
                    </Heading>
                    <p className='admin-page-description max-w-2xl'>
                        {t('admin.clusters.subtitle')}
                    </p>
                </div>
                <ButtonLink variant='primary' to={adminRoutes.clusterNew}>
                    {t('admin.clusters.newButton')}
                </ButtonLink>
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
                <p className='text-caption text-body'>{t('common.loading')}</p>
            )}

            {rows && rows.length === 0 && (
                <div className='border-border-dashed rounded-lg border border-dashed bg-white p-4 text-center'>
                    <p className='admin-page-description mb-2'>
                        {t('admin.clusters.empty')}
                    </p>
                    <ButtonLink variant='primary' to={adminRoutes.clusterNew}>
                        {t('admin.clusters.newButton')}
                    </ButtonLink>
                </div>
            )}

            {rows && rows.length > 0 && (
                <Card elevation='ambient' className='overflow-hidden'>
                    <div className='overflow-x-auto'>
                        <table className='admin-table w-full min-w-[840px] text-left'>
                            <thead className='border-border bg-surface-subtle text-caption-sm text-body border-b tracking-wider uppercase'>
                                <tr>
                                    <th className='px-2 py-1.5 font-normal'>
                                        {t('admin.clusters.cols.name')}
                                    </th>
                                    <th className='px-2 py-1.5 font-normal'>
                                        {t('admin.clusters.cols.description')}
                                    </th>
                                    <th className='px-2 py-1.5 font-normal'>
                                        Region
                                    </th>
                                    <th className='px-2 py-1.5 font-normal'>
                                        {t('admin.clusters.cols.health')}
                                    </th>
                                    <th className='px-2 py-1.5 text-right font-normal'>
                                        Priority
                                    </th>
                                    <th className='px-2 py-1.5 font-normal'>
                                        {t('admin.clusters.cols.updatedAt')}
                                    </th>
                                    <th className='px-2 py-1.5 text-right font-normal' />
                                </tr>
                            </thead>
                            <tbody className='divide-border divide-y'>
                                {rows.map((c) => (
                                    <tr
                                        key={c.id}
                                        className='text-caption text-heading hover:bg-surface-muted transition-colors'
                                    >
                                        <td className='px-2 py-1.5'>
                                            <Link
                                                to={adminRoutes.cluster(c.id)}
                                                className='hover:text-brand'
                                            >
                                                {c.name}
                                            </Link>
                                        </td>
                                        <td className='px-2 py-1.5'>
                                            {c.description ?? '—'}
                                        </td>
                                        <td className='px-2 py-1.5 font-mono'>
                                            {c.region ?? (
                                                <span className='text-body'>
                                                    —
                                                </span>
                                            )}
                                        </td>
                                        <td className='px-2 py-1.5'>
                                            <Badge
                                                tone={
                                                    healthTone[
                                                        c.lastHealthStatus
                                                    ]
                                                }
                                            >
                                                {t(
                                                    `admin.clusters.health.${c.lastHealthStatus}`
                                                )}
                                            </Badge>
                                            {c.lastHealthMessage && (
                                                <p className='text-caption-sm text-body mt-1 max-w-md truncate font-mono'>
                                                    {c.lastHealthMessage}
                                                </p>
                                            )}
                                        </td>
                                        <td className='tnum px-2 py-1.5 text-right font-mono'>
                                            {c.priority}
                                        </td>
                                        <td className='tnum px-2 py-1.5'>
                                            {new Date(
                                                c.updatedAt
                                            ).toLocaleString(getLocale())}
                                        </td>
                                        <td className='px-2 py-1.5 text-right whitespace-nowrap'>
                                            <Button
                                                variant='ghost'
                                                size='sm'
                                                className='mr-2'
                                                disabled={busyId === c.id}
                                                onClick={() => onProbe(c.id)}
                                            >
                                                {t(
                                                    'admin.clusters.actions.probe'
                                                )}
                                            </Button>
                                            <Button
                                                variant='ghost'
                                                size='sm'
                                                className='mr-2'
                                                onClick={() =>
                                                    navigate(
                                                        adminRoutes.cluster(c.id)
                                                    )
                                                }
                                            >
                                                {t(
                                                    'admin.clusters.actions.edit'
                                                )}
                                            </Button>
                                            <Button
                                                variant='neutral'
                                                size='sm'
                                                disabled={busyId === c.id}
                                                onClick={() => onDelete(c)}
                                            >
                                                {t(
                                                    'admin.clusters.actions.delete'
                                                )}
                                            </Button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </Card>
            )}
        </div>
    )
}

export default ClustersList