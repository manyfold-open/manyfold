import type {
    ChannelDeliverySummary,
    ChannelDetail as ChannelDetailType,
    ChannelTestResult,
    GithubChannelConfig,
    LarkChannelConfig
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
import { Field } from './ChannelFormField'
import ShortcutTooltip from '@/components/ShortcutTooltip'
import WorkbenchSelect from '@/components/WorkbenchSelect'
import { StatusTag } from '@/components/Tag'
import EmptyState from '@/components/EmptyState'
import { useApiClient } from '@/lib/apiClient'
import { ChannelProviderIcon, channelDocsHref } from '@/lib/channelMeta'
import { formatDateTime, formatTime } from '@/lib/dateFormat'
import { apiErrorMessage } from '@/lib/errorMessage'
import { useI18n } from '@/lib/i18n'

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
                description: t(
                    'web.channels.settings.deleteConfirmDescription'
                ),
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
                                    navigate(
                                        `/settings/channels/${channel.id}/edit`
                                    )
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
                                            ? t(
                                                  'web.channels.settings.tooltips.reregisterTelegram'
                                              )
                                            : channel.provider === 'lark'
                                              ? t(
                                                    'web.channels.settings.tooltips.refreshLarkIdentity'
                                                )
                                              : channel.provider === 'weixin'
                                                ? t(
                                                      'web.channels.settings.tooltips.registerWeixin'
                                                  )
                                                : channel.provider === 'linear'
                                                  ? t(
                                                        'web.channels.settings.tooltips.registerLinear'
                                                    )
                                                  : channel.provider ===
                                                      'github'
                                                    ? t(
                                                          'web.channels.settings.tooltips.registerGithub'
                                                      )
                                                    : channel.provider ===
                                                        'line'
                                                      ? t(
                                                            'web.channels.settings.tooltips.registerLine'
                                                        )
                                                      : t(
                                                            'web.channels.settings.tooltips.registerMatrix'
                                                        )
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
                                                ? t(
                                                      'web.channels.settings.registerTelegram'
                                                  )
                                                : channel.provider === 'lark'
                                                  ? t(
                                                        'web.channels.settings.refreshBotIdentity'
                                                    )
                                                  : channel.provider ===
                                                      'github'
                                                    ? t(
                                                          'web.channels.settings.registerApp'
                                                      )
                                                    : t(
                                                          'web.channels.settings.registerToken'
                                                      )}
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
                            {copied ? t('common.copied') : t('common.copy')}
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
                                  ? t(
                                        'web.channels.settings.webhookHelp.github'
                                    )
                                  : channel.provider === 'line'
                                    ? t(
                                          'web.channels.settings.webhookHelp.line'
                                      )
                                    : t(
                                          'web.channels.settings.webhookHelp.other'
                                      )}
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
                                : t(
                                      'web.channels.settings.connection.websocket'
                                  )}
                    </div>
                    <p className='text-ui text-fg'>
                        {channel.provider === 'matrix'
                            ? t('web.channels.settings.connectionHelp.matrix')
                            : channel.provider === 'discord'
                              ? t(
                                    'web.channels.settings.connectionHelp.discord'
                                )
                              : channel.provider === 'weixin'
                                ? t(
                                      'web.channels.settings.connectionHelp.weixin'
                                  )
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
                                        {t(
                                            'web.channels.settings.github.install'
                                        )}
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
    if (channel.provider === 'whatsapp') return false
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
    if (channel.provider === 'whatsapp') return 'WhatsApp'
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

export default ChannelDetail
