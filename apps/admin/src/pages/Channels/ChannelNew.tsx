import type {
    ChannelConfig,
    ChannelCredentials,
    ChannelProviderName,
    CreateChannelBody,
    LarkAppRegion,
    MatrixChannelConfig
} from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { SdkAgent } from '@manyfold/sdk'
import { useApiClient } from '@/lib/apiClient'
import { adminRoutes } from '@/routes'
import { Button, Card, Heading, Input } from '@/ui'

type SupportedProvider = Extract<
    ChannelProviderName,
    'telegram' | 'slack' | 'lark' | 'matrix'
>

const SUPPORTED: SupportedProvider[] = ['telegram', 'slack', 'lark', 'matrix']

const PROVIDER_LABEL: Record<SupportedProvider, string> = {
    telegram: 'Telegram',
    slack: 'Slack',
    lark: 'Lark or Feishu',
    matrix: 'Matrix'
}

const PROVIDER_HINT: Record<SupportedProvider, string> = {
    telegram:
        'Create a bot via @BotFather, paste the token. We will register the webhook on your behalf.',
    slack: 'Create a Slack app, install to your workspace, then paste the bot token (xoxb-) and signing secret. After saving, paste the webhook URL into Event Subscriptions.',
    lark: 'Create a Feishu or Lark app, choose the matching platform, copy the App ID + App Secret, then paste the inbound URL into 事件订阅 → 请求地址.',
    matrix: 'Paste a Matrix bot access token and homeserver URL. Matrix uses /sync long-polling, so no webhook URL is needed. Encrypted rooms are unsupported.'
}

const buildDefaultConfig = (provider: SupportedProvider): ChannelConfig => {
    if (provider === 'telegram')
        return {
            mentionOnly: true,
            shareSessionInChannel: false,
            threadIsolation: true,
            progressMode: 'preview'
        }
    if (provider === 'slack')
        return {
            allowedUserIds: [],
            operatorUserIds: [],
            mentionOnly: true,
            shareSessionInChannel: false,
            threadIsolation: true,
            progressMode: 'preview'
        }
    if (provider === 'matrix')
        return {
            homeserver: '',
            botUserId: null,
            botDisplayName: null,
            allowedRoomIds: [],
            allowedUserIds: [],
            freeResponseRoomIds: [],
            autoJoin: true,
            mentionOnly: true,
            shareSessionInChannel: false,
            threadIsolation: true,
            autoThread: true,
            progressMode: 'preview'
        }
    return {
        appId: '',
        appRegion: 'feishu',
        subscriptionMode: 'webhook',
        verificationToken: null,
        encryptKey: null,
        mentionOnly: true,
        shareSessionInChannel: false,
        threadIsolation: false,
        progressMode: 'preview',
        botName: null
    }
}

