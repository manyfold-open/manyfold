import type {
    SdkSpritesAccountSummary,
    SpritesAccountStatus
} from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { getLocale, t } from '@manyfold/i18n'
import { useApiClient } from '@/lib/apiClient'
import { adminRoutes } from '@/routes'
import { Badge, Button, ButtonLink, Card, Heading, type BadgeTone } from '@/ui'

const statusTone: Record<SpritesAccountStatus, BadgeTone> = {
    enabled: 'success',
    disabled: 'neutral'
}

const SpritesAccountsList: FC = (): ReactNode => {
    const client = useApiClient()
    const navigate = useNavigate()
    const [rows, setRows] = useState<SdkSpritesAccountSummary[] | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [busySlug, setBusySlug] = useState<string | null>(null)

    const refresh = useCallback((): void => {
        setError(null)
        client.admin.spritesAccounts
            .list()
            .then(setRows)
            .catch((e: Error) => setError(e.message))
    }, [client])

    useEffect(refresh, [refresh])

    const onToggleStatus = async (
        row: SdkSpritesAccountSummary
    ): Promise<void> => {
        if (
            row.status === 'enabled' &&
            !window.confirm(t('admin.spritesAccounts.actions.disableConfirm'))
        )
            return
        setBusySlug(row.slug)
        try {
            if (row.status === 'enabled')
                await client.admin.spritesAccounts.disable(row.slug)
            else await client.admin.spritesAccounts.enable(row.slug)
            refresh()
        } catch (e) {
            setError((e as Error).message)
        } finally {
            setBusySlug(null)
        }
    }

    const onRotate = async (row: SdkSpritesAccountSummary): Promise<void> => {
        const token = window.prompt(t('admin.spritesAccounts.form.rotateHint'))
        if (!token || !token.trim()) return
        setBusySlug(row.slug)
        try {
            await client.admin.spritesAccounts.rotate(row.slug, token.trim())
            refresh()
        } catch (e) {
            setError((e as Error).message)
        } finally {
            setBusySlug(null)
        }
    }

    return (
        <div className='mx-auto max-w-none'>
            <div className='mb-3 flex items-start justify-between gap-2'>
                <div>
                    <Heading level={2} className='mb-2'>
                        {t('admin.spritesAccounts.title')}
                    </Heading>
                    <p className='admin-page-description max-w-2xl'>
                        {t('admin.spritesAccounts.subtitle')}
                    </p>
                </div>
                <ButtonLink
                    variant='primary'
                    to={adminRoutes.sandboxAccountNew}
                >
                    {t('admin.spritesAccounts.newButton')}
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
                        {t('admin.spritesAccounts.empty')}
                    </p>
                    <ButtonLink
                        variant='primary'
                        to={adminRoutes.sandboxAccountNew}
                    >
                        {t('admin.spritesAccounts.newButton')}
                    </ButtonLink>
                </div>
            )}

            {rows && rows.length > 0 && (
                <Card elevation='ambient' className='overflow-hidden'>
                    <div className='overflow-x-auto'>
                        <table className='admin-table w-full min-w-[960px] text-left'>
                            <thead className='border-border bg-surface-subtle text-caption-sm text-body border-b tracking-wider uppercase'>
                                <tr>
                                    <th className='px-2 py-1.5 font-normal'>
                                        {t('admin.spritesAccounts.cols.slug')}
                                    </th>
                                    <th className='px-2 py-1.5 font-normal'>
                                        {t('admin.spritesAccounts.cols.org')}
                                    </th>
                                    <th className='px-2 py-1.5 font-normal'>
                                        {t('admin.spritesAccounts.cols.status')}
                                    </th>
                                    <th className='px-2 py-1.5 text-right font-normal'>
                                        Priority
                                    </th>
                                    <th className='px-2 py-1.5 text-right font-normal'>
                                        {t(
                                            'admin.spritesAccounts.cols.activeSprites'
                                        )}
                                    </th>
                                    <th className='px-2 py-1.5 font-normal'>
                                        {t('admin.spritesAccounts.cols.notes')}
                                    </th>
                                    <th className='px-2 py-1.5 font-normal'>
                                        {t(
                                            'admin.spritesAccounts.cols.updatedAt'
                                        )}
                                    </th>
                                    <th className='px-2 py-1.5 text-right font-normal' />
                                </tr>
                            </thead>
                            <tbody className='divide-border divide-y'>
                                {rows.map((a) => (
                                    <tr
                                        key={a.id}
                                        className='text-caption text-heading hover:bg-surface-muted transition-colors'
                                    >
                                        <td className='px-2 py-1.5'>
                                            <Link
                                                to={adminRoutes.sandboxAccount(
                                                    a.slug
                                                )}
                                                className='hover:text-brand'
                                            >
                                                {a.slug}
                                            </Link>
                                        </td>
                                        <td className='px-2 py-1.5 font-mono'>
                                            {a.orgSlug}
                                        </td>
                                        <td className='px-2 py-1.5'>
                                            <Badge tone={statusTone[a.status]}>
                                                {t(
                                                    `admin.spritesAccounts.status.${a.status}`
                                                )}
                                            </Badge>
                                        </td>
                                        <td className='tnum px-2 py-1.5 text-right font-mono'>
                                            {a.priority}
                                        </td>
                                        <td className='tnum px-2 py-1.5 text-right'>
                                            {a.activeSprites}
                                        </td>
                                        <td className='max-w-xs truncate px-2 py-1.5'>
                                            {a.notes ?? '—'}
                                        </td>
                                        <td className='tnum px-2 py-1.5'>
                                            {new Date(
                                                a.updatedAt
                                            ).toLocaleString(getLocale())}
                                        </td>
                                        <td className='px-2 py-1.5 text-right whitespace-nowrap'>
                                            <Button
                                                variant='ghost'
                                                size='sm'
                                                className='mr-2'
                                                disabled={busySlug === a.slug}
                                                onClick={() => onRotate(a)}
                                            >
                                                {t(
                                                    'admin.spritesAccounts.actions.rotate'
                                                )}
                                            </Button>
                                            <Button
                                                variant='ghost'
                                                size='sm'
                                                className='mr-2'
                                                onClick={() =>
                                                    navigate(
                                                        adminRoutes.sandboxAccount(
                                                            a.slug
                                                        )
                                                    )
                                                }
                                            >
                                                {t(
                                                    'admin.spritesAccounts.actions.edit'
                                                )}
                                            </Button>
                                            <Button
                                                variant='neutral'
                                                size='sm'
                                                disabled={busySlug === a.slug}
                                                onClick={() =>
                                                    onToggleStatus(a)
                                                }
                                            >
                                                {t(
                                                    a.status === 'enabled'
                                                        ? 'admin.spritesAccounts.actions.disable'
                                                        : 'admin.spritesAccounts.actions.enable'
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

export default SpritesAccountsList