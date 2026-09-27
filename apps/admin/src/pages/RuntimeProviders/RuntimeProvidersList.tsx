import type {
    RuntimeProviderHealthStatus,
    RuntimeProviderStatus,
    RuntimeProviderSummary
} from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { getLocale, t } from '@manyfold/i18n'
import { ApiError } from '@manyfold/sdk'
import { useApiClient } from '@/lib/apiClient'
import { adminRoutes } from '@/routes'
import { Badge, Button, ButtonLink, Card, Heading, type BadgeTone } from '@/ui'

const statusTone: Record<RuntimeProviderStatus, BadgeTone> = {
    enabled: 'success',
    disabled: 'neutral'
}

const healthTone: Record<RuntimeProviderHealthStatus, BadgeTone> = {
    ok: 'success',
    failed: 'error',
    unknown: 'neutral'
}

const RuntimeProvidersList: FC = (): ReactNode => {
    const client = useApiClient()
    const navigate = useNavigate()
    const [rows, setRows] = useState<RuntimeProviderSummary[] | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [busyId, setBusyId] = useState<string | null>(null)

    const refresh = useCallback((): void => {
        setError(null)
        client.admin.runtimeProviders
            .list()
            .then(setRows)
            .catch((e: Error) => setError(e.message))
    }, [client])

    useEffect(refresh, [refresh])

    const onProbe = async (row: RuntimeProviderSummary): Promise<void> => {
        setBusyId(row.id)
        try {
            await client.admin.runtimeProviders.probe(row.id)
            refresh()
        } catch (e) {
            setError((e as Error).message)
        } finally {
            setBusyId(null)
        }
    }

    const onToggleStatus = async (
        row: RuntimeProviderSummary
    ): Promise<void> => {
        if (
            row.status === 'enabled' &&
            !window.confirm(t('admin.runtimeProviders.actions.disableConfirm'))
        )
            return
        setBusyId(row.id)
        try {
            await client.admin.runtimeProviders.update(row.id, {
                status: row.status === 'enabled' ? 'disabled' : 'enabled'
            })
            refresh()
        } catch (e) {
            setError((e as Error).message)
        } finally {
            setBusyId(null)
        }
    }

    const onDelete = async (row: RuntimeProviderSummary): Promise<void> => {
        if (!window.confirm(t('admin.runtimeProviders.actions.deleteConfirm')))
            return
        setBusyId(row.id)
        try {
            await client.admin.runtimeProviders.delete(row.id)
            refresh()
        } catch (e) {
            setError(
                e instanceof ApiError && e.status === 409
                    ? t('admin.runtimeProviders.actions.deleteBlocked')
                    : (e as Error).message
            )
        } finally {
            setBusyId(null)
        }
    }

    return (
        <div className='mx-auto max-w-none'>
            <div className='mb-3 flex items-start justify-between gap-2'>
                <div>
                    <Heading level={2} className='mb-2'>
                        {t('admin.runtimeProviders.title')}
                    </Heading>
                    <p className='admin-page-description max-w-2xl'>
                        {t('admin.runtimeProviders.subtitle')}
                    </p>
                </div>
                <ButtonLink
                    variant='primary'
                    to={adminRoutes.runtimeProviderNew}
                >
                    {t('admin.runtimeProviders.newButton')}
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
                        {t('admin.runtimeProviders.empty')}
                    </p>
                    <ButtonLink
                        variant='primary'
                        to={adminRoutes.runtimeProviderNew}
                    >
                        {t('admin.runtimeProviders.newButton')}
                    </ButtonLink>
                </div>
            )}

            {rows && rows.length > 0 && (
                <Card elevation='ambient' className='overflow-hidden'>
                    <div className='overflow-x-auto'>
                        <table className='admin-table w-full min-w-[1080px] text-left'>
                            <thead className='border-border bg-surface-subtle text-caption-sm text-body border-b'>
                                <tr>
                                    <th className='px-2 py-1.5 font-normal'>
                                        {t('admin.runtimeProviders.cols.kind')}
                                    </th>
                                    <th className='px-2 py-1.5 font-normal'>
                                        {t('admin.runtimeProviders.cols.name')}
                                    </th>
                                    <th className='px-2 py-1.5 font-normal'>
                                        {t(
                                            'admin.runtimeProviders.cols.status'
                                        )}
                                    </th>
                                    <th className='px-2 py-1.5 text-right font-normal'>
                                        {t(
                                            'admin.runtimeProviders.cols.priority'
                                        )}
                                    </th>
                                    <th className='px-2 py-1.5 font-normal'>
                                        {t(
                                            'admin.runtimeProviders.cols.region'
                                        )}
                                    </th>
                                    <th className='px-2 py-1.5 text-right font-normal'>
                                        {t('admin.runtimeProviders.cols.hosts')}
                                    </th>
                                    <th className='px-2 py-1.5 font-normal'>
                                        {t(
                                            'admin.runtimeProviders.cols.health'
                                        )}
                                    </th>
                                    <th className='px-2 py-1.5 font-normal'>
                                        {t(
                                            'admin.runtimeProviders.cols.updatedAt'
                                        )}
                                    </th>
                                    <th className='px-2 py-1.5 text-right font-normal' />
                                </tr>
                            </thead>
                            <tbody className='divide-border divide-y'>
                                {rows.map((p) => (
                                    <tr
                                        key={p.id}
                                        className='text-caption text-heading hover:bg-surface-muted transition-colors'
                                    >
                                        <td className='px-2 py-1.5'>
                                            {t(
                                                `admin.runtimeProviders.kind.${p.kind}`
                                            )}
                                        </td>
                                        <td className='px-2 py-1.5'>
                                            <Link
                                                to={adminRoutes.runtimeProvider(
                                                    p.id
                                                )}
                                                className='hover:text-brand'
                                            >
                                                {p.name}
                                            </Link>
                                            <div className='text-caption-sm text-body mt-1 font-mono'>
                                                {p.id}
                                            </div>
                                        </td>
                                        <td className='px-2 py-1.5'>
                                            <Badge tone={statusTone[p.status]}>
                                                {t(
                                                    `admin.runtimeProviders.status.${p.status}`
                                                )}
                                            </Badge>
                                        </td>
                                        <td className='tnum px-2 py-1.5 text-right font-mono'>
                                            {p.priority}
                                        </td>
                                        <td className='px-2 py-1.5 font-mono'>
                                            {p.region ?? (
                                                <span className='text-body'>
                                                    —
                                                </span>
                                            )}
                                        </td>
                                        <td className='tnum px-2 py-1.5 text-right'>
                                            {p.hostCount}
                                        </td>
                                        <td className='px-2 py-1.5'>
                                            <Badge
                                                tone={
                                                    healthTone[
                                                        p.lastHealthStatus
                                                    ]
                                                }
                                            >
                                                {t(
                                                    `admin.runtimeProviders.health.${p.lastHealthStatus}`
                                                )}
                                            </Badge>
                                            {p.lastHealthMessage && (
                                                <p
                                                    className='text-caption-sm text-body mt-1 max-w-md truncate font-mono'
                                                    title={
                                                        p.lastHealthCheckedAt
                                                            ? new Date(
                                                                  p.lastHealthCheckedAt
                                                              ).toLocaleString(
                                                                  getLocale()
                                                              )
                                                            : undefined
                                                    }
                                                >
                                                    {p.lastHealthMessage}
                                                </p>
                                            )}
                                        </td>
                                        <td className='tnum px-2 py-1.5'>
                                            {new Date(
                                                p.updatedAt
                                            ).toLocaleString(getLocale())}
                                        </td>
                                        <td className='px-2 py-1.5 text-right whitespace-nowrap'>
                                            <Button
                                                variant='ghost'
                                                size='sm'
                                                className='mr-2'
                                                disabled={busyId === p.id}
                                                onClick={(): void => {
                                                    void onProbe(p)
                                                }}
                                            >
                                                {t(
                                                    'admin.runtimeProviders.actions.probe'
                                                )}
                                            </Button>
                                            <Button
                                                variant='ghost'
                                                size='sm'
                                                className='mr-2'
                                                onClick={(): void =>
                                                    navigate(
                                                        adminRoutes.runtimeProvider(
                                                            p.id
                                                        )
                                                    )
                                                }
                                            >
                                                {t(
                                                    'admin.runtimeProviders.actions.edit'
                                                )}
                                            </Button>
                                            <Button
                                                variant='neutral'
                                                size='sm'
                                                className='mr-2'
                                                disabled={busyId === p.id}
                                                onClick={(): void => {
                                                    void onToggleStatus(p)
                                                }}
                                            >
                                                {t(
                                                    p.status === 'enabled'
                                                        ? 'admin.runtimeProviders.actions.disable'
                                                        : 'admin.runtimeProviders.actions.enable'
                                                )}
                                            </Button>
                                            <Button
                                                variant='neutral'
                                                size='sm'
                                                disabled={busyId === p.id}
                                                onClick={(): void => {
                                                    void onDelete(p)
                                                }}
                                            >
                                                {t(
                                                    'admin.runtimeProviders.actions.delete'
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

export default RuntimeProvidersList
