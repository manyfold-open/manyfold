import type {
    NotificationEventKey,
    NotificationProvider,
    SdkNotificationWebhookSummary
} from '@manyfold/shared'
import type { FC, FormEvent, ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useApiClient } from '@/lib/apiClient'
import { adminRoutes } from '@/routes'
import {
    Breadcrumbs,
    Button,
    Card,
    CardBody,
    DetailPage,
    Heading,
    Input
} from '@/ui'

const PROVIDER_OPTIONS: ReadonlyArray<{
    value: NotificationProvider
    label: string
}> = [
    { value: 'slack', label: 'Slack (Incoming Webhook)' },
    { value: 'discord', label: 'Discord (Webhook)' },
    { value: 'lark', label: 'Lark / Feishu (Custom Bot)' },
    { value: 'telegram', label: 'Telegram (Bot)' }
]

const EVENT_OPTIONS: ReadonlyArray<{
    value: NotificationEventKey
    label: string
}> = [
    { value: 'user.registered', label: 'New user registered' },
    { value: 'subscription.activated', label: 'Subscription activated' },
    { value: 'payment.credited', label: 'Top-up credited' }
]

const URL_HINT: Record<NotificationProvider, string> = {
    slack: 'Slack Incoming Webhook URL (https://hooks.slack.com/services/…).',
    discord: 'Discord channel Webhook URL (https://discord.com/api/webhooks/…).',
    lark: 'Lark/Feishu custom bot URL (https://open.feishu.cn/open-apis/bot/v2/hook/…).',
    telegram: ''
}

const selectClass =
    'border-border text-body text-heading focus:border-brand focus:ring-brand h-10 w-full rounded border bg-white px-2 transition-colors focus:ring-1 focus:outline-none'

