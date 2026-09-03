import type {
    NotificationEventKey,
    SdkNotificationWebhookSummary
} from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { getLocale } from '@manyfold/i18n'
import { useApiClient } from '@/lib/apiClient'
import { adminRoutes } from '@/routes'
import { Badge, Button, ButtonLink, Card, Heading } from '@/ui'

const EVENT_SHORT: Record<NotificationEventKey, string> = {
    'user.registered': 'signup',
    'subscription.activated': 'subscribe',
    'payment.credited': 'topup'
}

const NotificationWebhooksList: FC = (): ReactNode => {
    const client = useApiClient()
    const navigate = useNavigate()
    const [rows, setRows] = useState<SdkNotificationWebhookSummary[] | null>(
        null
    )
    const [error, setError] = useState<string | null>(null)
    const [notice, setNotice] = useState<string | null>(null)
    const [busyId, setBusyId] = useState<string | null>(null)

    const refresh = useCallback((): void => {
        setError(null)
        client.admin.notificationWebhooks
            .list()
            .then(setRows)
            .catch((e: Error) => setError(e.message))
    }, [client])

    useEffect(refresh, [refresh])

    const onTest = async (
        row: SdkNotificationWebhookSummary
    ): Promise<void> => {
        setBusyId(row.id)
        setError(null)
        setNotice(null)
        try {
            await client.admin.notificationWebhooks.test(row.id)
            setNotice(`Test notification sent to "${row.label}".`)
        } catch (e) {
            setError((e as Error).message)
        } finally {
            setBusyId(null)
            refresh()
        }
    }

    const onDelete = async (
        row: SdkNotificationWebhookSummary
    ): Promise<void> => {
        if (!window.confirm(`Delete webhook "${row.label}"?`)) return
        setBusyId(row.id)
        try {
            await client.admin.notificationWebhooks.remove(row.id)
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
                        Notification webhooks
                    </Heading>
                    <p className='admin-page-description max-w-2xl'>
                        Outbound operational alerts. Each webhook posts to a
                        Slack / Discord / Lark / Telegram destination when a
                        subscribed event fires (new signup, subscription, or
                        top-up).
                    </p>
                </div>
                <ButtonLink
                    variant='primary'
                    to={adminRoutes.notificationWebhookNew}
                >
                    New webhook
                </ButtonLink>
            </div>

            {notice && (
                <Card
                    elevation='flat'
                    className='border-success-ring bg-success-bg mb-2 p-2'
                >
                    <p className='text-caption-sm text-success-text'>
                        {notice}
                    </p>
                </Card>
            )}

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
                    <p className='admin-page-description mb-2'>
                        No webhooks yet. Create one to start receiving alerts.
                    </p>
                    <ButtonLink
                        variant='primary'
                        to={adminRoutes.notificationWebhookNew}
                    >
                        New webhook
                    </ButtonLink>
                </div>
            )}

            {rows && rows.length > 0 && (
                <Card elevation='ambient' className='overflow-hidden'>
                    <div className='overflow-x-auto'>
                        <table className='admin-table w-full min-w-[960px] text-left'>
                            <thead className='border-border bg-surface-subtle text-caption-sm text-body border-b'>
                                <tr>
                                    <th className='px-2 py-1.5 font-normal'>
                                        Label
                                    </th>
                                    <th className='px-2 py-1.5 font-normal'>
                                        Provider
                                    </th>
                                    <th className='px-2 py-1.5 font-normal'>
                                        Events
                                    </th>
                                    <th className='px-2 py-1.5 font-normal'>
                                        Status
                                    </th>
                                    <th className='px-2 py-1.5 font-normal'>
                                        Last delivery
                                    </th>
                                    <th className='px-2 py-1.5 font-normal'>
                                        Last error
                                    </th>
                                    <th className='px-2 py-1.5 text-right font-normal' />
                                </tr>
                            </thead>
                            <tbody className='divide-border divide-y'>
                                {rows.map((w) => (
                                    <tr
                                        key={w.id}
                                        className='text-caption text-heading hover:bg-surface-muted transition-colors'
                                    >
                                        <td className='px-2 py-1.5'>
                                            <Link
                                                to={adminRoutes.notificationWebhook(
                                                    w.id
                                                )}
                                                className='hover:text-brand'
                                            >
                                                {w.label}
                                            </Link>
                                        </td>
                                        <td className='px-2 py-1.5 font-mono'>
                                            {w.provider}
                                        </td>
                                        <td className='px-2 py-1.5'>
                                            <div className='flex flex-wrap gap-1'>
                                                {w.events.map((ev) => (
                                                    <Badge key={ev} tone='neutral'>
                                                        {EVENT_SHORT[ev] ?? ev}
                                                    </Badge>
                                                ))}
                                            </div>
                                        </td>
                                        <td className='px-2 py-1.5'>
                                            <Badge
                                                tone={
                                                    w.enabled
                                                        ? 'success'
                                                        : 'neutral'
                                                }
                                            >
                                                {w.enabled
                                                    ? 'enabled'
                                                    : 'disabled'}
                                            </Badge>
                                        </td>
                                        <td className='tnum px-2 py-1.5'>
                                            {w.lastDeliveryAt
                                                ? new Date(
                                                      w.lastDeliveryAt
                                                  ).toLocaleString(getLocale())
                                                : '—'}
                                        </td>
                                        <td className='text-accent-ruby px-2 py-1.5'>
                                            {w.lastErrorMessage ?? '—'}
                                        </td>
                                        <td className='px-2 py-1.5 text-right whitespace-nowrap'>
                                            <Button
                                                variant='ghost'
                                                size='sm'
                                                className='mr-2'
                                                onClick={() =>
                                                    navigate(
                                                        adminRoutes.notificationWebhook(
                                                            w.id
                                                        )
                                                    )
                                                }
                                            >
                                                Edit
                                            </Button>
                                            <Button
                                                variant='neutral'
                                                size='sm'
                                                className='mr-2'
                                                disabled={busyId === w.id}
                                                onClick={() => onTest(w)}
                                            >
                                                Send test
                                            </Button>
                                            <Button
                                                variant='neutral'
                                                size='sm'
                                                disabled={busyId === w.id}
                                                onClick={() => onDelete(w)}
                                            >
                                                Delete
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

export default NotificationWebhooksList