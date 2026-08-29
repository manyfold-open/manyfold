import type {
    ChannelCredentials,
    CreateChannelBody,
    DiscordChannelConfig,
    GithubChannelConfig,
    LarkChannelConfig,
    LarkSubscriptionMode,
    LinearChannelConfig,
    LineChannelConfig,
    MatrixChannelConfig,
    SlackChannelConfig,
    TelegramChannelConfig,
    WeixinChannelConfig
} from '@manyfold/shared'
import type { FC, FormEvent, ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { Navigate, useNavigate, useParams } from 'react-router-dom'
import type { SdkAgent } from '@manyfold/sdk'
import { t as translate } from '@manyfold/i18n'
import EmptyState from '@/components/EmptyState'
import SettingsPageHeader from '@/components/SettingsPageHeader'
import WorkbenchSelect from '@/components/WorkbenchSelect'
import { useApiClient } from '@/lib/apiClient'
import { useI18n } from '@/lib/i18n'
import { apiErrorMessage } from '@/lib/errorMessage'
import {
    NEW_CHANNEL_OPTIONS,
    isCreateProvider,
    isLarkProviderChoice,
    wireProvider,
    type CreateProviderChoice
} from '@/lib/newChannelOptions'
import ChannelDocsLink from './ChannelDocsLink'
import LarkQuickCreate, { type LarkQuickCreateState } from './LarkQuickCreate'
import WeixinQuickCreate, {
    type WeixinQuickCreateState
} from './WeixinQuickCreate'
import WhatsappQuickCreate, {
    type WhatsappQuickCreateState
} from './WhatsappQuickCreate'

const ChannelNew: FC = (): ReactNode => {
    const client = useApiClient()
    const { t } = useI18n()
    const navigate = useNavigate()
    const params = useParams<{ provider: string }>()
    const known = isCreateProvider(params.provider)
    // A typo in the URL renders nothing useful, so send it back to the rail
    // rather than a form bound to a provider the builder cannot serialise.
    const provider = (
        known ? params.provider : 'feishu'
    ) as CreateProviderChoice
    // Self-contained like the runtimes rail's embedded create pages: the page
    // is reachable by URL, so it cannot rely on the rail having loaded agents.
    const [agents, setAgents] = useState<SdkAgent[]>([])
    const [agentsLoaded, setAgentsLoaded] = useState(false)

    const onCreated = (id: string): void => {
        navigate(`/settings/channels/${id}`)
    }
    const [agentId, setAgentId] = useState('')
    const [larkMode, setLarkMode] = useState<'qr' | 'manual'>('qr')
    const [label, setLabel] = useState('')
    const [subscriptionMode, setSubscriptionMode] =
        useState<LarkSubscriptionMode>('webhook')
    const [appId, setAppId] = useState('')
    const [appSecret, setAppSecret] = useState('')
    const [verificationToken, setVerificationToken] = useState('')
    const [encryptKey, setEncryptKey] = useState('')
    const [botName, setBotName] = useState('')
    const [quickBotName, setQuickBotName] = useState('')
    const quickBotNameTouched = useRef(false)
    const [larkQuickState, setLarkQuickState] = useState<LarkQuickCreateState>({
        id: null,
        status: 'idle'
    })
    const [larkAllowedUserIds, setLarkAllowedUserIds] = useState('')
    const [larkOperatorUserIds, setLarkOperatorUserIds] = useState('')
    const [tgBotToken, setTgBotToken] = useState('')
    const [slackBotToken, setSlackBotToken] = useState('')
    const [slackSigningSecret, setSlackSigningSecret] = useState('')
    const [slackAllowedUserIds, setSlackAllowedUserIds] = useState('')
    const [slackOperatorUserIds, setSlackOperatorUserIds] = useState('')
    const [linearClientId, setLinearClientId] = useState('')
    const [linearClientSecret, setLinearClientSecret] = useState('')
    const [linearWebhookSecret, setLinearWebhookSecret] = useState('')
    const [linearAccessToken, setLinearAccessToken] = useState('')
    const [linearAllowedUserIds, setLinearAllowedUserIds] = useState('')
    const [githubAllowedRepos, setGithubAllowedRepos] = useState('')
    const [discordBotToken, setDiscordBotToken] = useState('')
    const [discordAllowedGuildIds, setDiscordAllowedGuildIds] = useState('')
    const [matrixHomeserver, setMatrixHomeserver] = useState('')
    const [matrixAccessToken, setMatrixAccessToken] = useState('')
    const [matrixAllowedRoomIds, setMatrixAllowedRoomIds] = useState('')
    const [matrixAllowedUserIds, setMatrixAllowedUserIds] = useState('')
    const [matrixFreeResponseRoomIds, setMatrixFreeResponseRoomIds] =
        useState('')
    const [weixinMode, setWeixinMode] = useState<'qr' | 'manual'>('qr')
    const [weixinBotToken, setWeixinBotToken] = useState('')
    const [weixinBaseUrl, setWeixinBaseUrl] = useState('')
    const [weixinAllowedUserIds, setWeixinAllowedUserIds] = useState('')
    const [weixinOperatorUserIds, setWeixinOperatorUserIds] = useState('')
    const [weixinQuickState, setWeixinQuickState] =
        useState<WeixinQuickCreateState>({ id: null, status: 'idle' })
    const [whatsappQuickState, setWhatsappQuickState] =
        useState<WhatsappQuickCreateState>({ id: null, status: 'idle' })
    const [lineChannelSecret, setLineChannelSecret] = useState('')
    const [lineChannelAccessToken, setLineChannelAccessToken] = useState('')
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    useEffect(() => {
        let cancelled = false
        client.agents
            .list()
            .then((rows) => {
                if (cancelled) return
                setAgents(rows)
                setAgentId((prev) => prev || (rows[0]?.id ?? ''))
                // Only seed the bot name while the user has not typed one.
                if (!quickBotNameTouched.current)
                    setQuickBotName(rows[0]?.name ?? '')
            })
            .catch(() => undefined)
            .finally(() => {
                if (!cancelled) setAgentsLoaded(true)
            })
        return () => {
            cancelled = true
        }
    }, [client])

    const larkQuickActive =
        larkQuickState.status === 'starting' ||
        larkQuickState.status === 'pending' ||
        larkQuickState.status === 'creating'
    const weixinQuickActive =
        weixinQuickState.status === 'starting' ||
        weixinQuickState.status === 'pending' ||
        weixinQuickState.status === 'need_verify_code' ||
        weixinQuickState.status === 'creating'
    const whatsappQuickActive =
        whatsappQuickState.status === 'starting' ||
        whatsappQuickState.status === 'pending' ||
        whatsappQuickState.status === 'creating'
    const quickActive =
        larkQuickActive || weixinQuickActive || whatsappQuickActive
    const larkQrMode = isLarkProviderChoice(provider) && larkMode === 'qr'

    const leave = (): void => {
        navigate('/settings/channels')
    }

    // The awaited cancel plus its re-GET is what a plain unmount cannot do:
    // the server's cancel is a no-op once the row has left `pending`, so a
    // scan that landed a moment earlier still wins and only the re-read
    // notices and routes the user to the channel it created.
    const handleCancel = async (): Promise<void> => {
        const whatsappPendingId =
            provider === 'whatsapp' &&
            whatsappQuickState.status === 'pending' &&
            whatsappQuickState.id
                ? whatsappQuickState.id
                : null
        if (whatsappPendingId) {
            setBusy(true)
            setError(null)
            try {
                await client.channels.cancelWhatsappRegistration(
                    whatsappPendingId
                )
                const latest =
                    await client.channels.getWhatsappRegistration(
                        whatsappPendingId
                    )
                setWhatsappQuickState({ id: latest.id, status: latest.status })
                if (latest.status === 'succeeded' && latest.channelId) {
                    onCreated(latest.channelId)
                    return
                }
                if (!whatsappQuickActive) leave()
            } catch (err) {
                setError(apiErrorMessage(err))
            } finally {
                setBusy(false)
            }
            return
        }
        const weixinPendingId =
            provider === 'weixin' &&
            weixinMode === 'qr' &&
            (weixinQuickState.status === 'pending' ||
                weixinQuickState.status === 'need_verify_code') &&
            weixinQuickState.id
                ? weixinQuickState.id
                : null
        if (weixinPendingId) {
            setBusy(true)
            setError(null)
            try {
                await client.channels.cancelWeixinRegistration(weixinPendingId)
                const latest =
                    await client.channels.getWeixinRegistration(weixinPendingId)
                setWeixinQuickState({ id: latest.id, status: latest.status })
                if (latest.status === 'succeeded' && latest.channelId) {
                    onCreated(latest.channelId)
                    return
                }
                if (!weixinQuickActive) leave()
            } catch (err) {
                setError(apiErrorMessage(err))
            } finally {
                setBusy(false)
            }
            return
        }
        if (
            !larkQrMode ||
            larkQuickState.status !== 'pending' ||
            !larkQuickState.id
        ) {
            if (!quickActive) leave()
            return
        }

        setBusy(true)
        setError(null)
        try {
            await client.channels.cancelLarkRegistration(larkQuickState.id)
            const latest = await client.channels.getLarkRegistration(
                larkQuickState.id
            )
            setLarkQuickState({ id: latest.id, status: latest.status })
            if (latest.status === 'succeeded' && latest.channelId) {
                onCreated(latest.channelId)
                return
            }
            if (latest.status !== 'pending' && latest.status !== 'creating')
                leave()
        } catch (err) {
            setError(apiErrorMessage(err))
        } finally {
            setBusy(false)
        }
    }

    const handleSubmit = async (e: FormEvent): Promise<void> => {
        e.preventDefault()
        if (larkQrMode) return
        if (provider === 'weixin' && weixinMode === 'qr') return
        if (provider === 'whatsapp') return
        setBusy(true)
        setError(null)
        try {
            const body = buildBody({
                agentId,
                provider,
                label,
                subscriptionMode,
                appId,
                appSecret,
                verificationToken,
                encryptKey,
                botName,
                larkAllowedUserIds,
                larkOperatorUserIds,
                tgBotToken,
                slackBotToken,
                slackSigningSecret,
                slackAllowedUserIds,
                slackOperatorUserIds,
                linearClientId,
                linearClientSecret,
                linearWebhookSecret,
                linearAccessToken,
                linearAllowedUserIds,
                githubAllowedRepos,
                discordBotToken,
                discordAllowedGuildIds,
                matrixHomeserver,
                matrixAccessToken,
                matrixAllowedRoomIds,
                matrixAllowedUserIds,
                matrixFreeResponseRoomIds,
                weixinBotToken,
                weixinBaseUrl,
                weixinAllowedUserIds,
                weixinOperatorUserIds,
                lineChannelSecret,
                lineChannelAccessToken
            })
            const created = await client.channels.create(body)
            onCreated(created.id)
        } catch (err) {
            setError(apiErrorMessage(err))
        } finally {
            setBusy(false)
        }
    }

    if (!known) return <Navigate to='/settings/channels' replace />

    const providerLabel =
        NEW_CHANNEL_OPTIONS.find((o) => o.provider === provider)?.label ?? ''

    const header = (
        <SettingsPageHeader
            breadcrumb={[
                {
                    label: t('web.channels.settings.channels'),
                    to: '/settings/channels'
                },
                { label: providerLabel }
            ]}
            title={t('web.channelNew.title', { provider: providerLabel })}
            actions={<ChannelDocsLink provider={wireProvider(provider)} />}
        />
    )

    if (agentsLoaded && agents.length === 0)
        return (
            <div className='settings-page'>
                {header}
                <EmptyState
                    kind='first-use'
                    tier='stack'
                    title={t('web.channelNew.noAgentsTitle')}
                    body={t('web.channelNew.noAgentsBody')}
                />
            </div>
        )

    return (
        <div className='settings-page'>
            {header}
            <div className='workbench-panel p-6 md:p-7'>
                <form onSubmit={handleSubmit} className='space-y-4'>
                    {error && (
                        <div className='workbench-alert-error'>{error}</div>
                    )}

                    <Field label={t('web.channels.settings.fields.agent')}>
                        <WorkbenchSelect
                            ariaLabel={t('web.channels.settings.fields.agent')}
                            value={agentId}
                            disabled={quickActive}
                            onChange={(next) => {
                                setAgentId(next)
                                if (!quickBotNameTouched.current)
                                    setQuickBotName(
                                        agents.find(
                                            (agent) => agent.id === next
                                        )?.name ?? ''
                                    )
                            }}
                            options={agents.map((agent) => ({
                                value: agent.id,
                                label: agent.name
                            }))}
                        />
                    </Field>

                    <Field label={t('web.channels.settings.fields.label')}>
                        <input
                            type='text'
                            className='workbench-input'
                            value={label}
                            onChange={(e) => setLabel(e.target.value)}
                            placeholder={t(
                                'web.channels.settings.placeholders.teamSupport'
                            )}
                            disabled={quickActive}
                            required
                        />
                    </Field>

                    {isLarkProviderChoice(provider) && (
                        <>
                            <div
                                role='group'
                                aria-label={t(
                                    'web.channels.settings.setupMode.lark'
                                )}
                                className='bg-soft shadow-ring-light grid grid-cols-2 gap-1 rounded-md p-1'
                            >
                                <button
                                    type='button'
                                    disabled={quickActive}
                                    aria-pressed={larkMode === 'qr'}
                                    onClick={() => setLarkMode('qr')}
                                    className={larkModeButtonClass(
                                        larkMode === 'qr'
                                    )}
                                >
                                    <span>
                                        {t('web.channels.larkQuick.modeQr')}
                                    </span>
                                    <span className='tag tag-neutral'>
                                        {t(
                                            'web.channels.larkQuick.recommended'
                                        )}
                                    </span>
                                </button>
                                <button
                                    type='button'
                                    disabled={quickActive}
                                    aria-pressed={larkMode === 'manual'}
                                    onClick={() => setLarkMode('manual')}
                                    className={larkModeButtonClass(
                                        larkMode === 'manual'
                                    )}
                                >
                                    {t('web.channels.larkQuick.modeManual')}
                                </button>
                            </div>

                            {larkQrMode ? (
                                <>
                                    <Field
                                        label={t(
                                            'web.channels.larkQuick.botNameLabel'
                                        )}
                                    >
                                        <input
                                            type='text'
                                            className='workbench-input'
                                            value={quickBotName}
                                            onChange={(e) => {
                                                quickBotNameTouched.current = true
                                                setQuickBotName(e.target.value)
                                            }}
                                            disabled={quickActive}
                                            maxLength={60}
                                            required
                                        />
                                    </Field>
                                    <LarkQuickCreate
                                        agentId={agentId}
                                        appRegion={provider}
                                        label={label}
                                        botName={quickBotName}
                                        onCreated={onCreated}
                                        onStateChange={setLarkQuickState}
                                    />
                                </>
                            ) : (
                                <LarkManualFields
                                    subscriptionMode={subscriptionMode}
                                    setSubscriptionMode={setSubscriptionMode}
                                    appId={appId}
                                    setAppId={setAppId}
                                    appSecret={appSecret}
                                    setAppSecret={setAppSecret}
                                    verificationToken={verificationToken}
                                    setVerificationToken={setVerificationToken}
                                    encryptKey={encryptKey}
                                    setEncryptKey={setEncryptKey}
                                    botName={botName}
                                    setBotName={setBotName}
                                    larkAllowedUserIds={larkAllowedUserIds}
                                    setLarkAllowedUserIds={
                                        setLarkAllowedUserIds
                                    }
                                    larkOperatorUserIds={larkOperatorUserIds}
                                    setLarkOperatorUserIds={
                                        setLarkOperatorUserIds
                                    }
                                />
                            )}
                        </>
                    )}

                    {provider === 'telegram' && (
                        <>
                            <Field
                                label={t(
                                    'web.channels.settings.fields.botToken'
                                )}
                            >
                                <input
                                    type='password'
                                    className='workbench-input'
                                    value={tgBotToken}
                                    onChange={(e) =>
                                        setTgBotToken(e.target.value)
                                    }
                                    placeholder='123456789:AAH...'
                                    required
                                />
                            </Field>
                            <p className='text-ui text-muted -mt-2'>
                                {t('web.channels.settings.help.telegramCreate')}
                            </p>
                        </>
                    )}

                    {provider === 'slack' && (
                        <>
                            <Field
                                label={t(
                                    'web.channels.settings.fields.botToken'
                                )}
                            >
                                <input
                                    type='password'
                                    className='workbench-input'
                                    value={slackBotToken}
                                    onChange={(e) =>
                                        setSlackBotToken(e.target.value)
                                    }
                                    placeholder='xoxb-...'
                                    required
                                />
                            </Field>
                            <Field
                                label={t(
                                    'web.channels.settings.fields.signingSecret'
                                )}
                            >
                                <input
                                    type='password'
                                    className='workbench-input'
                                    value={slackSigningSecret}
                                    onChange={(e) =>
                                        setSlackSigningSecret(e.target.value)
                                    }
                                    required
                                />
                            </Field>
                            <Field
                                label={t(
                                    'web.channels.settings.fields.allowedUserIdsOptional'
                                )}
                            >
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
                            <Field
                                label={t(
                                    'web.channels.settings.fields.operatorUserIdsOptional'
                                )}
                            >
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
                                {t('web.channels.settings.help.slackCreate')}
                            </p>
                        </>
                    )}

                    {provider === 'linear' && (
                        <>
                            <Field
                                label={t(
                                    'web.channels.settings.fields.clientId'
                                )}
                            >
                                <input
                                    type='text'
                                    className='workbench-input'
                                    value={linearClientId}
                                    onChange={(e) =>
                                        setLinearClientId(e.target.value)
                                    }
                                    placeholder={t(
                                        'web.channels.settings.placeholders.linearClientId'
                                    )}
                                />
                            </Field>
                            <Field
                                label={t(
                                    'web.channels.settings.fields.clientSecret'
                                )}
                            >
                                <input
                                    type='password'
                                    className='workbench-input'
                                    value={linearClientSecret}
                                    onChange={(e) =>
                                        setLinearClientSecret(e.target.value)
                                    }
                                />
                            </Field>
                            <Field
                                label={t(
                                    'web.channels.settings.fields.webhookSigningSecret'
                                )}
                            >
                                <input
                                    type='password'
                                    className='workbench-input'
                                    value={linearWebhookSecret}
                                    onChange={(e) =>
                                        setLinearWebhookSecret(e.target.value)
                                    }
                                    required
                                />
                            </Field>
                            <Field
                                label={t(
                                    'web.channels.settings.fields.accessTokenOptional'
                                )}
                            >
                                <input
                                    type='password'
                                    className='workbench-input'
                                    value={linearAccessToken}
                                    onChange={(e) =>
                                        setLinearAccessToken(e.target.value)
                                    }
                                    placeholder={t(
                                        'web.channels.settings.placeholders.linearAccessToken'
                                    )}
                                />
                            </Field>
                            <Field
                                label={t(
                                    'web.channels.settings.fields.allowedLinearUserIdsOptional'
                                )}
                            >
                                <input
                                    type='text'
                                    className='workbench-input'
                                    value={linearAllowedUserIds}
                                    onChange={(e) =>
                                        setLinearAllowedUserIds(e.target.value)
                                    }
                                />
                            </Field>
                            <p className='text-ui text-muted -mt-2'>
                                {t('web.channels.settings.help.linearCreate')}
                            </p>
                        </>
                    )}

                    {provider === 'github' && (
                        <>
                            <Field
                                label={t(
                                    'web.channels.settings.fields.repositoriesOptional'
                                )}
                            >
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
                            <p className='text-ui text-muted -mt-2'>
                                {t('web.channels.settings.help.githubCreate')}
                            </p>
                        </>
                    )}

                    {provider === 'line' && (
                        <>
                            <Field
                                label={t(
                                    'web.channels.settings.fields.channelSecret'
                                )}
                            >
                                <input
                                    type='password'
                                    className='workbench-input'
                                    value={lineChannelSecret}
                                    onChange={(e) =>
                                        setLineChannelSecret(e.target.value)
                                    }
                                    autoComplete='new-password'
                                    required
                                />
                            </Field>
                            <Field
                                label={t(
                                    'web.channels.settings.fields.channelAccessToken'
                                )}
                            >
                                <input
                                    type='password'
                                    className='workbench-input'
                                    value={lineChannelAccessToken}
                                    onChange={(e) =>
                                        setLineChannelAccessToken(
                                            e.target.value
                                        )
                                    }
                                    autoComplete='new-password'
                                    required
                                />
                            </Field>
                            <p className='text-ui text-muted -mt-2'>
                                {t('web.channels.settings.help.lineCreate')}
                            </p>
                        </>
                    )}

                    {provider === 'discord' && (
                        <>
                            <Field
                                label={t(
                                    'web.channels.settings.fields.botToken'
                                )}
                            >
                                <input
                                    type='password'
                                    className='workbench-input'
                                    value={discordBotToken}
                                    onChange={(e) =>
                                        setDiscordBotToken(e.target.value)
                                    }
                                    placeholder='MTk...'
                                    required
                                />
                            </Field>
                            <Field
                                label={t(
                                    'web.channels.settings.fields.allowedGuildIdsOptional'
                                )}
                            >
                                <input
                                    type='text'
                                    className='workbench-input'
                                    value={discordAllowedGuildIds}
                                    onChange={(e) =>
                                        setDiscordAllowedGuildIds(
                                            e.target.value
                                        )
                                    }
                                    placeholder='123456789012345678, ...'
                                />
                            </Field>
                            <p className='text-ui text-muted -mt-2'>
                                {t('web.channels.settings.help.discordCreate')}
                            </p>
                        </>
                    )}

                    {provider === 'matrix' && (
                        <>
                            <Field
                                label={t(
                                    'web.channels.settings.fields.homeserverUrl'
                                )}
                            >
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
                            <Field
                                label={t(
                                    'web.channels.settings.fields.accessToken'
                                )}
                            >
                                <input
                                    type='password'
                                    className='workbench-input'
                                    value={matrixAccessToken}
                                    onChange={(e) =>
                                        setMatrixAccessToken(e.target.value)
                                    }
                                    autoComplete='new-password'
                                    required
                                />
                            </Field>
                            <Field
                                label={t(
                                    'web.channels.settings.fields.allowedRoomIdsOptional'
                                )}
                            >
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
                            <Field
                                label={t(
                                    'web.channels.settings.fields.allowedUserIdsOptional'
                                )}
                            >
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
                            <Field
                                label={t(
                                    'web.channels.settings.fields.freeResponseRoomIdsOptional'
                                )}
                            >
                                <input
                                    type='text'
                                    className='workbench-input'
                                    value={matrixFreeResponseRoomIds}
                                    onChange={(e) =>
                                        setMatrixFreeResponseRoomIds(
                                            e.target.value
                                        )
                                    }
                                    placeholder='!roomid:matrix.example.org, ...'
                                />
                            </Field>
                            <p className='text-ui text-muted -mt-2'>
                                {t('web.channels.settings.help.matrixCreate')}
                            </p>
                        </>
                    )}

                    {provider === 'weixin' && (
                        <>
                            <div
                                role='group'
                                aria-label={t(
                                    'web.channels.settings.setupMode.weixin'
                                )}
                                className='bg-soft shadow-ring-light grid grid-cols-2 gap-1 rounded-md p-1'
                            >
                                <button
                                    type='button'
                                    disabled={weixinQuickActive}
                                    aria-pressed={weixinMode === 'qr'}
                                    onClick={() => setWeixinMode('qr')}
                                    className={larkModeButtonClass(
                                        weixinMode === 'qr'
                                    )}
                                >
                                    <span>
                                        {t('web.channels.weixinQuick.modeQr')}
                                    </span>
                                    <span className='tag tag-neutral'>
                                        {t(
                                            'web.channels.weixinQuick.recommended'
                                        )}
                                    </span>
                                </button>
                                <button
                                    type='button'
                                    disabled={weixinQuickActive}
                                    aria-pressed={weixinMode === 'manual'}
                                    onClick={() => setWeixinMode('manual')}
                                    className={larkModeButtonClass(
                                        weixinMode === 'manual'
                                    )}
                                >
                                    {t('web.channels.weixinQuick.modeManual')}
                                </button>
                            </div>

                            {weixinMode === 'qr' ? (
                                <WeixinQuickCreate
                                    agentId={agentId}
                                    label={label}
                                    onCreated={onCreated}
                                    onStateChange={setWeixinQuickState}
                                />
                            ) : (
                                <>
                                    <Field
                                        label={t(
                                            'web.channels.settings.fields.ilinkBotToken'
                                        )}
                                    >
                                        <input
                                            type='password'
                                            className='workbench-input'
                                            value={weixinBotToken}
                                            onChange={(e) =>
                                                setWeixinBotToken(
                                                    e.target.value
                                                )
                                            }
                                            autoComplete='new-password'
                                            required
                                        />
                                    </Field>
                                    <Field
                                        label={t(
                                            'web.channels.settings.fields.gatewayBaseUrlOptional'
                                        )}
                                    >
                                        <input
                                            type='url'
                                            className='workbench-input'
                                            value={weixinBaseUrl}
                                            onChange={(e) =>
                                                setWeixinBaseUrl(e.target.value)
                                            }
                                            placeholder='https://ilinkai.weixin.qq.com'
                                        />
                                    </Field>
                                    <Field
                                        label={t(
                                            'web.channels.settings.fields.allowedUserIdsOptional'
                                        )}
                                    >
                                        <input
                                            type='text'
                                            className='workbench-input'
                                            value={weixinAllowedUserIds}
                                            onChange={(e) =>
                                                setWeixinAllowedUserIds(
                                                    e.target.value
                                                )
                                            }
                                            placeholder='wxid_xxx@im.wechat, ...'
                                        />
                                    </Field>
                                    <Field
                                        label={t(
                                            'web.channels.settings.fields.operatorUserIdsOptional'
                                        )}
                                    >
                                        <input
                                            type='text'
                                            className='workbench-input'
                                            value={weixinOperatorUserIds}
                                            onChange={(e) =>
                                                setWeixinOperatorUserIds(
                                                    e.target.value
                                                )
                                            }
                                            placeholder='wxid_xxx@im.wechat, ...'
                                        />
                                    </Field>
                                    <p className='text-ui text-muted -mt-2'>
                                        {t(
                                            'web.channels.settings.help.weixinCreate'
                                        )}
                                    </p>
                                </>
                            )}
                        </>
                    )}

                    {provider === 'whatsapp' && (
                        <WhatsappQuickCreate
                            agentId={agentId}
                            label={label}
                            onCreated={onCreated}
                            onStateChange={setWhatsappQuickState}
                        />
                    )}
                    <div className='flex justify-end gap-2 pt-2'>
                        <button
                            type='button'
                            onClick={() => void handleCancel()}
                            className='workbench-button-secondary h-9'
                            disabled={
                                busy ||
                                larkQuickState.status === 'starting' ||
                                larkQuickState.status === 'creating' ||
                                weixinQuickState.status === 'starting' ||
                                weixinQuickState.status === 'creating' ||
                                whatsappQuickState.status === 'starting' ||
                                whatsappQuickState.status === 'creating'
                            }
                        >
                            {t('common.cancel')}
                        </button>
                        {!larkQrMode &&
                            provider !== 'whatsapp' &&
                            !(provider === 'weixin' && weixinMode === 'qr') && (
                                <button
                                    type='submit'
                                    className='workbench-button-primary h-9'
                                    disabled={busy}
                                >
                                    {busy
                                        ? t('common.creating')
                                        : t('web.channels.settings.create')}
                                </button>
                            )}
                    </div>
                </form>
            </div>
        </div>
    )
}

interface LarkManualFieldsProps {
    subscriptionMode: LarkSubscriptionMode
    setSubscriptionMode: (value: LarkSubscriptionMode) => void
    appId: string
    setAppId: (value: string) => void
    appSecret: string
    setAppSecret: (value: string) => void
    verificationToken: string
    setVerificationToken: (value: string) => void
    encryptKey: string
    setEncryptKey: (value: string) => void
    botName: string
    setBotName: (value: string) => void
    larkAllowedUserIds: string
    setLarkAllowedUserIds: (value: string) => void
    larkOperatorUserIds: string
    setLarkOperatorUserIds: (value: string) => void
}

const LarkManualFields: FC<LarkManualFieldsProps> = ({
    subscriptionMode,
    setSubscriptionMode,
    appId,
    setAppId,
    appSecret,
    setAppSecret,
    verificationToken,
    setVerificationToken,
    encryptKey,
    setEncryptKey,
    botName,
    setBotName,
    larkAllowedUserIds,
    setLarkAllowedUserIds,
    larkOperatorUserIds,
    setLarkOperatorUserIds
}): ReactNode => {
    const { t } = useI18n()
    return (
        <>
            <Field label={t('web.channels.settings.fields.subscriptionMode')}>
                <WorkbenchSelect
                    ariaLabel={t(
                        'web.channels.settings.fields.subscriptionMode'
                    )}
                    value={subscriptionMode}
                    onChange={(next) =>
                        setSubscriptionMode(next as LarkSubscriptionMode)
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
                    placeholder='cli_xxxxx'
                    required
                />
            </Field>
            <Field label={t('web.channels.settings.fields.appSecret')}>
                <input
                    type='password'
                    className='workbench-input'
                    value={appSecret}
                    onChange={(e) => setAppSecret(e.target.value)}
                    required
                />
            </Field>
            <Field label={t('web.channels.settings.fields.verificationToken')}>
                <input
                    type='text'
                    className='workbench-input'
                    value={verificationToken}
                    onChange={(e) => setVerificationToken(e.target.value)}
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
            <Field label={t('web.channels.settings.fields.botNameMention')}>
                <input
                    type='text'
                    className='workbench-input'
                    value={botName}
                    onChange={(e) => setBotName(e.target.value)}
                />
            </Field>
            <Field
                label={t('web.channels.settings.fields.allowedOpenIdsOptional')}
            >
                <input
                    type='text'
                    className='workbench-input'
                    value={larkAllowedUserIds}
                    onChange={(e) => setLarkAllowedUserIds(e.target.value)}
                    placeholder='ou_xxxx, ou_yyyy'
                />
            </Field>
            <Field
                label={t(
                    'web.channels.settings.fields.operatorOpenIdsOptional'
                )}
            >
                <input
                    type='text'
                    className='workbench-input'
                    value={larkOperatorUserIds}
                    onChange={(e) => setLarkOperatorUserIds(e.target.value)}
                    placeholder='ou_xxxx'
                />
            </Field>
            <p className='text-ui text-muted -mt-2'>
                {t('web.channels.settings.help.larkManual')}
            </p>
        </>
    )
}

const larkModeButtonClass = (active: boolean): string =>
    [
        'text-ui flex min-w-0 items-center justify-center gap-2 rounded-sm px-3 py-2 font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        active
            ? 'bg-surface text-fg shadow-ring-light'
            : 'text-muted hover:bg-surface-hover'
    ].join(' ')

const Field: FC<{ label: string; children: ReactNode }> = ({
    label,
    children
}) => (
    <label className='block'>
        <span className='text-ui text-fg mb-1 block font-medium'>{label}</span>
        {children}
    </label>
)

const buildBody = (input: {
    agentId: string
    provider: CreateProviderChoice
    label: string
    subscriptionMode: LarkSubscriptionMode
    appId: string
    appSecret: string
    verificationToken: string
    encryptKey: string
    botName: string
    larkAllowedUserIds: string
    larkOperatorUserIds: string
    tgBotToken: string
    slackBotToken: string
    slackSigningSecret: string
    slackAllowedUserIds: string
    slackOperatorUserIds: string
    linearClientId: string
    linearClientSecret: string
    linearWebhookSecret: string
    linearAccessToken: string
    linearAllowedUserIds: string
    githubAllowedRepos: string
    discordBotToken: string
    discordAllowedGuildIds: string
    matrixHomeserver: string
    matrixAccessToken: string
    matrixAllowedRoomIds: string
    matrixAllowedUserIds: string
    matrixFreeResponseRoomIds: string
    weixinBotToken: string
    weixinBaseUrl: string
    weixinAllowedUserIds: string
    weixinOperatorUserIds: string
    lineChannelSecret: string
    lineChannelAccessToken: string
}): CreateChannelBody => {
    if (isLarkProviderChoice(input.provider)) {
        if (
            input.subscriptionMode === 'webhook' &&
            !input.verificationToken.trim() &&
            !input.encryptKey.trim()
        )
            throw new Error(
                translate('web.channels.settings.errors.larkWebhookCredentials')
            )
        const config: LarkChannelConfig = {
            appId: input.appId.trim(),
            appRegion: input.provider,
            subscriptionMode: input.subscriptionMode,
            verificationToken: input.verificationToken.trim() || null,
            encryptKey: input.encryptKey.trim() || null,
            mentionOnly: true,
            shareSessionInChannel: false,
            threadIsolation: false,
            progressMode: 'preview',
            botName: input.botName.trim() || null,
            allowedUserIds: commaList(input.larkAllowedUserIds),
            operatorUserIds: commaList(input.larkOperatorUserIds)
        }
        const credentials: ChannelCredentials = {
            appSecret: input.appSecret.trim()
        }
        return {
            agentId: input.agentId,
            provider: 'lark',
            label: input.label.trim(),
            config,
            credentials
        }
    }
    if (input.provider === 'telegram') {
        const config: TelegramChannelConfig = {
            mentionOnly: true,
            shareSessionInChannel: false,
            threadIsolation: true,
            progressMode: 'preview'
        }
        const credentials: ChannelCredentials = {
            botToken: input.tgBotToken.trim(),
            webhookSecret: null
        }
        return {
            agentId: input.agentId,
            provider: 'telegram',
            label: input.label.trim(),
            config,
            credentials
        }
    }
    if (input.provider === 'slack') {
        const config: SlackChannelConfig = {
            allowedUserIds: commaList(input.slackAllowedUserIds),
            operatorUserIds: commaList(input.slackOperatorUserIds),
            mentionOnly: true,
            shareSessionInChannel: false,
            threadIsolation: true,
            progressMode: 'preview'
        }
        const credentials: ChannelCredentials = {
            botToken: input.slackBotToken.trim(),
            signingSecret: input.slackSigningSecret.trim()
        }
        return {
            agentId: input.agentId,
            provider: 'slack',
            label: input.label.trim(),
            config,
            credentials
        }
    }
    if (input.provider === 'linear') {
        const clientId = input.linearClientId.trim()
        const clientSecret = input.linearClientSecret.trim()
        const accessToken = input.linearAccessToken.trim()
        if (!accessToken && !(clientId && clientSecret))
            throw new Error(
                translate('web.channels.settings.errors.linearCredentials')
            )
        const config: LinearChannelConfig = {
            allowedUserIds: commaList(input.linearAllowedUserIds),
            progressMode: 'activity'
        }
        const credentials: ChannelCredentials = {
            webhookSecret: input.linearWebhookSecret.trim(),
            ...(clientId ? { clientId } : {}),
            ...(clientSecret ? { clientSecret } : {}),
            ...(accessToken ? { accessToken } : {})
        }
        return {
            agentId: input.agentId,
            provider: 'linear',
            label: input.label.trim(),
            config,
            credentials
        }
    }
    if (input.provider === 'github') {
        const config: GithubChannelConfig = {
            allowedRepos: commaList(input.githubAllowedRepos),
            allowedUserIds: [],
            operatorUserIds: [],
            // Empty = server default (OWNER/MEMBER/COLLABORATOR).
            allowedAssociations: [],
            progressMode: 'preview'
        }
        return {
            agentId: input.agentId,
            provider: 'github',
            label: input.label.trim(),
            config,
            // The manifest flow on the channel page fills these in.
            credentials: null
        }
    }
    if (input.provider === 'discord') {
        const allowedGuildIds = input.discordAllowedGuildIds
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
        const config: DiscordChannelConfig = {
            allowedGuildIds,
            mentionOnly: true,
            shareSessionInChannel: false,
            threadIsolation: true,
            autoThread: false,
            progressMode: 'preview',
            finalMessageMode: 'edit'
        }
        const credentials: ChannelCredentials = {
            botToken: input.discordBotToken.trim()
        }
        return {
            agentId: input.agentId,
            provider: 'discord',
            label: input.label.trim(),
            config,
            credentials
        }
    }
    if (input.provider === 'matrix') {
        const homeserver = input.matrixHomeserver.trim()
        if (!homeserver)
            throw new Error(
                translate('web.channels.settings.errors.matrixHomeserver')
            )
        if (!input.matrixAccessToken.trim())
            throw new Error(
                translate('web.channels.settings.errors.matrixAccessToken')
            )
        const config: MatrixChannelConfig = {
            homeserver,
            botUserId: null,
            botDisplayName: null,
            allowedRoomIds: commaList(input.matrixAllowedRoomIds),
            allowedUserIds: commaList(input.matrixAllowedUserIds),
            freeResponseRoomIds: commaList(input.matrixFreeResponseRoomIds),
            autoJoin: true,
            mentionOnly: true,
            shareSessionInChannel: false,
            threadIsolation: true,
            autoThread: true,
            progressMode: 'preview'
        }
        const credentials: ChannelCredentials = {
            accessToken: input.matrixAccessToken.trim()
        }
        return {
            agentId: input.agentId,
            provider: 'matrix',
            label: input.label.trim(),
            config,
            credentials
        }
    }
    if (input.provider === 'weixin') {
        if (!input.weixinBotToken.trim())
            throw new Error(
                translate('web.channels.settings.errors.weixinBotToken')
            )
        const config: WeixinChannelConfig = {
            botId: null,
            allowedUserIds: commaList(input.weixinAllowedUserIds),
            operatorUserIds: commaList(input.weixinOperatorUserIds),
            progressMode: 'final',
            outboundFiles: true,
            contextProjection: true
        }
        const credentials: ChannelCredentials = {
            botToken: input.weixinBotToken.trim(),
            baseUrl: input.weixinBaseUrl.trim() || null
        }
        return {
            agentId: input.agentId,
            provider: 'weixin',
            label: input.label.trim(),
            config,
            credentials
        }
    }
    if (input.provider === 'line') {
        const channelSecret = input.lineChannelSecret.trim()
        const channelAccessToken = input.lineChannelAccessToken.trim()
        if (!channelSecret || !channelAccessToken)
            throw new Error(
                translate('web.channels.settings.errors.lineCredentials')
            )
        const config: LineChannelConfig = {
            allowedUserIds: [],
            operatorUserIds: [],
            allowedChatIds: [],
            mentionOnly: true,
            shareSessionInChannel: false,
            progressMode: 'final'
        }
        const credentials: ChannelCredentials = {
            channelSecret,
            channelAccessToken
        }
        return {
            agentId: input.agentId,
            provider: 'line',
            label: input.label.trim(),
            config,
            credentials
        }
    }
    throw new Error(
        translate('web.channels.settings.errors.unsupportedProvider', {
            provider: input.provider
        })
    )
}

const commaList = (raw: string): string[] =>
    raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)

export default ChannelNew