const NotificationWebhookForm: FC = (): ReactNode => {
    const { id } = useParams<{ id?: string }>()
    const isEdit = Boolean(id)
    const client = useApiClient()
    const navigate = useNavigate()

    const [label, setLabel] = useState('')
    const [provider, setProvider] = useState<NotificationProvider>('slack')
    const [enabled, setEnabled] = useState(true)
    const [events, setEvents] = useState<NotificationEventKey[]>([])
    const [webhookUrl, setWebhookUrl] = useState('')
    const [larkSecret, setLarkSecret] = useState('')
    const [botToken, setBotToken] = useState('')
    const [chatId, setChatId] = useState('')
    const [loading, setLoading] = useState(isEdit)
    const [submitting, setSubmitting] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [loaded, setLoaded] = useState<SdkNotificationWebhookSummary | null>(
        null
    )

    useEffect(() => {
        if (!id) return
        setLoading(true)
        client.admin.notificationWebhooks
            .get(id)
            .then((row) => {
                setLoaded(row)
                setLabel(row.label)
                setProvider(row.provider)
                setEnabled(row.enabled)
                setEvents(row.events)
                setChatId(row.configMasked.chatId ?? '')
            })
            .catch((e: Error) => setError(e.message))
            .finally(() => setLoading(false))
    }, [client, id])

    const toggleEvent = (ev: NotificationEventKey): void => {
        setEvents((cur) =>
            cur.includes(ev) ? cur.filter((e) => e !== ev) : [...cur, ev]
        )
    }

    const isTelegram = provider === 'telegram'

    const secretsOk = isEdit
        ? true
        : isTelegram
          ? botToken.trim().length > 0 && chatId.trim().length > 0
          : webhookUrl.trim().length > 0

    const canSubmit =
        !submitting &&
        label.trim().length > 0 &&
        events.length > 0 &&
        secretsOk

    const submit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
        e.preventDefault()
        setError(null)
        setSubmitting(true)
        try {
            if (isEdit && id) {
                await client.admin.notificationWebhooks.update(id, {
                    label: label.trim(),
                    enabled,
                    events,
                    ...(webhookUrl.trim()
                        ? { webhookUrl: webhookUrl.trim() }
                        : {}),
                    ...(larkSecret.trim()
                        ? { larkSecret: larkSecret.trim() }
                        : {}),
                    ...(botToken.trim() ? { botToken: botToken.trim() } : {}),
                    ...(chatId.trim() ? { chatId: chatId.trim() } : {})
                })
            } else {
                await client.admin.notificationWebhooks.create({
                    provider,
                    label: label.trim(),
                    enabled,
                    events,
                    ...(isTelegram
                        ? {
                              botToken: botToken.trim(),
                              chatId: chatId.trim()
                          }
                        : { webhookUrl: webhookUrl.trim() }),
                    ...(provider === 'lark' && larkSecret.trim()
                        ? { larkSecret: larkSecret.trim() }
                        : {})
                })
            }
            navigate(adminRoutes.notificationWebhooks)
        } catch (err) {
            setError((err as Error).message)
        } finally {
            setSubmitting(false)
        }
    }

    return (
        <DetailPage>
            <Breadcrumbs
                items={[
                    {
                        label: 'Notification webhooks',
                        to: adminRoutes.notificationWebhooks
                    },
                    {
                        label: isEdit
                            ? (loaded?.label ?? 'Edit webhook')
                            : 'New webhook'
                    }
                ]}
            />
            <Heading level={2} className='mb-2'>
                {isEdit
                    ? 'Edit notification webhook'
                    : 'New notification webhook'}
            </Heading>

            <Card elevation='elevated'>
                <CardBody>
                    {loading ? (
                        <p className='text-caption text-body'>Loading…</p>
                    ) : (
                        <form onSubmit={submit} className='space-y-2'>
                            <Input
                                id='label'
                                label='Label'
                                placeholder='e.g. Ops team — Slack #alerts'
                                hint='Shown in the admin list only.'
                                required
                                minLength={1}
                                maxLength={80}
                                value={label}
                                onChange={(e) => setLabel(e.target.value)}
                            />

                            <div>
                                <label
                                    htmlFor='provider'
                                    className='text-caption text-label mb-1 block font-normal'
                                >
                                    Provider
                                </label>
                                <select
                                    id='provider'
                                    className={selectClass}
                                    value={provider}
                                    disabled={isEdit}
                                    onChange={(e) =>
                                        setProvider(
                                            e.target
                                                .value as NotificationProvider
                                        )
                                    }
                                >
                                    {PROVIDER_OPTIONS.map((opt) => (
                                        <option
                                            key={opt.value}
                                            value={opt.value}
                                        >
                                            {opt.label}
                                        </option>
                                    ))}
                                </select>
                                {isEdit && (
                                    <p className='text-caption-sm text-body mt-1'>
                                        Provider is fixed once created; create a
                                        new webhook to switch.
                                    </p>
                                )}
                            </div>

                            <div>
                                <span className='text-caption text-label mb-1 block font-normal'>
                                    Events
                                </span>
                                <div className='space-y-1'>
                                    {EVENT_OPTIONS.map((opt) => (
                                        <label
                                            key={opt.value}
                                            className='text-caption text-label flex items-center gap-2'
                                        >
                                            <input
                                                type='checkbox'
                                                checked={events.includes(
                                                    opt.value
                                                )}
                                                onChange={() =>
                                                    toggleEvent(opt.value)
                                                }
                                            />
                                            {opt.label}
                                        </label>
                                    ))}
                                </div>
                            </div>

                            {isTelegram ? (
                                <>
                                    <Input
                                        id='botToken'
                                        label='Bot token'
                                        required={!isEdit}
                                        placeholder={
                                            loaded?.configMasked.botToken ??
                                            '123456:ABC-DEF…'
                                        }
                                        hint={
                                            isEdit
                                                ? 'Leave blank to keep the current token.'
                                                : 'From @BotFather.'
                                        }
                                        value={botToken}
                                        onChange={(e) =>
                                            setBotToken(e.target.value)
                                        }
                                    />
                                    <Input
                                        id='chatId'
                                        label='Chat ID'
                                        required={!isEdit}
                                        placeholder='-1001234567890'
                                        hint='Numeric chat/channel ID the bot posts to.'
                                        value={chatId}
                                        onChange={(e) =>
                                            setChatId(e.target.value)
                                        }
                                    />
                                </>
                            ) : (
                                <>
                                    <Input
                                        id='webhookUrl'
                                        label='Webhook URL'
                                        required={!isEdit}
                                        placeholder={
                                            loaded?.configMasked.webhookUrl ??
                                            'https://…'
                                        }
                                        hint={
                                            isEdit
                                                ? 'Leave blank to keep the current URL.'
                                                : URL_HINT[provider]
                                        }
                                        value={webhookUrl}
                                        onChange={(e) =>
                                            setWebhookUrl(e.target.value)
                                        }
                                    />
                                    {provider === 'lark' && (
                                        <Input
                                            id='larkSecret'
                                            label='Signing secret (optional)'
                                            placeholder={
                                                loaded?.configMasked.larkSecret
                                                    ? '••• set'
                                                    : 'optional'
                                            }
                                            hint='Set only if your Lark custom bot has signature verification enabled.'
                                            value={larkSecret}
                                            onChange={(e) =>
                                                setLarkSecret(e.target.value)
                                            }
                                        />
                                    )}
                                </>
                            )}

                            <label className='text-caption text-label flex items-center gap-2'>
                                <input
                                    type='checkbox'
                                    checked={enabled}
                                    onChange={(e) =>
                                        setEnabled(e.target.checked)
                                    }
                                />
                                Enabled
                            </label>

                            {error && (
                                <div className='border-accent-ruby/30 bg-accent-ruby/5 rounded border px-3 py-2'>
                                    <pre className='text-caption-sm text-accent-ruby whitespace-pre-wrap'>
                                        {error}
                                    </pre>
                                </div>
                            )}

                            <Button
                                type='submit'
                                variant='primary'
                                size='md'
                                disabled={!canSubmit}
                                className='w-full'
                            >
                                {submitting
                                    ? 'Saving…'
                                    : isEdit
                                      ? 'Update webhook'
                                      : 'Create webhook'}
                            </Button>
                        </form>
                    )}
                </CardBody>
            </Card>
        </DetailPage>
    )
}

export default NotificationWebhookForm