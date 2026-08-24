import type {
    ChannelDeliverySummary,
    ChannelDetail as ChannelDetailType,
    ChannelProgressMode,
    ChannelTestResult,
    DiscordChannelConfig,
    GithubChannelConfig,
    LarkAppRegion,
    LarkChannelConfig,
    LarkRenderMode,
    LarkStreamingMode,
    LarkSubscriptionMode,
    LinearChannelConfig,
    LineChannelConfig,
    MatrixChannelConfig,
    SlackChannelConfig,
    TelegramChannelConfig,
    UpdateChannelBody,
    WeixinChannelConfig
} from '@manyfold/shared'
import type { FC, FormEvent, ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import type { SdkAgent } from '@manyfold/sdk'
import Breadcrumb from '@/components/Breadcrumb'
import {
    AgentIcon,
    ArrowLeftIcon,
    EditIcon,
    EllipsisVerticalIcon,
    ExternalLinkIcon,
    PauseIcon,
    PlayIcon,
    RefreshIcon,
    ShieldCheckIcon,
    TrashIcon,
    ZapIcon
} from '@/components/icons'
import { Ghost, SheenText } from '@/components/Loading'
import { useProductConfirm } from '@/components/ProductConfirmDialog'
import ProductDialog from '@/components/ProductDialog'
import ShortcutTooltip from '@/components/ShortcutTooltip'
import WorkbenchSelect from '@/components/WorkbenchSelect'
import { StatusTag } from '@/components/Tag'
import EmptyState from '@/components/EmptyState'
import { useApiClient } from '@/lib/apiClient'
import { ChannelProviderIcon, channelDocsHref } from '@/lib/channelMeta'
import { formatDateTime, formatTime } from '@/lib/dateFormat'
import { apiErrorMessage } from '@/lib/errorMessage'
import { useI18n } from '@/lib/i18n'
import ChannelDocsLink from './ChannelDocsLink'

const ChannelDetail: FC = (): ReactNode => {
    const { id } = useParams<{ id: string }>()
    const client = useApiClient()
    const { t } = useI18n()
    const navigate = useNavigate()
    const { confirm, confirmDialog } = useProductConfirm()
    const [channel, setChannel] = useState<ChannelDetailType | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)
    const [testResult, setTestResult] = useState<ChannelTestResult | null>(null)
    const [copied, setCopied] = useState(false)
    const [manifestCopied, setManifestCopied] = useState(false)
    const [githubOrg, setGithubOrg] = useState('')
    const [editOpen, setEditOpen] = useState(false)
    const [changeAgentOpen, setChangeAgentOpen] = useState(false)
    const [menuOpen, setMenuOpen] = useState(false)
    const menuRef = useRef<HTMLDivElement>(null)

    const refresh = async (): Promise<void> => {
        if (!id) return
        try {
            setChannel(await client.channels.get(id))
            setError(null)
        } catch (err) {
            setError(apiErrorMessage(err))
        } finally {
            setLoading(false)
        }
    }

    useEffect(() => {
        void refresh()
    }, [client, id])

    useEffect(() => {
        if (!menuOpen) return
        const onPointerDown = (event: PointerEvent): void => {
            if (!menuRef.current?.contains(event.target as Node))
                setMenuOpen(false)
        }
        const onKey = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') setMenuOpen(false)
        }
        document.addEventListener('pointerdown', onPointerDown)
        document.addEventListener('keydown', onKey)
        return () => {
            document.removeEventListener('pointerdown', onPointerDown)
            document.removeEventListener('keydown', onKey)
        }
    }, [menuOpen])

    const handleStatusToggle = async (): Promise<void> => {
        if (!channel) return
        const next = channel.status === 'active' ? 'paused' : 'active'
        setBusy(true)
        try {
            await client.channels.update(channel.id, { status: next })
            await refresh()
        } catch (err) {
            setError(apiErrorMessage(err))
        } finally {
            setBusy(false)
        }
    }

    const handleTest = async (): Promise<void> => {
        if (!channel) return
        setBusy(true)
        setTestResult(null)
        try {
            setTestResult(await client.channels.test(channel.id))
            await refresh()
        } catch (err) {
            setTestResult({ ok: false, message: (err as Error).message })
        } finally {
            setBusy(false)
        }
    }

    const handleRegister = async (): Promise<void> => {
        if (!channel) return
        setBusy(true)
        setTestResult(null)
        try {
            setTestResult(await client.channels.register(channel.id))
            await refresh()
        } catch (err) {
            setTestResult({ ok: false, message: (err as Error).message })
        } finally {
            setBusy(false)
        }
    }

    const handleDelete = async (): Promise<void> => {
        if (!channel) return
        if (
            !(await confirm({
                title: t('web.channels.settings.deleteConfirmTitle'),
                description: t('web.channels.settings.deleteConfirmDescription'),
                confirmLabel: t('web.channels.settings.delete'),
                tone: 'danger'
            }))
        ) {
            return
        }
        try {
            await client.channels.delete(channel.id)
            navigate('/settings/channels')
        } catch (err) {
            setError(apiErrorMessage(err))
        }
    }

    const copyUrl = async (): Promise<void> => {
        if (!channel) return
        await navigator.clipboard.writeText(channel.inboundUrl)
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
    }

    const copyManifest = async (): Promise<void> => {
        if (!channel) return
        try {
            const manifest = await client.channels.slackManifest(channel.id)
            await navigator.clipboard.writeText(
                JSON.stringify(manifest, null, 2)
            )
            setManifestCopied(true)
            setTimeout(() => setManifestCopied(false), 1500)
        } catch (err) {
            setError(apiErrorMessage(err))
        }
    }

    // Hands the browser to github.com: GitHub creates the app from our
    // manifest and redirects back to the API, which stores the credentials
    // and activates the channel.
    const handleCreateGithubApp = async (): Promise<void> => {
        if (!channel) return
        setBusy(true)
        try {
            const res = await client.channels.githubAppManifest(channel.id, {
                org: githubOrg.trim() || undefined
            })
            submitGithubManifestForm(res.postUrl, res.manifest)
        } catch (err) {
            setError(apiErrorMessage(err))
            setBusy(false)
        }
    }

    if (loading)
        return (
            <div className='mx-auto w-full max-w-3xl px-5 py-6 md:px-6 md:py-7'>
                <div aria-busy='true'>
                    <Ghost variant='title' className='w-44' />
                    <Ghost variant='cap' className='mt-3 w-64 max-w-full' />
                    <div className='workbench-panel mt-6 space-y-3 px-5 py-5'>
                        <Ghost variant='line' className='w-1/4' />
                        <Ghost variant='cap' className='w-3/5' />
                        <Ghost variant='cap' className='w-2/5' />
                    </div>
                </div>
            </div>
        )
    if (error)
        return (
            <div className='mx-auto w-full max-w-3xl px-5 py-6 md:px-6 md:py-7'>
                <Link to='/settings/channels' className='settings-back-link'>
                    <ArrowLeftIcon className='h-4 w-4' />
                    {t('web.channels.settings.backToChannels')}
                </Link>
                <div className='workbench-alert-error mt-4'>{error}</div>
            </div>
        )
    if (!channel) return null
    const latestDeliveryError =
        channel.recentDeliveries.find(
            (delivery) => delivery.status === 'failed' && delivery.errorMessage
        ) ?? null
    const lastErrorMessage =
        channel.lastErrorMessage ??
        (latestDeliveryError
            ? `${latestDeliveryError.errorMessage} (${formatDateTime(
                  latestDeliveryError.createdAt
              )})`
            : '—')
    const docsHref = channelDocsHref(channel.provider)

    return (
        <div className='mx-auto w-full max-w-3xl px-5 py-6 md:px-6 md:py-7'>
            <Breadcrumb
                items={[
                    {
                        label: t('web.channels.settings.channels'),
                        to: '/settings/channels'
                    },
                    { label: channel.label }
                ]}
            />

            <div className='mb-6 flex items-start justify-between gap-4'>
                <div className='flex min-w-0 flex-1 items-center gap-4'>
                    <ChannelProviderIcon
                        provider={channel.provider}
                        className='h-10 w-10 shrink-0'
                    />
                    <div className='min-w-0'>
                        <h1 className='text-h1 text-fg truncate'>
                            {channel.label}
                        </h1>
                        <p className='text-ui text-muted mt-1'>
                            {providerLabel(channel)} →{' '}
                            <Link
                                to={`/agents/${channel.agentId}`}
                                className='underline'
                            >
                                {channel.agent.name}
                            </Link>
                        </p>
                    </div>
                </div>
                <div ref={menuRef} className='relative shrink-0'>
                    <ShortcutTooltip
                        label={t('web.channels.settings.more')}
                        placement='bottom-end'
                    >
                        <button
                            type='button'
                            onClick={() => setMenuOpen((value) => !value)}
                            aria-label={t('web.channels.settings.more')}
                            aria-haspopup='menu'
                            aria-expanded={menuOpen}
                            className='text-muted hover:text-fg hover:bg-soft-hover rounded-pill flex h-9 w-9 items-center justify-center transition-colors'
                        >
                            <EllipsisVerticalIcon className='h-[18px] w-[18px]' />
                        </button>
                    </ShortcutTooltip>
                    {menuOpen && (
                        <div
                            role='menu'
                            className='popover-panel shadow-elevated bg-surface absolute right-0 top-full z-30 mt-1.5 w-52 rounded-md p-1'
                        >
                            {docsHref && (
                                <a
                                    href={docsHref}
                                    target='_blank'
                                    rel='noopener noreferrer'
                                    role='menuitem'
                                    onClick={() => setMenuOpen(false)}
                                    className={menuItemClass}
                                >
                                    <ExternalLinkIcon className='h-4 w-4 shrink-0' />
                                    <span className='min-w-0 flex-1 text-left'>
                                        {t('web.channels.settings.docs')}
                                    </span>
                                </a>
                            )}
                            <button
                                type='button'
                                role='menuitem'
                                onClick={() => {
                                    setMenuOpen(false)
                                    void refresh()
                                }}
                                className={menuItemClass}
                            >
                                <RefreshIcon className='h-4 w-4 shrink-0' />
                                <span className='min-w-0 flex-1 text-left'>
                                    {t('web.channels.settings.refresh')}
                                </span>
                            </button>
                            <button
                                type='button'
                                role='menuitem'
                                disabled={busy}
                                onClick={() => {
                                    setMenuOpen(false)
                                    setEditOpen(true)
                                }}
                                className={menuItemClass}
                            >
                                <EditIcon className='h-4 w-4 shrink-0' />
                                <span className='min-w-0 flex-1 text-left'>
                                    {t('web.channels.settings.edit')}
                                </span>
                            </button>
                            <button
                                type='button'
                                role='menuitem'
                                disabled={busy}
                                onClick={() => {
                                    setMenuOpen(false)
                                    setChangeAgentOpen(true)
                                }}
                                className={menuItemClass}
                            >
                                <AgentIcon className='h-4 w-4 shrink-0' />
                                <span className='min-w-0 flex-1 text-left'>
                                    {t('web.channels.settings.changeAgent')}
                                </span>
                            </button>
                            <button
                                type='button'
                                role='menuitem'
                                disabled={busy}
                                onClick={() => {
                                    setMenuOpen(false)
                                    void handleStatusToggle()
                                }}
                                className={menuItemClass}
                            >
                                {channel.status === 'active' ? (
                                    <PauseIcon className='h-4 w-4 shrink-0' />
                                ) : (
                                    <PlayIcon className='h-4 w-4 shrink-0' />
                                )}
                                <span className='min-w-0 flex-1 text-left'>
                                    {channel.status === 'active'
                                        ? t('web.channels.settings.pause')
                                        : t('web.channels.settings.activate')}
                                </span>
                            </button>
                            <button
                                type='button'
                                role='menuitem'
                                disabled={busy}
                                onClick={() => {
                                    setMenuOpen(false)
                                    void handleTest()
                                }}
                                className={menuItemClass}
                            >
                                <ZapIcon className='h-4 w-4 shrink-0' />
                                <span className='min-w-0 flex-1 text-left'>
                                    {t('web.channels.settings.test')}
                                </span>
                            </button>
                            {(channel.provider === 'telegram' ||
                                channel.provider === 'matrix' ||
                                channel.provider === 'weixin' ||
                                channel.provider === 'linear' ||
                                channel.provider === 'github' ||
                                channel.provider === 'line' ||
                                channel.provider === 'lark') && (
                                <ShortcutTooltip
                                    label={
                                        channel.provider === 'telegram'
                                            ? t('web.channels.settings.tooltips.reregisterTelegram')
                                            : channel.provider === 'lark'
                                              ? t('web.channels.settings.tooltips.refreshLarkIdentity')
                                              : channel.provider === 'weixin'
                                                ? t('web.channels.settings.tooltips.registerWeixin')
                                                : channel.provider === 'linear'
                                                  ? t('web.channels.settings.tooltips.registerLinear')
                                                  : channel.provider ===
                                                      'github'
                                                    ? t('web.channels.settings.tooltips.registerGithub')
                                                    : channel.provider ===
                                                        'line'
                                                      ? t('web.channels.settings.tooltips.registerLine')
                                                      : t('web.channels.settings.tooltips.registerMatrix')
                                    }
                                    className='w-full'
                                >
                                    <button
                                        type='button'
                                        role='menuitem'
                                        disabled={busy}
                                        onClick={() => {
                                            setMenuOpen(false)
                                            void handleRegister()
                                        }}
                                        className={menuItemClass}
                                    >
                                        <ShieldCheckIcon className='h-4 w-4 shrink-0' />
                                        <span className='min-w-0 flex-1 text-left'>
                                            {channel.provider === 'telegram' ||
                                            channel.provider === 'line'
                                                ? t('web.channels.settings.registerTelegram')
                                                : channel.provider === 'lark'
                                                  ? t('web.channels.settings.refreshBotIdentity')
                                                  : channel.provider ===
                                                      'github'
                                                    ? t('web.channels.settings.registerApp')
                                                    : t('web.channels.settings.registerToken')}
                                        </span>
                                    </button>
                                </ShortcutTooltip>
                            )}
                            <div className='popover-separator' />
                            <button
                                type='button'
                                role='menuitem'
                                disabled={busy}
                                onClick={() => {
                                    setMenuOpen(false)
                                    void handleDelete()
                                }}
                                className={destructiveMenuItemClass}
                            >
                                <TrashIcon className='h-4 w-4 shrink-0' />
                                <span className='min-w-0 flex-1 text-left'>
                                    {t('web.channels.settings.delete')}
                                </span>
                            </button>
                        </div>
                    )}
                </div>
            </div>

            {testResult && (
                <div
                    className={`mb-4 whitespace-pre-line ${testResult.ok ? 'workbench-alert-success' : 'workbench-alert-error'}`}
                >
                    {testResult.message}
                </div>
            )}

            {isWebhookMode(channel) ? (
                <section className='workbench-panel mb-6 px-5 py-4'>
                    <div className='workbench-kicker mb-2'>
                        {t('web.channels.settings.inboundWebhookUrl')}
                    </div>
                    <div className='flex items-center gap-2'>
                        <code className='text-ui text-fg flex-1 break-all rounded bg-gray-100 px-3 py-2'>
                            {channel.inboundUrl}
                        </code>
                        <button
                            type='button'
                            onClick={copyUrl}
                            className='workbench-button-ghost shrink-0'
                        >
                            {copied
                                ? t('common.copied')
                                : t('common.copy')}
                        </button>
                    </div>
                    <p className='text-ui text-muted mt-2'>
                        {channel.provider === 'telegram'
                            ? t('web.channels.settings.webhookHelp.telegram')
                            : channel.provider === 'slack'
                              ? t('web.channels.settings.webhookHelp.slack')
                              : channel.provider === 'lark'
                                ? t('web.channels.settings.webhookHelp.lark', {
                                      platform: larkPlatformLabel(
                                          channel.config as LarkChannelConfig
                                      )
                                  })
                                : channel.provider === 'github'
                                  ? t('web.channels.settings.webhookHelp.github')
                                  : channel.provider === 'line'
                                    ? t('web.channels.settings.webhookHelp.line')
                                    : t('web.channels.settings.webhookHelp.other')}
                    </p>
                </section>
            ) : (
                <section className='workbench-panel mb-6 px-5 py-4'>
                    <div className='workbench-kicker mb-2'>
                        {channel.provider === 'matrix'
                            ? t('web.channels.settings.connection.sync')
                            : channel.provider === 'discord'
                              ? t('web.channels.settings.connection.gateway')
                              : channel.provider === 'weixin'
                                ? t('web.channels.settings.connection.ilink')
                                : t('web.channels.settings.connection.websocket')}
                    </div>
                    <p className='text-ui text-fg'>
                        {channel.provider === 'matrix'
                            ? t('web.channels.settings.connectionHelp.matrix')
                            : channel.provider === 'discord'
                              ? t('web.channels.settings.connectionHelp.discord')
                              : channel.provider === 'weixin'
                                ? t('web.channels.settings.connectionHelp.weixin')
                                : t('web.channels.larkLongConnectionHint', {
                                      platform: larkPlatformLabel(
                                          channel.config as LarkChannelConfig
                                      )
                                  })}
                    </p>
                </section>
            )}

            {channel.provider === 'github' && (
                <section className='workbench-panel mb-6 px-5 py-4'>
                    <div className='workbench-kicker mb-2'>
                        {t('web.channels.settings.github.title')}
                    </div>
                    {githubConfigOf(channel)?.appSlug ? (
                        <>
                            <p className='text-ui text-fg'>
                                {t('web.channels.settings.github.connectedAs')}{' '}
                                <code>@{githubConfigOf(channel)?.appSlug}</code>{' '}
                                {t('web.channels.settings.github.mentionHint')}
                            </p>
                            <div className='mt-3 flex items-center gap-2'>
                                {githubConfigOf(channel)?.appHtmlUrl && (
                                    <a
                                        href={`${githubConfigOf(channel)?.appHtmlUrl}/installations/new`}
                                        target='_blank'
                                        rel='noreferrer'
                                        className='workbench-button-secondary'
                                    >
                                        {t('web.channels.settings.github.install')}
                                    </a>
                                )}
                            </div>
                            <p className='text-ui text-muted mt-2'>
                                {t('web.channels.settings.github.installHint')}
                            </p>
                        </>
                    ) : (
                        <>
                            <p className='text-ui text-muted'>
                                {t('web.channels.settings.github.createHint')}
                            </p>
                            <div className='mt-3 flex items-center gap-2'>
                                <input
                                    type='text'
                                    className='workbench-input max-w-56'
                                    value={githubOrg}
                                    onChange={(e) =>
                                        setGithubOrg(e.target.value)
                                    }
                                    placeholder={t(
                                        'web.channels.settings.placeholders.organizationOptional'
                                    )}
                                />
                                <button
                                    type='button'
                                    onClick={() => void handleCreateGithubApp()}
                                    className='workbench-button-primary shrink-0'
                                    disabled={busy}
                                >
                                    {t('web.channels.settings.github.create')}
                                </button>
                            </div>
                        </>
                    )}
                </section>
            )}

            {channel.provider === 'slack' && (
                <section className='workbench-panel mb-6 px-5 py-4'>
                    <div className='mb-2 flex items-center justify-between'>
                        <div className='workbench-kicker'>
                            {t('web.channels.settings.slack.manifest')}
                        </div>
                        <button
                            type='button'
                            onClick={copyManifest}
                            className='workbench-button-ghost shrink-0'
                        >
                            {manifestCopied
                                ? t('common.copied')
                                : t('web.channels.settings.slack.copyManifest')}
                        </button>
                    </div>
                    <p className='text-ui text-muted'>
                        {t('web.channels.settings.slack.manifestHint')}{' '}
                        <code>/new</code>{' '}
                        {t('web.channels.settings.slack.manifestHintSuffix')}
                    </p>
                </section>
            )}

            <section className='workbench-panel mb-6 px-5 py-4'>
                <div className='workbench-kicker mb-2'>
                    {t('web.channels.settings.statusLabel')}
                </div>
                <dl className='text-ui text-fg grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3'>
                    <DetailItem
                        label={t('web.channels.settings.statusLabel')}
                        value={t(
                            `web.channels.settings.status.${channel.status}`
                        )}
                    />
                    <DetailItem
                        label={t('web.channels.settings.lastConnected')}
                        value={formatDateTime(channel.lastConnectedAt)}
                    />
                    <DetailItem
                        label={t('web.channels.settings.lastError')}
                        value={lastErrorMessage}
                    />
                </dl>
            </section>

            <section className='workbench-panel px-5 py-4'>
                <div className='mb-2 flex items-center justify-between'>
                    <div className='workbench-kicker'>
                        {t('web.channels.settings.recentDeliveries')}
                    </div>
                    <span className='text-ui text-muted'>
                        {t('web.channels.settings.lastDeliveries', {
                            count: channel.recentDeliveries.length
                        })}
                    </span>
                </div>
                {channel.recentDeliveries.length === 0 ? (
                    <EmptyState
                        kind='all-clear'
                        tier='line'
                        body={t('web.emptyState.channelDeliveriesEmpty')}
                    />
                ) : (
                    <DeliveriesTable deliveries={channel.recentDeliveries} />
                )}
            </section>

            {editOpen && (
                <EditChannelDialog
                    channel={channel}
                    onClose={() => setEditOpen(false)}
                    onSaved={async () => {
                        setEditOpen(false)
                        await refresh()
                    }}
                />
            )}
            {changeAgentOpen && (
                <ChangeAgentDialog
                    channel={channel}
                    onClose={() => setChangeAgentOpen(false)}
                    onSaved={async () => {
                        setChangeAgentOpen(false)
                        await refresh()
                    }}
                />
            )}
            {confirmDialog}
        </div>
    )
}