const ChannelNew: FC = (): ReactNode => {
    const client = useApiClient()
    const navigate = useNavigate()
    const [agents, setAgents] = useState<SdkAgent[]>([])
    const [provider, setProvider] = useState<SupportedProvider>('telegram')
    const [agentId, setAgentId] = useState<string>('')
    const [label, setLabel] = useState<string>('')
    const [tgBotToken, setTgBotToken] = useState<string>('')
    const [slackBotToken, setSlackBotToken] = useState<string>('')
    const [slackSigningSecret, setSlackSigningSecret] = useState<string>('')
    const [larkAppId, setLarkAppId] = useState<string>('')
    const [larkAppRegion, setLarkAppRegion] = useState<LarkAppRegion>('feishu')
    const [larkAppSecret, setLarkAppSecret] = useState<string>('')
    const [larkVerificationToken, setLarkVerificationToken] =
        useState<string>('')
    const [larkEncryptKey, setLarkEncryptKey] = useState<string>('')
    const [matrixHomeserver, setMatrixHomeserver] = useState<string>('')
    const [matrixAccessToken, setMatrixAccessToken] = useState<string>('')
    const [matrixAllowedRoomIds, setMatrixAllowedRoomIds] = useState<string>('')
    const [matrixAllowedUserIds, setMatrixAllowedUserIds] = useState<string>('')
    const [matrixFreeResponseRoomIds, setMatrixFreeResponseRoomIds] =
        useState<string>('')
    const [submitting, setSubmitting] = useState<boolean>(false)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        client.agents
            .list()
            .then((rows) => {
                setAgents(rows)
                setAgentId((cur) => (cur ? cur : (rows[0]?.id ?? '')))
            })
            .catch((e: Error) => setError(e.message))
    }, [client])

    const submit = async (): Promise<void> => {
        if (submitting) return
        setError(null)
        if (!agentId) {
            setError('Pick an agent first')
            return
        }
        if (!label.trim()) {
            setError('Label is required')
            return
        }
        let credentials: ChannelCredentials
        if (provider === 'telegram') {
            if (!tgBotToken.trim()) {
                setError('Telegram bot token is required')
                return
            }
            credentials = { botToken: tgBotToken.trim(), webhookSecret: null }
        } else if (provider === 'slack') {
            if (!slackBotToken.trim() || !slackSigningSecret.trim()) {
                setError('Bot token and signing secret are required')
                return
            }
            credentials = {
                botToken: slackBotToken.trim(),
                signingSecret: slackSigningSecret.trim()
            }
        } else if (provider === 'matrix') {
            if (!matrixHomeserver.trim() || !matrixAccessToken.trim()) {
                setError('Homeserver URL and access token are required')
                return
            }
            credentials = { accessToken: matrixAccessToken.trim() }
        } else {
            if (!larkAppId.trim() || !larkAppSecret.trim()) {
                setError('App ID and App Secret are required')
                return
            }
            credentials = { appSecret: larkAppSecret.trim() }
        }
        const config = buildDefaultConfig(provider)
        if (provider === 'lark') {
            const c = config as {
                appId: string
                appRegion: LarkAppRegion
                verificationToken: string | null
                encryptKey: string | null
            }
            c.appId = larkAppId.trim()
            c.appRegion = larkAppRegion
            c.verificationToken = larkVerificationToken.trim() || null
            c.encryptKey = larkEncryptKey.trim() || null
        }
        if (provider === 'matrix') {
            const c = config as MatrixChannelConfig
            c.homeserver = matrixHomeserver.trim()
            c.allowedRoomIds = commaList(matrixAllowedRoomIds)
            c.allowedUserIds = commaList(matrixAllowedUserIds)
            c.freeResponseRoomIds = commaList(matrixFreeResponseRoomIds)
        }
        const body: CreateChannelBody = {
            agentId,
            provider,
            label: label.trim(),
            config,
            credentials
        }
        setSubmitting(true)
        try {
            const detail = await client.channels.create(body)
            navigate(adminRoutes.channel(detail.id))
        } catch (err) {
            setError((err as Error).message)
            setSubmitting(false)
        }
    }

    return (
        <div className='mx-auto max-w-3xl'>
            <Heading level={2} className='mb-2'>
                New channel
            </Heading>

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

            <Card elevation='ambient' className='space-y-2 p-2'>
                <div>
                    <span className='text-caption text-label mb-2 block'>
                        Provider
                    </span>
                    <div className='flex gap-2'>
                        {SUPPORTED.map((p) => {
                            const active = provider === p
                            return (
                                <button
                                    key={p}
                                    type='button'
                                    onClick={(): void => setProvider(p)}
                                    className={`text-caption rounded-full border px-3 py-1 transition-colors ${
                                        active
                                            ? 'border-brand bg-brand-subtle text-brand'
                                            : 'border-border text-body hover:border-brand/40'
                                    }`}
                                >
                                    {PROVIDER_LABEL[p]}
                                </button>
                            )
                        })}
                    </div>
                    <p className='text-caption-sm text-body mt-2'>
                        {PROVIDER_HINT[provider]}
                    </p>
                </div>

                <div>
                    <label
                        htmlFor='agent'
                        className='text-caption text-label mb-1 block font-normal'
                    >
                        Agent
                    </label>
                    <select
                        id='agent'
                        className='border-border text-body text-heading focus:border-brand focus:ring-brand h-10 w-full rounded border bg-white px-2 transition-colors focus:ring-1 focus:outline-none'
                        value={agentId}
                        onChange={(e): void => setAgentId(e.target.value)}
                    >
                        {agents.length === 0 ? (
                            <option value=''>(no agents available)</option>
                        ) : (
                            agents.map((a) => (
                                <option key={a.id} value={a.id}>
                                    {a.name} — {a.framework}
                                </option>
                            ))
                        )}
                    </select>
                </div>

                <Input
                    id='label'
                    label='Label'
                    placeholder='e.g. team-engineering-tg'
                    value={label}
                    onChange={(e): void => setLabel(e.target.value)}
                />

                {provider === 'telegram' && (
                    <Input
                        id='tg-token'
                        label='Bot token'
                        placeholder='123456789:AAH...'
                        value={tgBotToken}
                        onChange={(e): void => setTgBotToken(e.target.value)}
                        hint='Token from @BotFather. Stored encrypted.'
                    />
                )}

                {provider === 'slack' && (
                    <>
                        <Input
                            id='slack-bot'
                            label='Bot token'
                            placeholder='xoxb-...'
                            value={slackBotToken}
                            onChange={(e): void =>
                                setSlackBotToken(e.target.value)
                            }
                            hint='OAuth & Permissions → Bot User OAuth Token.'
                        />
                        <Input
                            id='slack-sig'
                            label='Signing secret'
                            value={slackSigningSecret}
                            onChange={(e): void =>
                                setSlackSigningSecret(e.target.value)
                            }
                            hint='Basic Information → App Credentials → Signing Secret.'
                        />
                    </>
                )}

                {provider === 'lark' && (
                    <>
                        <div>
                            <label
                                htmlFor='lark-region'
                                className='text-caption text-label mb-1 block font-normal'
                            >
                                Platform
                            </label>
                            <select
                                id='lark-region'
                                className='border-border text-body text-heading focus:border-brand focus:ring-brand h-10 w-full rounded border bg-white px-2 transition-colors focus:ring-1 focus:outline-none'
                                value={larkAppRegion}
                                onChange={(e): void =>
                                    setLarkAppRegion(
                                        e.target.value as LarkAppRegion
                                    )
                                }
                            >
                                <option value='feishu'>Feishu</option>
                                <option value='lark'>Lark</option>
                            </select>
                        </div>
                        <Input
                            id='lark-app-id'
                            label='App ID'
                            placeholder='cli_a...'
                            value={larkAppId}
                            onChange={(e): void => setLarkAppId(e.target.value)}
                        />
                        <Input
                            id='lark-app-secret'
                            label='App Secret'
                            value={larkAppSecret}
                            onChange={(e): void =>
                                setLarkAppSecret(e.target.value)
                            }
                        />
                        <Input
                            id='lark-verify'
                            label='Verification Token (optional)'
                            value={larkVerificationToken}
                            onChange={(e): void =>
                                setLarkVerificationToken(e.target.value)
                            }
                        />
                        <Input
                            id='lark-encrypt'
                            label='Encrypt Key (optional)'
                            value={larkEncryptKey}
                            onChange={(e): void =>
                                setLarkEncryptKey(e.target.value)
                            }
                        />
                    </>
                )}

                {provider === 'matrix' && (
                    <>
                        <Input
                            id='matrix-homeserver'
                            label='Homeserver URL'
                            placeholder='https://matrix.example.org'
                            value={matrixHomeserver}
                            onChange={(e): void =>
                                setMatrixHomeserver(e.target.value)
                            }
                        />
                        <Input
                            id='matrix-token'
                            type='password'
                            label='Access token'
                            value={matrixAccessToken}
                            onChange={(e): void =>
                                setMatrixAccessToken(e.target.value)
                            }
                            hint='Stored encrypted. Encrypted Matrix rooms are unsupported; encrypted events are dropped.'
                        />
                        <Input
                            id='matrix-rooms'
                            label='Allowed room IDs (optional)'
                            value={matrixAllowedRoomIds}
                            onChange={(e): void =>
                                setMatrixAllowedRoomIds(e.target.value)
                            }
                            hint='Comma-separated Matrix room IDs. Leave blank to allow all rooms.'
                        />
                        <Input
                            id='matrix-users'
                            label='Allowed user IDs (optional)'
                            value={matrixAllowedUserIds}
                            onChange={(e): void =>
                                setMatrixAllowedUserIds(e.target.value)
                            }
                            hint='Comma-separated Matrix user IDs. Leave blank to allow all users.'
                        />
                        <Input
                            id='matrix-free-response-rooms'
                            label='Free-response room IDs (optional)'
                            value={matrixFreeResponseRoomIds}
                            onChange={(e): void =>
                                setMatrixFreeResponseRoomIds(e.target.value)
                            }
                            hint='In these rooms the bot replies without requiring a mention.'
                        />
                    </>
                )}

                <div className='flex justify-end gap-2'>
                    <Button
                        variant='ghost'
                        size='md'
                        onClick={(): void => navigate(adminRoutes.channels)}
                    >
                        Cancel
                    </Button>
                    <Button
                        variant='primary'
                        size='md'
                        onClick={(): void => {
                            void submit()
                        }}
                        disabled={submitting}
                    >
                        {submitting ? 'Creating…' : 'Create channel'}
                    </Button>
                </div>
            </Card>
        </div>
    )
}

const commaList = (raw: string): string[] =>
    raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)

export default ChannelNew