const menuItemClass =
    'text-ui text-muted hover:text-fg hover:bg-soft flex w-full items-center gap-2.5 rounded-sm px-2.5 py-1.5 transition-colors disabled:cursor-not-allowed disabled:opacity-55'

const destructiveMenuItemClass =
    'text-ui text-error hover:bg-danger-hover flex w-full items-center gap-2.5 rounded-sm px-2.5 py-1.5 transition-colors disabled:cursor-not-allowed disabled:opacity-55'

const isWebhookMode = (channel: ChannelDetailType): boolean => {
    if (channel.provider === 'discord') return false
    if (channel.provider === 'matrix') return false
    if (channel.provider === 'weixin') return false
    if (channel.provider !== 'lark') return true
    const config = channel.config as LarkChannelConfig
    return config.subscriptionMode !== 'websocket'
}

const providerLabel = (channel: ChannelDetailType): string => {
    if (channel.provider === 'lark')
        return larkPlatformLabel(channel.config as LarkChannelConfig)
    if (channel.provider === 'telegram') return 'Telegram'
    if (channel.provider === 'slack') return 'Slack'
    if (channel.provider === 'discord') return 'Discord'
    if (channel.provider === 'matrix') return 'Matrix'
    if (channel.provider === 'weixin') return 'WeChat'
    if (channel.provider === 'linear') return 'Linear'
    if (channel.provider === 'github') return 'GitHub'
    if (channel.provider === 'line') return 'LINE'
    return 'Fake (test)'
}

// GitHub's create-app-from-manifest endpoint only accepts a real form POST,
// so the manifest rides a throwaway hidden form.
const submitGithubManifestForm = (
    postUrl: string,
    manifest: Record<string, unknown>
): void => {
    const form = document.createElement('form')
    form.method = 'POST'
    form.action = postUrl
    const input = document.createElement('input')
    input.type = 'hidden'
    input.name = 'manifest'
    input.value = JSON.stringify(manifest)
    form.appendChild(input)
    document.body.appendChild(form)
    form.submit()
}

const larkPlatformLabel = (config: LarkChannelConfig): 'Feishu' | 'Lark' =>
    config.appRegion === 'lark' ? 'Lark' : 'Feishu'

const githubConfigOf = (
    channel: ChannelDetailType
): GithubChannelConfig | null =>
    channel.provider === 'github'
        ? (channel.config as GithubChannelConfig)
        : null

const DetailItem: FC<{ label: string; value: string }> = ({ label, value }) => (
    <div>
        <dt className='text-mini text-muted'>{label}</dt>
        <dd className='text-ui text-fg break-words'>{value}</dd>
    </div>
)

const DeliveriesTable: FC<{ deliveries: ChannelDeliverySummary[] }> = ({
    deliveries
}) => {
    const { t } = useI18n()
    return (
        <div className='w-full min-w-0 overflow-hidden'>
            <table className='text-ui w-full table-fixed text-left'>
                <colgroup>
                    <col className='w-24' />
                    <col className='w-24' />
                    <col className='w-24' />
                    <col className='w-[28%]' />
                    <col />
                </colgroup>
                <thead className='text-mini text-muted'>
                    <tr>
                        <th className='py-1 pr-2'>
                            {t('web.channels.settings.delivery.when')}
                        </th>
                        <th className='py-1 pr-2'>
                            {t('web.channels.settings.delivery.direction')}
                        </th>
                        <th className='py-1 pr-2'>
                            {t('web.channels.settings.statusLabel')}
                        </th>
                        <th className='py-1 pr-2'>
                            {t('web.channels.settings.delivery.scope')}
                        </th>
                        <th className='py-1'>
                            {t('web.channels.settings.delivery.summary')}
                        </th>
                    </tr>
                </thead>
                <tbody>
                    {deliveries.map((d) => (
                        <tr key={d.id} className='border-t border-gray-100'>
                            <td className='text-mini text-muted py-1 pr-2'>
                                {formatTime(d.createdAt) ?? ''}
                            </td>
                            <td className='py-1 pr-2'>
                                {t(
                                    `web.channels.settings.deliveryDirection.${d.direction}`
                                )}
                            </td>
                            <td className='py-1 pr-2'>
                                <StatusTag
                                    tone={
                                        d.status === 'sent' ||
                                        d.status === 'accepted'
                                            ? 'success'
                                            : d.status === 'dropped'
                                              ? 'warning'
                                              : 'error'
                                    }
                                    label={t(
                                        `web.channels.settings.deliveryStatus.${d.status}`
                                    )}
                                />
                            </td>
                            <td className='text-mini text-muted break-all py-1 pr-2'>
                                {d.scopeKey}
                            </td>
                            <td className='break-words py-1'>
                                <div>{d.summaryText ?? '—'}</div>
                                {d.errorMessage && (
                                    <div className='text-mini text-workflow-ship mt-1'>
                                        {d.errorMessage}
                                    </div>
                                )}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    )
}

interface ChangeAgentDialogProps {
    channel: ChannelDetailType
    onClose: () => void
    onSaved: () => Promise<void>
}

const ChangeAgentDialog: FC<ChangeAgentDialogProps> = ({
    channel,
    onClose,
    onSaved
}): ReactNode => {
    const client = useApiClient()
    const { t } = useI18n()
    const [agents, setAgents] = useState<SdkAgent[] | null>(null)
    const [agentId, setAgentId] = useState(channel.agentId)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        let cancelled = false
        client.agents
            .list()
            .then((list) => {
                if (!cancelled) setAgents(list)
            })
            .catch((err) => {
                if (!cancelled) setError(apiErrorMessage(err))
            })
        return () => {
            cancelled = true
        }
    }, [client])

    const changed = agentId !== channel.agentId

    const handleSubmit = async (e: FormEvent): Promise<void> => {
        e.preventDefault()
        if (!changed) {
            onClose()
            return
        }
        setBusy(true)
        setError(null)
        try {
            await client.channels.update(channel.id, { agentId })
            await onSaved()
        } catch (err) {
            setError(apiErrorMessage(err))
            setBusy(false)
        }
    }

    return (
        <ProductDialog
            title={t('web.channels.settings.changeAgent')}
            description={t('web.channels.settings.changeAgentDescription')}
            onClose={onClose}
            onSubmit={handleSubmit}
            closeDisabled={busy}
            bodyClassName='space-y-4'
            footer={
                <>
                    <button
                        type='button'
                        onClick={onClose}
                        className='workbench-button-secondary'
                        disabled={busy}
                    >
                        {t('common.cancel')}
                    </button>
                    <button
                        type='submit'
                        className='workbench-button-primary'
                        disabled={busy || agents === null || !changed}
                    >
                        {busy
                            ? t('web.channels.settings.changingAgent')
                            : t('web.channels.settings.changeAgent')}
                    </button>
                </>
            }
        >
            {error && <div className='workbench-alert-error'>{error}</div>}

            <Field label={t('web.channels.settings.fields.agent')}>
                {agents === null ? (
                    <SheenText className='text-ui text-muted'>
                        {t('web.channels.settings.loadingAgents')}
                    </SheenText>
                ) : (
                    <WorkbenchSelect
                        ariaLabel={t('web.channels.settings.fields.agent')}
                        value={agentId}
                        onChange={setAgentId}
                        options={agents.map((agent) => ({
                            value: agent.id,
                            label:
                                agent.id === channel.agentId
                                    ? t('web.channels.settings.currentAgent', {
                                          name: agent.name
                                      })
                                    : agent.name
                        }))}
                    />
                )}
            </Field>

            {changed && (
                <p className='text-ui text-muted'>
                    {t('web.channels.settings.changeAgentWarning', {
                        name: channel.agent.name
                    })}
                </p>
            )}
        </ProductDialog>
    )
}

interface EditChannelDialogProps {
    channel: ChannelDetailType
    onClose: () => void
    onSaved: () => Promise<void>
}

const EditChannelDialog: FC<EditChannelDialogProps> = ({
    channel,
    onClose,
    onSaved
}): ReactNode => {
    const client = useApiClient()
    const { t } = useI18n()
    const initialLark =
        channel.provider === 'lark'
            ? (channel.config as LarkChannelConfig)
            : null
    const initialTelegram =
        channel.provider === 'telegram'
            ? (channel.config as TelegramChannelConfig)
            : null
    const initialSlack =
        channel.provider === 'slack'
            ? (channel.config as SlackChannelConfig)
            : null
    const initialDiscord =
        channel.provider === 'discord'
            ? (channel.config as DiscordChannelConfig)
            : null
    const initialMatrix =
        channel.provider === 'matrix'
            ? (channel.config as MatrixChannelConfig)
            : null
    const initialWeixin =
        channel.provider === 'weixin'
            ? (channel.config as WeixinChannelConfig)
            : null
    const initialLinear =
        channel.provider === 'linear'
            ? (channel.config as LinearChannelConfig)
            : null
    const initialGithub =
        channel.provider === 'github'
            ? (channel.config as GithubChannelConfig)
            : null
    const initialLine =
        channel.provider === 'line'
            ? (channel.config as LineChannelConfig)
            : null

    const [label, setLabel] = useState(channel.label)
    const [subscriptionMode, setSubscriptionMode] =
        useState<LarkSubscriptionMode>(
            initialLark?.subscriptionMode ?? 'webhook'
        )
    const [appRegion, setAppRegion] = useState<LarkAppRegion>(
        initialLark?.appRegion ?? 'feishu'
    )
    const [appId, setAppId] = useState(initialLark?.appId ?? '')
    const [verificationToken, setVerificationToken] = useState(
        initialLark?.verificationToken ?? ''
    )
    const [encryptKey, setEncryptKey] = useState(initialLark?.encryptKey ?? '')
    const [botName, setBotName] = useState(initialLark?.botName ?? '')
    const [larkOutboundFiles, setLarkOutboundFiles] = useState(
        initialLark?.outboundFiles !== false
    )
    const [larkRenderMode, setLarkRenderMode] = useState<LarkRenderMode>(
        initialLark?.renderMode ?? 'auto'
    )
    const [larkStreaming, setLarkStreaming] = useState<LarkStreamingMode>(
        initialLark?.streaming ?? 'patch'
    )
    const [larkHistoryBackfill, setLarkHistoryBackfill] = useState(
        initialLark?.historyBackfill !== false
    )
    const [larkHistoryBackfillLimit, setLarkHistoryBackfillLimit] = useState(
        String(initialLark?.historyBackfillLimit ?? 50)
    )
    const [larkAllowedUserIds, setLarkAllowedUserIds] = useState(
        (initialLark?.allowedUserIds ?? []).join(', ')
    )
    const [larkOperatorUserIds, setLarkOperatorUserIds] = useState(
        (initialLark?.operatorUserIds ?? []).join(', ')
    )
    const [mentionOnly, setMentionOnly] = useState(
        initialLark?.mentionOnly ??
            initialTelegram?.mentionOnly ??
            initialSlack?.mentionOnly ??
            initialDiscord?.mentionOnly ??
            initialMatrix?.mentionOnly ??
            initialLine?.mentionOnly ??
            true
    )
    const [shareSessionInChannel, setShareSessionInChannel] = useState(
        initialLark?.shareSessionInChannel ??
            initialTelegram?.shareSessionInChannel ??
            initialSlack?.shareSessionInChannel ??
            initialDiscord?.shareSessionInChannel ??
            initialMatrix?.shareSessionInChannel ??
            initialLine?.shareSessionInChannel ??
            false
    )
    const [threadIsolation, setThreadIsolation] = useState(
        initialLark?.threadIsolation ??
            initialTelegram?.threadIsolation ??
            initialSlack?.threadIsolation ??
            initialDiscord?.threadIsolation ??
            initialMatrix?.threadIsolation ??
            (channel.provider === 'lark' ? false : true)
    )
    const [progressMode, setProgressMode] = useState<ChannelProgressMode>(
        initialLark?.progressMode ??
            initialTelegram?.progressMode ??
            initialSlack?.progressMode ??
            initialDiscord?.progressMode ??
            initialMatrix?.progressMode ??
            initialGithub?.progressMode ??
            'preview'
    )
    const [contextProjection, setContextProjection] = useState(
        initialLark?.contextProjection ??
            initialTelegram?.contextProjection ??
            initialSlack?.contextProjection ??
            initialDiscord?.contextProjection ??
            initialMatrix?.contextProjection ??
            initialGithub?.contextProjection ??
            initialLine?.contextProjection ??
            true
    )
    const [appSecret, setAppSecret] = useState('')
    const [telegramBotToken, setTelegramBotToken] = useState('')
    const [telegramAllowedUserIds, setTelegramAllowedUserIds] = useState(
        (initialTelegram?.allowedUserIds ?? []).join(', ')
    )
    const [telegramOperatorUserIds, setTelegramOperatorUserIds] = useState(
        (initialTelegram?.operatorUserIds ?? []).join(', ')
    )
    const [telegramAllowedChatIds, setTelegramAllowedChatIds] = useState(
        (initialTelegram?.allowedChatIds ?? []).join(', ')
    )
    const [telegramAckReaction, setTelegramAckReaction] = useState(
        initialTelegram?.ackReaction ?? false
    )
    const [telegramFreshFinal, setTelegramFreshFinal] = useState(
        initialTelegram?.finalMessageMode === 'fresh'
    )
    const [telegramReplyHud, setTelegramReplyHud] = useState(
        initialTelegram?.replyHud ?? false
    )
    const [linearClientId, setLinearClientId] = useState('')
    const [linearClientSecret, setLinearClientSecret] = useState('')
    const [linearWebhookSecret, setLinearWebhookSecret] = useState('')
    const [linearAccessToken, setLinearAccessToken] = useState('')
    const [linearAllowedUserIds, setLinearAllowedUserIds] = useState(
        (initialLinear?.allowedUserIds ?? []).join(', ')
    )
    // Linear has no message-edit API, so it offers Activity or Final only.
    const [linearProgressMode, setLinearProgressMode] = useState<
        'activity' | 'final'
    >(initialLinear?.progressMode === 'final' ? 'final' : 'activity')
    const [githubAppId, setGithubAppId] = useState('')
    const [githubPrivateKey, setGithubPrivateKey] = useState('')
    const [githubWebhookSecret, setGithubWebhookSecret] = useState('')
    const [githubAllowedRepos, setGithubAllowedRepos] = useState(
        (initialGithub?.allowedRepos ?? []).join(', ')
    )
    const [githubAllowedUserIds, setGithubAllowedUserIds] = useState(
        (initialGithub?.allowedUserIds ?? []).join(', ')
    )
    const [githubOperatorUserIds, setGithubOperatorUserIds] = useState(
        (initialGithub?.operatorUserIds ?? []).join(', ')
    )
    const [githubAllowedAssociations, setGithubAllowedAssociations] = useState(
        (initialGithub?.allowedAssociations ?? []).join(', ')
    )
    const [githubTriggerLabel, setGithubTriggerLabel] = useState(
        initialGithub?.triggerLabel ?? ''
    )
    const [githubFreshFinal, setGithubFreshFinal] = useState(
        initialGithub?.finalMessageMode === 'fresh'
    )
    const [slackBotToken, setSlackBotToken] = useState('')
    const [slackSigningSecret, setSlackSigningSecret] = useState('')
    const [slackAllowedUserIds, setSlackAllowedUserIds] = useState(
        (initialSlack?.allowedUserIds ?? []).join(', ')
    )
    const [slackOperatorUserIds, setSlackOperatorUserIds] = useState(
        (initialSlack?.operatorUserIds ?? []).join(', ')
    )
    const [slackOutboundFiles, setSlackOutboundFiles] = useState(
        initialSlack?.outboundFiles !== false
    )
    const [slackAutoThread, setSlackAutoThread] = useState(
        initialSlack?.autoThread ?? false
    )
    const [discordBotToken, setDiscordBotToken] = useState('')
    const [discordAllowedGuildIds, setDiscordAllowedGuildIds] = useState(
        (initialDiscord?.allowedGuildIds ?? []).join(', ')
    )
    const [discordAutoThread, setDiscordAutoThread] = useState(
        initialDiscord?.autoThread ?? false
    )
    const [discordFreshFinal, setDiscordFreshFinal] = useState(
        initialDiscord?.finalMessageMode === 'fresh'
    )
    const [discordReplyHud, setDiscordReplyHud] = useState(
        initialDiscord?.replyHud ?? false
    )
    const [discordOutboundFiles, setDiscordOutboundFiles] = useState(
        initialDiscord?.outboundFiles !== false
    )
    const [discordHistoryBackfill, setDiscordHistoryBackfill] = useState(
        initialDiscord?.historyBackfill !== false
    )
    const [discordHistoryBackfillLimit, setDiscordHistoryBackfillLimit] =
        useState(String(initialDiscord?.historyBackfillLimit ?? 50))
    const [matrixHomeserver, setMatrixHomeserver] = useState(
        initialMatrix?.homeserver ?? ''
    )
    const [matrixAccessToken, setMatrixAccessToken] = useState('')
    const [matrixAllowedRoomIds, setMatrixAllowedRoomIds] = useState(
        (initialMatrix?.allowedRoomIds ?? []).join(', ')
    )
    const [matrixAllowedUserIds, setMatrixAllowedUserIds] = useState(
        (initialMatrix?.allowedUserIds ?? []).join(', ')
    )
    const [matrixOperatorUserIds, setMatrixOperatorUserIds] = useState(
        (initialMatrix?.operatorUserIds ?? []).join(', ')
    )
    const [matrixFreeResponseRoomIds, setMatrixFreeResponseRoomIds] = useState(
        (initialMatrix?.freeResponseRoomIds ?? []).join(', ')
    )
    const [matrixAutoJoin, setMatrixAutoJoin] = useState(
        initialMatrix?.autoJoin ?? true
    )
    const [matrixAutoThread, setMatrixAutoThread] = useState(
        initialMatrix?.autoThread ?? true
    )
    const [matrixOutboundFiles, setMatrixOutboundFiles] = useState(
        initialMatrix?.outboundFiles !== false
    )
    const [matrixHistoryBackfill, setMatrixHistoryBackfill] = useState(
        initialMatrix?.historyBackfill !== false
    )
    const [matrixHistoryBackfillLimit, setMatrixHistoryBackfillLimit] =
        useState(String(initialMatrix?.historyBackfillLimit ?? 50))
    const [weixinBotToken, setWeixinBotToken] = useState('')
    const [weixinAllowedUserIds, setWeixinAllowedUserIds] = useState(
        (initialWeixin?.allowedUserIds ?? []).join(', ')
    )
    const [weixinOperatorUserIds, setWeixinOperatorUserIds] = useState(
        (initialWeixin?.operatorUserIds ?? []).join(', ')
    )
    const [weixinOutboundFiles, setWeixinOutboundFiles] = useState(
        initialWeixin?.outboundFiles !== false
    )
    const [lineChannelSecret, setLineChannelSecret] = useState('')
    const [lineChannelAccessToken, setLineChannelAccessToken] = useState('')
    const [lineAllowedUserIds, setLineAllowedUserIds] = useState(
        (initialLine?.allowedUserIds ?? []).join(', ')
    )
    const [lineOperatorUserIds, setLineOperatorUserIds] = useState(
        (initialLine?.operatorUserIds ?? []).join(', ')
    )
    const [lineAllowedChatIds, setLineAllowedChatIds] = useState(
        (initialLine?.allowedChatIds ?? []).join(', ')
    )
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const handleSubmit = async (e: FormEvent): Promise<void> => {
        e.preventDefault()
        setBusy(true)
        setError(null)
        try {
            const body: UpdateChannelBody = {}
            if (label.trim() !== channel.label) body.label = label.trim()
            if (channel.provider === 'lark') {
                if (
                    subscriptionMode === 'webhook' &&
                    !verificationToken.trim() &&
                    !encryptKey.trim()
                )
                    throw new Error(
                        t('web.channels.settings.errors.larkWebhookCredentials')
                    )
                const nextConfig: LarkChannelConfig = {
                    appId: appId.trim(),
                    appRegion,
                    subscriptionMode,
                    verificationToken: verificationToken.trim() || null,
                    encryptKey: encryptKey.trim() || null,
                    mentionOnly,
                    shareSessionInChannel,
                    threadIsolation,
                    progressMode,
                    contextProjection,
                    resetOnIdleMins: initialLark?.resetOnIdleMins ?? null,
                    botName: botName.trim() || null,
                    botOpenId: initialLark?.botOpenId ?? null,
                    outboundFiles: larkOutboundFiles,
                    renderMode: larkRenderMode,
                    streaming: larkStreaming,
                    historyBackfill: larkHistoryBackfill,
                    historyBackfillLimit: clampHistoryLimit(
                        larkHistoryBackfillLimit
                    ),
                    allowedUserIds: commaList(larkAllowedUserIds),
                    operatorUserIds: commaList(larkOperatorUserIds)
                }
                body.config = nextConfig
                if (appSecret.trim()) {
                    body.credentials = { appSecret: appSecret.trim() }
                }
            } else if (channel.provider === 'telegram') {
                const nextConfig: TelegramChannelConfig = {
                    botUsername: initialTelegram?.botUsername ?? null,
                    allowedUserIds: commaList(telegramAllowedUserIds),
                    operatorUserIds: commaList(telegramOperatorUserIds),
                    allowedChatIds: commaList(telegramAllowedChatIds),
                    mentionOnly,
                    shareSessionInChannel,
                    threadIsolation,
                    progressMode,
                    finalMessageMode: telegramFreshFinal ? 'fresh' : 'edit',
                    replyHud: telegramReplyHud,
                    ackReaction: telegramAckReaction,
                    contextProjection,
                    resetOnIdleMins: initialTelegram?.resetOnIdleMins ?? null
                }
                body.config = nextConfig
                if (telegramBotToken.trim()) {
                    body.credentials = {
                        botToken: telegramBotToken.trim(),
                        webhookSecret: null
                    }
                }
            } else if (channel.provider === 'slack') {
                const hasBotToken = slackBotToken.trim().length > 0
                const hasSigningSecret = slackSigningSecret.trim().length > 0
                if (hasBotToken !== hasSigningSecret)
                    throw new Error(
                        t('web.channels.settings.errors.slackCredentials')
                    )
                const nextConfig: SlackChannelConfig = {
                    botUserId: initialSlack?.botUserId ?? null,
                    teamId: initialSlack?.teamId ?? null,
                    allowedUserIds: commaList(slackAllowedUserIds),
                    operatorUserIds: commaList(slackOperatorUserIds),
                    mentionOnly,
                    shareSessionInChannel,
                    threadIsolation,
                    autoThread: slackAutoThread,
                    progressMode,
                    outboundFiles: slackOutboundFiles,
                    contextProjection
                }
                body.config = nextConfig
                if (hasBotToken && hasSigningSecret) {
                    body.credentials = {
                        botToken: slackBotToken.trim(),
                        signingSecret: slackSigningSecret.trim()
                    }
                }
            } else if (channel.provider === 'discord') {
                const allowedGuildIds = discordAllowedGuildIds
                    .split(',')
                    .map((s) => s.trim())
                    .filter((s) => s.length > 0)
                const nextConfig: DiscordChannelConfig = {
                    botUserId: initialDiscord?.botUserId ?? null,
                    botName: initialDiscord?.botName ?? null,
                    applicationId: initialDiscord?.applicationId ?? null,
                    allowedGuildIds,
                    mentionOnly,
                    shareSessionInChannel,
                    threadIsolation,
                    autoThread: discordAutoThread,
                    progressMode,
                    finalMessageMode: discordFreshFinal ? 'fresh' : 'edit',
                    replyHud: discordReplyHud,
                    outboundFiles: discordOutboundFiles,
                    historyBackfill: discordHistoryBackfill,
                    historyBackfillLimit: clampHistoryLimit(
                        discordHistoryBackfillLimit
                    ),
                    contextProjection
                }
                body.config = nextConfig
                if (discordBotToken.trim())
                    body.credentials = {
                        botToken: discordBotToken.trim()
                    }
            } else if (channel.provider === 'matrix') {
                if (!matrixHomeserver.trim())
                    throw new Error(
                        t('web.channels.settings.errors.matrixHomeserver')
                    )
                const nextConfig: MatrixChannelConfig = {
                    homeserver: matrixHomeserver.trim(),
                    botUserId: initialMatrix?.botUserId ?? null,
                    botDisplayName: initialMatrix?.botDisplayName ?? null,
                    allowedRoomIds: commaList(matrixAllowedRoomIds),
                    allowedUserIds: commaList(matrixAllowedUserIds),
                    operatorUserIds: commaList(matrixOperatorUserIds),
                    freeResponseRoomIds: commaList(matrixFreeResponseRoomIds),
                    autoJoin: matrixAutoJoin,
                    mentionOnly,
                    shareSessionInChannel,
                    threadIsolation,
                    autoThread: matrixAutoThread,
                    progressMode,
                    outboundFiles: matrixOutboundFiles,
                    historyBackfill: matrixHistoryBackfill,
                    historyBackfillLimit: clampHistoryLimit(
                        matrixHistoryBackfillLimit
                    ),
                    contextProjection
                }
                body.config = nextConfig
                if (matrixAccessToken.trim()) {
                    body.credentials = {
                        accessToken: matrixAccessToken.trim()
                    }
                }
            } else if (channel.provider === 'weixin') {
                const nextConfig: WeixinChannelConfig = {
                    botId: initialWeixin?.botId ?? null,
                    allowedUserIds: commaList(weixinAllowedUserIds),
                    operatorUserIds: commaList(weixinOperatorUserIds),
                    progressMode,
                    outboundFiles: weixinOutboundFiles,
                    contextProjection,
                    resetOnIdleMins: initialWeixin?.resetOnIdleMins ?? null
                }
                body.config = nextConfig
                if (weixinBotToken.trim()) {
                    body.credentials = {
                        botToken: weixinBotToken.trim(),
                        baseUrl: null
                    }
                }
            } else if (channel.provider === 'linear') {
                const clientId = linearClientId.trim()
                const clientSecret = linearClientSecret.trim()
                const accessToken = linearAccessToken.trim()
                const webhookSecret = linearWebhookSecret.trim()
                const rotating =
                    clientId.length > 0 ||
                    clientSecret.length > 0 ||
                    accessToken.length > 0 ||
                    webhookSecret.length > 0
                // An update replaces the whole credentials blob, so a partial
                // rotation would drop the fields left blank.
                if (
                    rotating &&
                    (webhookSecret.length === 0 ||
                        (!accessToken && !(clientId && clientSecret)))
                )
                    throw new Error(
                        t('web.channels.settings.errors.linearRotation')
                    )
                const nextConfig: LinearChannelConfig = {
                    appUserId: initialLinear?.appUserId ?? null,
                    organizationId: initialLinear?.organizationId ?? null,
                    workspaceUrlKey: initialLinear?.workspaceUrlKey ?? null,
                    allowedUserIds: commaList(linearAllowedUserIds),
                    progressMode: linearProgressMode,
                    contextProjection
                }
                body.config = nextConfig
                if (rotating)
                    body.credentials = {
                        webhookSecret,
                        ...(clientId ? { clientId } : {}),
                        ...(clientSecret ? { clientSecret } : {}),
                        ...(accessToken ? { accessToken } : {})
                    }
            } else if (channel.provider === 'github') {
                const appIdNext = githubAppId.trim()
                const privateKeyNext = githubPrivateKey.trim()
                const webhookSecretNext = githubWebhookSecret.trim()
                const rotating =
                    appIdNext.length > 0 ||
                    privateKeyNext.length > 0 ||
                    webhookSecretNext.length > 0
                // An update replaces the whole credentials blob, so a partial
                // rotation would drop the fields left blank.
                if (
                    rotating &&
                    (!appIdNext || !privateKeyNext || !webhookSecretNext)
                )
                    throw new Error(
                        t('web.channels.settings.errors.githubRotation')
                    )
                const nextConfig: GithubChannelConfig = {
                    appSlug: initialGithub?.appSlug ?? null,
                    botLogin: initialGithub?.botLogin ?? null,
                    appHtmlUrl: initialGithub?.appHtmlUrl ?? null,
                    allowedRepos: commaList(githubAllowedRepos),
                    allowedUserIds: commaList(githubAllowedUserIds),
                    operatorUserIds: commaList(githubOperatorUserIds),
                    allowedAssociations: commaList(githubAllowedAssociations),
                    triggerLabel: githubTriggerLabel.trim() || null,
                    progressMode,
                    finalMessageMode: githubFreshFinal ? 'fresh' : 'edit',
                    historyBackfill: initialGithub?.historyBackfill !== false,
                    historyBackfillLimit:
                        initialGithub?.historyBackfillLimit ?? 50,
                    contextProjection
                }
                body.config = nextConfig
                if (rotating)
                    body.credentials = {
                        appId: appIdNext,
                        privateKey: privateKeyNext,
                        webhookSecret: webhookSecretNext
                    }
            } else if (channel.provider === 'line') {
                const channelSecretNext = lineChannelSecret.trim()
                const accessTokenNext = lineChannelAccessToken.trim()
                const rotating =
                    channelSecretNext.length > 0 || accessTokenNext.length > 0
                // An update replaces the whole credentials blob, so a partial
                // rotation would drop the field left blank.
                if (rotating && (!channelSecretNext || !accessTokenNext))
                    throw new Error(
                        t('web.channels.settings.errors.lineRotation')
                    )
                const nextConfig: LineChannelConfig = {
                    botUserId: initialLine?.botUserId ?? null,
                    basicId: initialLine?.basicId ?? null,
                    botDisplayName: initialLine?.botDisplayName ?? null,
                    allowedUserIds: commaList(lineAllowedUserIds),
                    operatorUserIds: commaList(lineOperatorUserIds),
                    allowedChatIds: commaList(lineAllowedChatIds),
                    mentionOnly,
                    shareSessionInChannel,
                    progressMode: 'final',
                    contextProjection,
                    resetOnIdleMins: initialLine?.resetOnIdleMins ?? null
                }
                body.config = nextConfig
                if (rotating)
                    body.credentials = {
                        channelSecret: channelSecretNext,
                        channelAccessToken: accessTokenNext
                    }
            } else if (channel.provider === 'fake') {
                body.config = { note: null }
            }
            if (Object.keys(body).length === 0) {
                onClose()
                return
            }
            await client.channels.update(channel.id, body)
            await onSaved()
        } catch (err) {
            setError(apiErrorMessage(err))
        } finally {
            setBusy(false)
        }
    }

    return (
        <ProductDialog
            title={t('web.channels.settings.editChannel')}
            description={t('web.channels.settings.editDescription')}
            onClose={onClose}
            onSubmit={handleSubmit}
            closeDisabled={busy}
            bodyClassName='space-y-4'
            headerAccessory={<ChannelDocsLink provider={channel.provider} />}
            footer={
                <>
                    <button
                        type='button'
                        onClick={onClose}
                        className='workbench-button-secondary'
                        disabled={busy}
                    >
                        {t('common.cancel')}
                    </button>
                    <button
                        type='submit'
                        className='workbench-button-primary'
                        disabled={busy}
                    >
                        {busy ? t('common.saving') : t('common.save')}
                    </button>
                </>
            }
        >
            {error && <div className='workbench-alert-error'>{error}</div>}

            <Field label={t('web.channels.settings.fields.label')}>
                <input
                    type='text'
                    className='workbench-input'
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    required
                />
            </Field>

            {channel.provider === 'lark' && (
                <>
                    <Field label={t('web.channels.settings.fields.provider')}>
                        <WorkbenchSelect
                            ariaLabel={t('web.channels.settings.fields.provider')}
                            value={appRegion}
                            onChange={(next) =>
                                setAppRegion(next as LarkAppRegion)
                            }
                            options={[
                                { value: 'feishu', label: 'Feishu' },
                                { value: 'lark', label: 'Lark' }
                            ]}
                        />
                    </Field>
                    <Field label={t('web.channels.settings.fields.subscriptionMode')}>
                        <WorkbenchSelect
                            ariaLabel={t('web.channels.settings.fields.subscriptionMode')}
                            value={subscriptionMode}
                            onChange={(next) =>
                                setSubscriptionMode(
                                    next as LarkSubscriptionMode
                                )
                            }
                            options={[
                                {
                                    value: 'webhook',
                                    label: t('web.channels.settings.options.webhook')
                                },
                                {
                                    value: 'websocket',
                                    label: t('web.channels.settings.options.websocket')
                                }
                            ]}
                        />
                    </Field>
                    <Field label={t('web.channels.settings.fields.appId')}>
                        <input
                            type='text'
                            className='workbench-input'
                            value={appId}
                            onChange={(e) => setAppId(e.target.value)}
                            required
                        />
                    </Field>
                    <Field label={t('web.channels.settings.fields.appSecretKeep')}>
                        <input
                            type='password'
                            className='workbench-input'
                            value={appSecret}
                            onChange={(e) => setAppSecret(e.target.value)}
                            placeholder='••••••••••'
                            autoComplete='new-password'
                        />
                    </Field>
                    <Field label={t('web.channels.settings.fields.verificationToken')}>
                        <input
                            type='text'
                            className='workbench-input'
                            value={verificationToken}
                            onChange={(e) =>
                                setVerificationToken(e.target.value)
                            }
                            required={
                                subscriptionMode === 'webhook' &&
                                encryptKey.trim().length === 0
                            }
                        />
                    </Field>
                    <Field label={t('web.channels.settings.fields.encryptKey')}>
                        <input
                            type='text'
                            className='workbench-input'
                            value={encryptKey}
                            onChange={(e) => setEncryptKey(e.target.value)}
                            required={
                                subscriptionMode === 'webhook' &&
                                verificationToken.trim().length === 0
                            }
                        />
                    </Field>
                    <Field label={t('web.channels.settings.fields.botName')}>
                        <input
                            type='text'
                            className='workbench-input'
                            value={botName}
                            onChange={(e) => setBotName(e.target.value)}
                        />
                    </Field>
                    <Field label={t('web.channels.settings.fields.allowedOpenIdsOptional')}>
                        <input
                            type='text'
                            className='workbench-input'
                            value={larkAllowedUserIds}
                            onChange={(e) =>
                                setLarkAllowedUserIds(e.target.value)
                            }
                            placeholder='ou_xxxx, ou_yyyy'
                        />
                    </Field>
                    <Field label={t('web.channels.settings.fields.operatorOpenIdsOptional')}>
                        <input
                            type='text'
                            className='workbench-input'
                            value={larkOperatorUserIds}
                            onChange={(e) =>
                                setLarkOperatorUserIds(e.target.value)
                            }
                            placeholder='ou_xxxx'
                        />
                    </Field>
                    <BehaviorFields
                        mentionOnly={mentionOnly}
                        setMentionOnly={setMentionOnly}
                        shareSessionInChannel={shareSessionInChannel}
                        setShareSessionInChannel={setShareSessionInChannel}
                        threadIsolation={threadIsolation}
                        setThreadIsolation={setThreadIsolation}
                        progressMode={progressMode}
                        setProgressMode={setProgressMode}
                        contextProjection={contextProjection}
                        setContextProjection={setContextProjection}
                        threadLabel={t('web.channels.settings.threadLabels.lark')}
                    />
                    <Field label={t('web.channels.settings.fields.replyRendering')}>
                        <WorkbenchSelect
                            ariaLabel={t('web.channels.settings.fields.replyRendering')}
                            value={larkRenderMode}
                            onChange={(next) =>
                                setLarkRenderMode(next as LarkRenderMode)
                            }
                            options={[
                                {
                                    value: 'auto',
                                    label: t('web.channels.settings.options.renderAuto')
                                },
                                {
                                    value: 'text',
                                    label: t('web.channels.settings.options.renderText')
                                },
                                {
                                    value: 'card',
                                    label: t('web.channels.settings.options.renderCard')
                                }
                            ]}
                        />
                    </Field>
                    <Field label={t('web.channels.settings.fields.streamingUpdates')}>
                        <WorkbenchSelect
                            ariaLabel={t('web.channels.settings.fields.streamingUpdates')}
                            value={larkStreaming}
                            onChange={(next) =>
                                setLarkStreaming(next as LarkStreamingMode)
                            }
                            options={[
                                {
                                    value: 'patch',
                                    label: t('web.channels.settings.options.streamingPatch')
                                },
                                {
                                    value: 'cardkit',
                                    label: t('web.channels.settings.options.streamingCardkit')
                                }
                            ]}
                        />
                    </Field>
                    <CheckboxField
                        label={t('web.channels.settings.behaviors.attachFiles')}
                        description={t('web.channels.settings.behaviors.attachFilesLarkDescription')}
                        checked={larkOutboundFiles}
                        onChange={setLarkOutboundFiles}
                    />
                    <CheckboxField
                        label={t('web.channels.settings.behaviors.backfillChat')}
                        description={t('web.channels.settings.behaviors.backfillChatDescription')}
                        checked={larkHistoryBackfill}
                        onChange={setLarkHistoryBackfill}
                    />
                    {larkHistoryBackfill && (
                        <Field label={t('web.channels.settings.fields.historyBackfillLimit')}>
                            <input
                                type='number'
                                min={1}
                                max={100}
                                className='workbench-input'
                                value={larkHistoryBackfillLimit}
                                onChange={(e) =>
                                    setLarkHistoryBackfillLimit(e.target.value)
                                }
                            />
                        </Field>
                    )}
                </>
            )}

            {channel.provider === 'telegram' && (
                <>
                    <Field label={t('web.channels.settings.fields.botTokenKeep')}>
                        <input
                            type='password'
                            className='workbench-input'
                            value={telegramBotToken}
                            onChange={(e) =>
                                setTelegramBotToken(e.target.value)
                            }
                            placeholder='123456789:AAH...'
                            autoComplete='new-password'
                        />
                    </Field>
                    <Field label={t('web.channels.settings.fields.allowedUserIdsOptional')}>
                        <input
                            type='text'
                            className='workbench-input'
                            value={telegramAllowedUserIds}
                            onChange={(e) =>
                                setTelegramAllowedUserIds(e.target.value)
                            }
                            placeholder='123456789, 987654321'
                        />
                    </Field>
                    <Field label={t('web.channels.settings.fields.operatorUserIdsOptional')}>
                        <input
                            type='text'
                            className='workbench-input'
                            value={telegramOperatorUserIds}
                            onChange={(e) =>
                                setTelegramOperatorUserIds(e.target.value)
                            }
                            placeholder='123456789'
                        />
                    </Field>
                    <Field label={t('web.channels.settings.fields.allowedGroupChatIdsOptional')}>
                        <input
                            type='text'
                            className='workbench-input'
                            value={telegramAllowedChatIds}
                            onChange={(e) =>
                                setTelegramAllowedChatIds(e.target.value)
                            }
                            placeholder='-1001234567890, -1009876543210'
                        />
                    </Field>
                    <p className='text-ui text-muted -mt-2'>
                        {t('web.channels.settings.help.telegramEdit')}
                    </p>
                    <CheckboxField
                        label={t('web.channels.settings.behaviors.ackReaction')}
                        description={t('web.channels.settings.behaviors.ackReactionDescription')}
                        checked={telegramAckReaction}
                        onChange={setTelegramAckReaction}
                    />
                    <CheckboxField
                        label={t('web.channels.settings.behaviors.finalNewMessage')}
                        description={t('web.channels.settings.behaviors.finalNewMessageTelegramDescription')}
                        checked={telegramFreshFinal}
                        onChange={setTelegramFreshFinal}
                    />
                    <CheckboxField
                        label={t('web.channels.settings.behaviors.usageFooter')}
                        description={t('web.channels.settings.behaviors.usageFooterDescription')}
                        checked={telegramReplyHud}
                        onChange={setTelegramReplyHud}
                    />
                    <BehaviorFields
                        mentionOnly={mentionOnly}
                        setMentionOnly={setMentionOnly}
                        shareSessionInChannel={shareSessionInChannel}
                        setShareSessionInChannel={setShareSessionInChannel}
                        threadIsolation={threadIsolation}
                        setThreadIsolation={setThreadIsolation}
                        progressMode={progressMode}
                        setProgressMode={setProgressMode}
                        contextProjection={contextProjection}
                        setContextProjection={setContextProjection}
                        threadLabel={t('web.channels.settings.threadLabels.telegram')}
                    />
                </>
            )}

            {channel.provider === 'slack' && (
                <>
                    <Field label={t('web.channels.settings.fields.botTokenKeep')}>
                        <input
                            type='password'
                            className='workbench-input'
                            value={slackBotToken}
                            onChange={(e) => setSlackBotToken(e.target.value)}
                            placeholder='xoxb-...'
                            autoComplete='new-password'
                        />
                    </Field>
                    <Field label={t('web.channels.settings.fields.signingSecretKeep')}>
                        <input
                            type='password'
                            className='workbench-input'
                            value={slackSigningSecret}
                            onChange={(e) =>
                                setSlackSigningSecret(e.target.value)
                            }
                            autoComplete='new-password'
                        />
                    </Field>
                    <Field label={t('web.channels.settings.fields.allowedUserIdsOptional')}>
                        <input
                            type='text'
                            className='workbench-input'
                            value={slackAllowedUserIds}
                            onChange={(e) =>
                                setSlackAllowedUserIds(e.target.value)
                            }
                            placeholder='U01ABCDEF, U02GHIJKL'
                        />
                    </Field>
                    <Field label={t('web.channels.settings.fields.operatorUserIdsOptional')}>
                        <input
                            type='text'
                            className='workbench-input'
                            value={slackOperatorUserIds}
                            onChange={(e) =>
                                setSlackOperatorUserIds(e.target.value)
                            }
                            placeholder='U01ABCDEF'
                        />
                    </Field>
                    <p className='text-ui text-muted -mt-2'>
                        {t('web.channels.settings.help.slackEdit')}
                    </p>
                    <BehaviorFields
                        mentionOnly={mentionOnly}
                        setMentionOnly={setMentionOnly}
                        shareSessionInChannel={shareSessionInChannel}
                        setShareSessionInChannel={setShareSessionInChannel}
                        threadIsolation={threadIsolation}
                        setThreadIsolation={setThreadIsolation}
                        progressMode={progressMode}
                        setProgressMode={setProgressMode}
                        contextProjection={contextProjection}
                        setContextProjection={setContextProjection}
                        threadLabel={t('web.channels.settings.threadLabels.slack')}
                    />
                    <CheckboxField
                        label={t('web.channels.settings.behaviors.autoThreadChannel')}
                        description={t('web.channels.settings.behaviors.autoThreadChannelDescription')}
                        checked={slackAutoThread}
                        onChange={setSlackAutoThread}
                    />
                    <CheckboxField
                        label={t('web.channels.settings.behaviors.attachFiles')}
                        description={t('web.channels.settings.behaviors.attachFilesSlackDescription')}
                        checked={slackOutboundFiles}
                        onChange={setSlackOutboundFiles}
                    />
                </>
            )}

            {channel.provider === 'discord' && (
                <>
                    <Field label={t('web.channels.settings.fields.botTokenKeep')}>
                        <input
                            type='password'
                            className='workbench-input'
                            value={discordBotToken}
                            onChange={(e) => setDiscordBotToken(e.target.value)}
                            placeholder='MTk...'
                            autoComplete='new-password'
                        />
                    </Field>
                    <Field label={t('web.channels.settings.fields.allowedGuildIds')}>
                        <input
                            type='text'
                            className='workbench-input'
                            value={discordAllowedGuildIds}
                            onChange={(e) =>
                                setDiscordAllowedGuildIds(e.target.value)
                            }
                            placeholder='123456789012345678, ...'
                        />
                    </Field>
                    <BehaviorFields
                        mentionOnly={mentionOnly}
                        setMentionOnly={setMentionOnly}
                        shareSessionInChannel={shareSessionInChannel}
                        setShareSessionInChannel={setShareSessionInChannel}
                        threadIsolation={threadIsolation}
                        setThreadIsolation={setThreadIsolation}
                        progressMode={progressMode}
                        setProgressMode={setProgressMode}
                        contextProjection={contextProjection}
                        setContextProjection={setContextProjection}
                        threadLabel={t('web.channels.settings.threadLabels.discord')}
                    />
                    <CheckboxField
                        label={t('web.channels.settings.behaviors.autoThreadServer')}
                        description={t('web.channels.settings.behaviors.autoThreadServerDescription')}
                        checked={discordAutoThread}
                        onChange={setDiscordAutoThread}
                    />
                    <CheckboxField
                        label={t('web.channels.settings.behaviors.finalNewMessage')}
                        description={t('web.channels.settings.behaviors.finalNewMessageDiscordDescription')}
                        checked={discordFreshFinal}
                        onChange={setDiscordFreshFinal}
                    />
                    <CheckboxField
                        label={t('web.channels.settings.behaviors.usageFooter')}
                        description={t('web.channels.settings.behaviors.usageFooterDescription')}
                        checked={discordReplyHud}
                        onChange={setDiscordReplyHud}
                    />
                    <CheckboxField
                        label={t('web.channels.settings.behaviors.attachFiles')}
                        description={t('web.channels.settings.behaviors.attachFilesDiscordDescription')}
                        checked={discordOutboundFiles}
                        onChange={setDiscordOutboundFiles}
                    />
                    <CheckboxField
                        label={t('web.channels.settings.behaviors.backfillChannel')}
                        description={t('web.channels.settings.behaviors.backfillChannelDescription')}
                        checked={discordHistoryBackfill}
                        onChange={setDiscordHistoryBackfill}
                    />
                    {discordHistoryBackfill && (
                        <Field label={t('web.channels.settings.fields.historyBackfillLimit')}>
                            <input
                                type='number'
                                min={1}
                                max={100}
                                className='workbench-input'
                                value={discordHistoryBackfillLimit}
                                onChange={(e) =>
                                    setDiscordHistoryBackfillLimit(
                                        e.target.value
                                    )
                                }
                            />
                        </Field>
                    )}
                </>
            )}

            {channel.provider === 'matrix' && (
                <>
                    <Field label={t('web.channels.settings.fields.homeserverUrl')}>
                        <input
                            type='url'
                            className='workbench-input'
                            value={matrixHomeserver}
                            onChange={(e) =>
                                setMatrixHomeserver(e.target.value)
                            }
                            placeholder='https://matrix.example.org'
                            required
                        />
                    </Field>
                    <Field label={t('web.channels.settings.fields.accessTokenKeep')}>
                        <input
                            type='password'
                            className='workbench-input'
                            value={matrixAccessToken}
                            onChange={(e) =>
                                setMatrixAccessToken(e.target.value)
                            }
                            autoComplete='new-password'
                        />
                    </Field>
                    <Field label={t('web.channels.settings.fields.allowedRoomIds')}>
                        <input
                            type='text'
                            className='workbench-input'
                            value={matrixAllowedRoomIds}
                            onChange={(e) =>
                                setMatrixAllowedRoomIds(e.target.value)
                            }
                            placeholder='!roomid:matrix.example.org, ...'
                        />
                    </Field>
                    <Field label={t('web.channels.settings.fields.allowedUserIds')}>
                        <input
                            type='text'
                            className='workbench-input'
                            value={matrixAllowedUserIds}
                            onChange={(e) =>
                                setMatrixAllowedUserIds(e.target.value)
                            }
                            placeholder='@alice:matrix.example.org, ...'
                        />
                    </Field>
                    <Field label={t('web.channels.settings.fields.operatorUserIds')}>
                        <input
                            type='text'
                            className='workbench-input'
                            value={matrixOperatorUserIds}
                            onChange={(e) =>
                                setMatrixOperatorUserIds(e.target.value)
                            }
                            placeholder='@operator:matrix.example.org, ...'
                        />
                    </Field>
                    <Field label={t('web.channels.settings.fields.freeResponseRoomIds')}>
                        <input
                            type='text'
                            className='workbench-input'
                            value={matrixFreeResponseRoomIds}
                            onChange={(e) =>
                                setMatrixFreeResponseRoomIds(e.target.value)
                            }
                            placeholder='!roomid:matrix.example.org, ...'
                        />
                    </Field>
                    <BehaviorFields
                        mentionOnly={mentionOnly}
                        setMentionOnly={setMentionOnly}
                        shareSessionInChannel={shareSessionInChannel}
                        setShareSessionInChannel={setShareSessionInChannel}
                        threadIsolation={threadIsolation}
                        setThreadIsolation={setThreadIsolation}
                        progressMode={progressMode}
                        setProgressMode={setProgressMode}
                        contextProjection={contextProjection}
                        setContextProjection={setContextProjection}
                        threadLabel={t('web.channels.settings.threadLabels.matrix')}
                    />
                    <CheckboxField
                        label={t('web.channels.settings.behaviors.autoJoinInvites')}
                        description={t('web.channels.settings.behaviors.autoJoinInvitesDescription')}
                        checked={matrixAutoJoin}
                        onChange={setMatrixAutoJoin}
                    />
                    <CheckboxField
                        label={t('web.channels.settings.behaviors.autoThreadGroup')}
                        description={t('web.channels.settings.behaviors.autoThreadGroupDescription')}
                        checked={matrixAutoThread}
                        onChange={setMatrixAutoThread}
                    />
                    <CheckboxField
                        label={t('web.channels.settings.behaviors.attachFiles')}
                        description={t('web.channels.settings.behaviors.attachFilesMatrixDescription')}
                        checked={matrixOutboundFiles}
                        onChange={setMatrixOutboundFiles}
                    />
                    <CheckboxField
                        label={t('web.channels.settings.behaviors.backfillRoom')}
                        description={t('web.channels.settings.behaviors.backfillRoomDescription')}
                        checked={matrixHistoryBackfill}
                        onChange={setMatrixHistoryBackfill}
                    />
                    {matrixHistoryBackfill && (
                        <Field label={t('web.channels.settings.fields.historyBackfillLimit')}>
                            <input
                                type='number'
                                min={1}
                                max={100}
                                className='workbench-input'
                                value={matrixHistoryBackfillLimit}
                                onChange={(e) =>
                                    setMatrixHistoryBackfillLimit(
                                        e.target.value
                                    )
                                }
                            />
                        </Field>
                    )}
                </>
            )}

            {channel.provider === 'weixin' && (
                <>
                    <Field label={t('web.channels.settings.fields.ilinkBotTokenKeep')}>
                        <input
                            type='password'
                            className='workbench-input'
                            value={weixinBotToken}
                            onChange={(e) => setWeixinBotToken(e.target.value)}
                            autoComplete='new-password'
                        />
                    </Field>
                    <Field label={t('web.channels.settings.fields.allowedUserIds')}>
                        <input
                            type='text'
                            className='workbench-input'
                            value={weixinAllowedUserIds}
                            onChange={(e) =>
                                setWeixinAllowedUserIds(e.target.value)
                            }
                            placeholder='wxid_xxx@im.wechat, ...'
                        />
                    </Field>
                    <Field label={t('web.channels.settings.fields.operatorUserIds')}>
                        <input
                            type='text'
                            className='workbench-input'
                            value={weixinOperatorUserIds}
                            onChange={(e) =>
                                setWeixinOperatorUserIds(e.target.value)
                            }
                            placeholder='wxid_xxx@im.wechat, ...'
                        />
                    </Field>
                    <CheckboxField
                        label={t('web.channels.settings.behaviors.attachFiles')}
                        description={t('web.channels.settings.behaviors.attachFilesWeixinDescription')}
                        checked={weixinOutboundFiles}
                        onChange={setWeixinOutboundFiles}
                    />
                    <CheckboxField
                        label={t('web.channels.settings.behaviors.sendContext')}
                        description={t('web.channels.settings.behaviors.sendContextDescription')}
                        checked={contextProjection}
                        onChange={setContextProjection}
                    />
                    <p className='text-ui text-muted'>
                        {t('web.channels.settings.help.weixinEdit')}
                    </p>
                </>
            )}

            {channel.provider === 'linear' && (
                <>
                    <Field label={t('web.channels.settings.fields.clientIdKeep')}>
                        <input
                            type='text'
                            className='workbench-input'
                            value={linearClientId}
                            onChange={(e) => setLinearClientId(e.target.value)}
                        />
                    </Field>
                    <Field label={t('web.channels.settings.fields.clientSecretKeep')}>
                        <input
                            type='password'
                            className='workbench-input'
                            value={linearClientSecret}
                            onChange={(e) =>
                                setLinearClientSecret(e.target.value)
                            }
                            autoComplete='new-password'
                        />
                    </Field>
                    <Field label={t('web.channels.settings.fields.webhookSigningSecretKeep')}>
                        <input
                            type='password'
                            className='workbench-input'
                            value={linearWebhookSecret}
                            onChange={(e) =>
                                setLinearWebhookSecret(e.target.value)
                            }
                            autoComplete='new-password'
                        />
                    </Field>
                    <Field label={t('web.channels.settings.fields.accessTokenOverride')}>
                        <input
                            type='password'
                            className='workbench-input'
                            value={linearAccessToken}
                            onChange={(e) =>
                                setLinearAccessToken(e.target.value)
                            }
                            autoComplete='new-password'
                        />
                    </Field>
                    <Field label={t('web.channels.settings.fields.allowedLinearUserIdsOptional')}>
                        <input
                            type='text'
                            className='workbench-input'
                            value={linearAllowedUserIds}
                            onChange={(e) =>
                                setLinearAllowedUserIds(e.target.value)
                            }
                        />
                    </Field>
                    <Field label={t('web.channels.settings.fields.progress')}>
                        <WorkbenchSelect
                            ariaLabel={t('web.channels.settings.fields.progress')}
                            value={linearProgressMode}
                            onChange={(next) =>
                                setLinearProgressMode(
                                    next as 'activity' | 'final'
                                )
                            }
                            options={[
                                {
                                    value: 'activity',
                                    label: t('web.channels.settings.options.activity')
                                },
                                {
                                    value: 'final',
                                    label: t('web.channels.settings.options.finalOnly')
                                }
                            ]}
                        />
                    </Field>
                    <CheckboxField
                        label={t('web.channels.settings.behaviors.sendContext')}
                        description={t('web.channels.settings.behaviors.sendContextDescription')}
                        checked={contextProjection}
                        onChange={setContextProjection}
                    />
                    <p className='text-ui text-muted'>
                        {t('web.channels.settings.help.linearEdit')}
                    </p>
                </>
            )}

            {channel.provider === 'github' && (
                <>
                    <Field label={t('web.channels.settings.fields.appIdKeep')}>
                        <input
                            type='text'
                            className='workbench-input'
                            value={githubAppId}
                            onChange={(e) => setGithubAppId(e.target.value)}
                        />
                    </Field>
                    <Field label={t('web.channels.settings.fields.privateKeyKeep')}>
                        <textarea
                            className='workbench-input min-h-24 font-mono'
                            value={githubPrivateKey}
                            onChange={(e) =>
                                setGithubPrivateKey(e.target.value)
                            }
                            placeholder={t(
                                'web.channels.settings.placeholders.privateKey'
                            )}
                        />
                    </Field>
                    <Field label={t('web.channels.settings.fields.webhookSecretKeep')}>
                        <input
                            type='password'
                            className='workbench-input'
                            value={githubWebhookSecret}
                            onChange={(e) =>
                                setGithubWebhookSecret(e.target.value)
                            }
                            autoComplete='new-password'
                        />
                    </Field>
                    <Field label={t('web.channels.settings.fields.repositoriesOptional')}>
                        <input
                            type='text'
                            className='workbench-input'
                            value={githubAllowedRepos}
                            onChange={(e) =>
                                setGithubAllowedRepos(e.target.value)
                            }
                            placeholder='owner/repo, owner/other-repo'
                        />
                    </Field>
                    <Field label={t('web.channels.settings.fields.allowedGithubLoginsOptional')}>
                        <input
                            type='text'
                            className='workbench-input'
                            value={githubAllowedUserIds}
                            onChange={(e) =>
                                setGithubAllowedUserIds(e.target.value)
                            }
                        />
                    </Field>
                    <Field label={t('web.channels.settings.fields.operatorGithubLoginsOptional')}>
                        <input
                            type='text'
                            className='workbench-input'
                            value={githubOperatorUserIds}
                            onChange={(e) =>
                                setGithubOperatorUserIds(e.target.value)
                            }
                        />
                    </Field>
                    <Field label={t('web.channels.settings.fields.allowedAssociations')}>
                        <input
                            type='text'
                            className='workbench-input'
                            value={githubAllowedAssociations}
                            onChange={(e) =>
                                setGithubAllowedAssociations(e.target.value)
                            }
                            placeholder='OWNER, MEMBER, COLLABORATOR'
                        />
                    </Field>
                    <Field label={t('web.channels.settings.fields.delegationLabelOptional')}>
                        <input
                            type='text'
                            className='workbench-input'
                            value={githubTriggerLabel}
                            onChange={(e) =>
                                setGithubTriggerLabel(e.target.value)
                            }
                            placeholder={t(
                                'web.channels.settings.placeholders.delegationLabel'
                            )}
                        />
                    </Field>
                    <Field label={t('web.channels.settings.fields.progressMode')}>
                        <WorkbenchSelect
                            ariaLabel={t('web.channels.settings.fields.progressMode')}
                            value={progressMode}
                            onChange={(next) =>
                                setProgressMode(next as ChannelProgressMode)
                            }
                            options={[
                                {
                                    value: 'preview',
                                    label: t('web.channels.settings.options.previewComment')
                                },
                                {
                                    value: 'activity',
                                    label: t('web.channels.settings.options.activityPreview')
                                },
                                {
                                    value: 'final',
                                    label: t('web.channels.settings.options.finalOnly')
                                }
                            ]}
                        />
                    </Field>
                    <CheckboxField
                        label={t('web.channels.settings.behaviors.githubFreshComment')}
                        description={t('web.channels.settings.behaviors.githubFreshCommentDescription')}
                        checked={githubFreshFinal}
                        onChange={setGithubFreshFinal}
                    />
                    <CheckboxField
                        label={t('web.channels.settings.behaviors.sendContext')}
                        description={t('web.channels.settings.behaviors.sendContextDescription')}
                        checked={contextProjection}
                        onChange={setContextProjection}
                    />
                    <p className='text-ui text-muted'>
                        {t('web.channels.settings.help.githubEdit')}
                    </p>
                </>
            )}

            {channel.provider === 'line' && (
                <>
                    <Field label={t('web.channels.settings.fields.channelSecretKeep')}>
                        <input
                            type='password'
                            className='workbench-input'
                            value={lineChannelSecret}
                            onChange={(e) =>
                                setLineChannelSecret(e.target.value)
                            }
                            autoComplete='new-password'
                        />
                    </Field>
                    <Field
                        label={t(
                            'web.channels.settings.fields.channelAccessTokenKeep'
                        )}
                    >
                        <input
                            type='password'
                            className='workbench-input'
                            value={lineChannelAccessToken}
                            onChange={(e) =>
                                setLineChannelAccessToken(e.target.value)
                            }
                            autoComplete='new-password'
                        />
                    </Field>
                    <Field label={t('web.channels.settings.fields.allowedUserIds')}>
                        <input
                            type='text'
                            className='workbench-input'
                            value={lineAllowedUserIds}
                            onChange={(e) =>
                                setLineAllowedUserIds(e.target.value)
                            }
                            placeholder='U4af4980629..., ...'
                        />
                    </Field>
                    <Field label={t('web.channels.settings.fields.operatorUserIds')}>
                        <input
                            type='text'
                            className='workbench-input'
                            value={lineOperatorUserIds}
                            onChange={(e) =>
                                setLineOperatorUserIds(e.target.value)
                            }
                            placeholder='U4af4980629..., ...'
                        />
                    </Field>
                    <Field
                        label={t(
                            'web.channels.settings.fields.allowedLineChatIdsOptional'
                        )}
                    >
                        <input
                            type='text'
                            className='workbench-input'
                            value={lineAllowedChatIds}
                            onChange={(e) =>
                                setLineAllowedChatIds(e.target.value)
                            }
                            placeholder='Cxxxxxxxx, Rxxxxxxxx'
                        />
                    </Field>
                    <CheckboxField
                        label={t('web.channels.settings.behaviors.mentionOnly')}
                        description={t('web.channels.settings.behaviors.mentionOnlyDescription')}
                        checked={mentionOnly}
                        onChange={setMentionOnly}
                    />
                    <CheckboxField
                        label={t('web.channels.settings.behaviors.shareSession')}
                        description={t('web.channels.settings.behaviors.shareSessionDescription')}
                        checked={shareSessionInChannel}
                        onChange={setShareSessionInChannel}
                    />
                    <CheckboxField
                        label={t('web.channels.settings.behaviors.sendContext')}
                        description={t('web.channels.settings.behaviors.sendContextDescription')}
                        checked={contextProjection}
                        onChange={setContextProjection}
                    />
                    <p className='text-ui text-muted'>
                        {t('web.channels.settings.help.lineEdit')}
                    </p>
                </>
            )}
        </ProductDialog>
    )
}

const Field: FC<{ label: string; children: ReactNode }> = ({
    label,
    children
}) => (
    <label className='block'>
        <span className='text-ui text-fg mb-1 block font-medium'>{label}</span>
        {children}
    </label>
)

interface BehaviorFieldsProps {
    mentionOnly: boolean
    setMentionOnly: (next: boolean) => void
    shareSessionInChannel: boolean
    setShareSessionInChannel: (next: boolean) => void
    threadIsolation: boolean
    setThreadIsolation: (next: boolean) => void
    progressMode: ChannelProgressMode
    setProgressMode: (next: ChannelProgressMode) => void
    contextProjection: boolean
    setContextProjection: (next: boolean) => void
    threadLabel: string
}

const BehaviorFields: FC<BehaviorFieldsProps> = ({
    mentionOnly,
    setMentionOnly,
    shareSessionInChannel,
    setShareSessionInChannel,
    threadIsolation,
    setThreadIsolation,
    progressMode,
    setProgressMode,
    contextProjection,
    setContextProjection,
    threadLabel
}) => {
    const { t } = useI18n()
    return (
    <>
        <Field label={t('web.channels.settings.fields.progressMode')}>
            <WorkbenchSelect
                ariaLabel={t('web.channels.settings.fields.progressMode')}
                value={progressMode}
                onChange={(next) =>
                    setProgressMode(next as ChannelProgressMode)
                }
                options={[
                    {
                        value: 'preview',
                        label: t('web.channels.settings.options.progressiveCards')
                    },
                    {
                        value: 'activity',
                        label: t('web.channels.settings.options.activityProgress')
                    },
                    {
                        value: 'final',
                        label: t('web.channels.settings.options.finalText')
                    }
                ]}
            />
        </Field>
        <CheckboxField
            label={t('web.channels.settings.behaviors.mentionOnly')}
            description={t('web.channels.settings.behaviors.mentionOnlyDescription')}
            checked={mentionOnly}
            onChange={setMentionOnly}
        />
        <CheckboxField
            label={t('web.channels.settings.behaviors.shareSession')}
            description={t('web.channels.settings.behaviors.shareSessionDescription')}
            checked={shareSessionInChannel}
            onChange={setShareSessionInChannel}
        />
        <CheckboxField
            label={t('web.channels.settings.behaviors.threadIsolation')}
            description={threadLabel}
            checked={threadIsolation}
            onChange={setThreadIsolation}
        />
        <CheckboxField
            label={t('web.channels.settings.behaviors.sendContext')}
            description={t('web.channels.settings.behaviors.sendContextFullDescription')}
            checked={contextProjection}
            onChange={setContextProjection}
        />
    </>
    )
}

interface CheckboxFieldProps {
    label: string
    description: string
    checked: boolean
    onChange: (next: boolean) => void
}

const CheckboxField: FC<CheckboxFieldProps> = ({
    label,
    description,
    checked,
    onChange
}) => (
    <label className='flex items-start gap-3'>
        <input
            type='checkbox'
            checked={checked}
            onChange={(e) => onChange(e.target.checked)}
            className='mt-1'
        />
        <span>
            <span className='text-ui text-fg block font-medium'>{label}</span>
            <span className='text-ui text-muted block'>{description}</span>
        </span>
    </label>
)

const commaList = (raw: string): string[] =>
    raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)

const clampHistoryLimit = (raw: string): number => {
    const n = Number.parseInt(raw, 10)
    if (!Number.isFinite(n)) return 50
    return Math.min(100, Math.max(1, n))
}

export default ChannelDetail
