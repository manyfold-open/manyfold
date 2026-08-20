import type {
    ChannelDetail as ChannelDetailType,
    ChannelScopeSummary,
    ChannelSessionSummary,
    ChannelStatus,
    ChannelTestResult,
    LarkChannelConfig
} from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { MoreVertical, Pause, Play, Trash2, Zap } from 'lucide-react'
import { useApiClient } from '@/lib/apiClient'
import { useCurrentUser } from '@/lib/useCurrentUser'
import { adminRoutes } from '@/routes'
import {
    Badge,
    type BadgeTone,
    Breadcrumbs,
    Button,
    Card,
    DetailPage,
    Heading
} from '@/ui'

const statusTone: Record<ChannelStatus, BadgeTone> = {
    draft: 'neutral',
    active: 'success',
    paused: 'warning',
    error: 'error'
}

const ChannelDetail: FC = (): ReactNode => {
    const client = useApiClient()
    const { isAdmin } = useCurrentUser()
    const channelsApi = isAdmin ? client.admin.channels : client.channels
    const navigate = useNavigate()
    const { id } = useParams<{ id: string }>()
    const [channel, setChannel] = useState<ChannelDetailType | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [testResult, setTestResult] = useState<ChannelTestResult | null>(null)
    const [testing, setTesting] = useState<boolean>(false)
    const [deleting, setDeleting] = useState<boolean>(false)
    const [copied, setCopied] = useState<boolean>(false)
    const [scopes, setScopes] = useState<ChannelScopeSummary[]>([])
    const [sessions, setSessions] = useState<ChannelSessionSummary[]>([])
    const [menuOpen, setMenuOpen] = useState<boolean>(false)
    const menuRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
        if (!id) return
        channelsApi
            .get(id)
            .then(setChannel)
            .catch((e: Error) => setError(e.message))
    }, [channelsApi, id])

    useEffect(() => {
        if (!id) return
        client.channels
            .listScopes(id)
            .then(setScopes)
            .catch(() => setScopes([]))
        client.channels
            .listSessions(id, { includeArchived: false })
            .then(setSessions)
            .catch(() => setSessions([]))
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

    const refresh = async (): Promise<void> => {
        if (!id) return
        const detail = await channelsApi.get(id)
        setChannel(detail)
    }

    const runTest = async (): Promise<void> => {
        if (!id) return
        setTesting(true)
        setTestResult(null)
        try {
            const res = await channelsApi.test(id)
            setTestResult(res)
        } catch (err) {
            setTestResult({ ok: false, message: (err as Error).message })
        } finally {
            setTesting(false)
        }
    }

    const togglePause = async (): Promise<void> => {
        if (!channel) return
        const next: ChannelStatus =
            channel.status === 'active' ? 'paused' : 'active'
        await channelsApi.update(channel.id, { status: next })
        await refresh()
    }

    const remove = async (): Promise<void> => {
        if (!channel) return
        if (
            !window.confirm(
                `Delete channel "${channel.label}"? This will also remove the webhook (Telegram) and stop inbound traffic.`
            )
        )
            return
        setDeleting(true)
        try {
            await channelsApi.delete(channel.id)
            navigate(adminRoutes.channels)
        } catch (err) {
            setError((err as Error).message)
            setDeleting(false)
        }
    }

    const copyUrl = async (): Promise<void> => {
        if (!channel) return
        await navigator.clipboard.writeText(channel.inboundUrl)
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1500)
    }

    const breadcrumbs = (
        <Breadcrumbs
            items={[
                { label: 'Channels', to: adminRoutes.channels },
                { label: channel?.label ?? id ?? 'Channel' }
            ]}
        />
    )

    if (error)
        return (
            <DetailPage>
                {breadcrumbs}
                <Card
                    elevation='flat'
                    className='border-accent-ruby/30 bg-accent-ruby/5 p-2'
                >
                    <pre className='text-caption-sm text-accent-ruby whitespace-pre-wrap'>
                        {error}
                    </pre>
                </Card>
            </DetailPage>
        )
    if (!channel)
        return (
            <DetailPage>
                {breadcrumbs}
                <p className='text-caption text-body'>Loading…</p>
            </DetailPage>
        )

    return (
        <DetailPage>
            {breadcrumbs}
            <div className='mb-2 flex items-center justify-between gap-4'>
                <div>
                    <Heading level={2}>{channel.label}</Heading>
                    <p className='text-caption text-body mt-1 font-mono'>
                        {channel.id}
                    </p>
                </div>
                <div className='flex items-center gap-2'>
                    <Badge tone={statusTone[channel.status]}>
                        {channel.status}
                    </Badge>
                    <div ref={menuRef} className='relative'>
                        <button
                            type='button'
                            onClick={(): void => setMenuOpen((value) => !value)}
                            aria-label='More'
                            title='More'
                            aria-haspopup='menu'
                            aria-expanded={menuOpen}
                            className='text-body hover:bg-surface-muted hover:text-heading focus-visible:ring-brand inline-flex h-7 w-7 items-center justify-center rounded border border-transparent transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2'
                        >
                            <MoreVertical className='h-4 w-4' />
                        </button>
                        {menuOpen && (
                            <div
                                role='menu'
                                className='border-border shadow-elevated absolute right-0 top-full z-30 mt-1 w-48 rounded-lg border bg-white p-1'
                            >
                                <button
                                    type='button'
                                    role='menuitem'
                                    disabled={testing}
                                    onClick={(): void => {
                                        setMenuOpen(false)
                                        void runTest()
                                    }}
                                    className={menuItemClass}
                                >
                                    <Zap className='h-3.5 w-3.5 shrink-0' />
                                    <span className='flex-1 text-left'>
                                        {testing
                                            ? 'Testing…'
                                            : 'Test connection'}
                                    </span>
                                </button>
                                <button
                                    type='button'
                                    role='menuitem'
                                    disabled={
                                        channel.status !== 'active' &&
                                        channel.status !== 'paused'
                                    }
                                    onClick={(): void => {
                                        setMenuOpen(false)
                                        void togglePause()
                                    }}
                                    className={menuItemClass}
                                >
                                    {channel.status === 'active' ? (
                                        <Pause className='h-3.5 w-3.5 shrink-0' />
                                    ) : (
                                        <Play className='h-3.5 w-3.5 shrink-0' />
                                    )}
                                    <span className='flex-1 text-left'>
                                        {channel.status === 'active'
                                            ? 'Pause'
                                            : 'Resume'}
                                    </span>
                                </button>
                                <div className='border-border my-1 border-t' />
                                <button
                                    type='button'
                                    role='menuitem'
                                    disabled={deleting}
                                    onClick={(): void => {
                                        setMenuOpen(false)
                                        void remove()
                                    }}
                                    className={destructiveMenuItemClass}
                                >
                                    <Trash2 className='h-3.5 w-3.5 shrink-0' />
                                    <span className='flex-1 text-left'>
                                        {deleting ? 'Deleting…' : 'Delete'}
                                    </span>
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            </div>

            <Card elevation='ambient' className='mb-2 space-y-3 p-2'>
                <div className='text-caption grid grid-cols-2 gap-2'>
                    <div>
                        <span className='text-label block'>Provider</span>
                        <span className='text-heading font-mono'>
                            {channel.provider}
                        </span>
                    </div>
                    <div>
                        <span className='text-label block'>Agent</span>
                        <span className='text-heading'>
                            {channel.agent.name}
                        </span>
                    </div>
                    <div>
                        <span className='text-label block'>Last connected</span>
                        <span className='text-heading tnum'>
                            {channel.lastConnectedAt
                                ? new Date(
                                      channel.lastConnectedAt
                                  ).toLocaleString()
                                : '—'}
                        </span>
                    </div>
                    <div>
                        <span className='text-label block'>Last error</span>
                        <span className='text-heading'>
                            {channel.lastErrorMessage ?? '—'}
                        </span>
                    </div>
                </div>
                {hasWebhookUrl(channel) ? (
                    <div>
                        <span className='text-label text-caption mb-1 block'>
                            Webhook URL
                        </span>
                        <div className='flex items-center gap-2'>
                            <code className='border-border text-caption-sm text-heading flex-1 truncate rounded border bg-white px-3 py-2 font-mono'>
                                {channel.inboundUrl}
                            </code>
                            <Button
                                variant='ghost'
                                size='sm'
                                onClick={(): void => {
                                    void copyUrl()
                                }}
                            >
                                {copied ? 'Copied' : 'Copy'}
                            </Button>
                        </div>
                        <p className='text-caption-sm text-body mt-1'>
                            {channel.provider === 'telegram'
                                ? 'Telegram webhook is registered automatically when credentials are saved.'
                                : channel.provider === 'slack'
                                  ? 'Paste this URL into your Slack app under Event Subscriptions → Request URL.'
                                  : 'Paste this URL into your provider event subscription configuration.'}
                        </p>
                    </div>
                ) : (
                    <div>
                        <span className='text-label text-caption mb-1 block'>
                            Inbound mode
                        </span>
                        <p className='text-caption-sm text-heading'>
                            {channel.provider === 'matrix'
                                ? 'Matrix /sync long-polling. No webhook URL is needed.'
                                : channel.provider === 'discord'
                                  ? 'Discord Gateway WebSocket. No webhook URL is needed.'
                                  : 'Long connection. No webhook URL is needed.'}
                        </p>
                    </div>
                )}
            </Card>

            {testResult && (
                <pre
                    className={`text-caption-sm mb-2 rounded border p-3 whitespace-pre-wrap ${
                        testResult.ok
                            ? 'border-success-ring bg-success-bg text-success-text'
                            : 'border-accent-ruby/30 bg-accent-ruby/5 text-accent-ruby'
                    }`}
                >
                    {testResult.message}
                </pre>
            )}

            <Card elevation='ambient' className='overflow-hidden'>
                <div className='border-border border-b px-4 py-2.5'>
                    <Heading level={3}>Scopes</Heading>
                </div>
                {scopes.length === 0 ? (
                    <p className='text-caption text-body p-2'>
                        No scopes yet. A scope appears when the channel
                        receives its first message in a chat/thread.
                    </p>
                ) : (
                    <div className='overflow-x-auto'>
                        <table className='admin-table min-w-[760px]'>
                            <thead>
                                <tr>
                                    <th>Scope</th>
                                    <th>Name</th>
                                    <th>Sessions</th>
                                    <th>Active session</th>
                                    <th>Last activity</th>
                                </tr>
                            </thead>
                            <tbody>
                                {scopes.map((s) => (
                                    <tr key={s.scopeKey}>
                                        <td className='font-mono'>
                                            {s.scopeKey}
                                        </td>
                                        <td>{s.scopeName ?? '—'}</td>
                                        <td className='tnum'>
                                            {s.sessionCount}
                                        </td>
                                        <td className='font-mono'>
                                            {s.activeSession
                                                ? s.activeSession
                                                      .channelSessionId
                                                : '—'}
                                        </td>
                                        <td className='tnum whitespace-nowrap'>
                                            {s.lastActivityAt
                                                ? new Date(
                                                      s.lastActivityAt
                                                  ).toLocaleString()
                                                : '—'}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </Card>

            <Card elevation='ambient' className='overflow-hidden'>
                <div className='border-border border-b px-4 py-2.5'>
                    <Heading level={3}>Sessions</Heading>
                </div>
                {sessions.length === 0 ? (
                    <p className='text-caption text-body p-2'>
                        No sessions yet.
                    </p>
                ) : (
                    <div className='overflow-x-auto'>
                        <table className='admin-table min-w-[760px]'>
                            <thead>
                                <tr>
                                    <th></th>
                                    <th>Channel session</th>
                                    <th>Scope</th>
                                    <th>Name</th>
                                    <th>Chat title</th>
                                    <th>Created</th>
                                </tr>
                            </thead>
                            <tbody>
                                {sessions.map((s) => (
                                    <tr key={s.channelSessionId}>
                                        <td className='font-mono'>
                                            {s.isActive
                                                ? '▶'
                                                : s.archivedAt
                                                  ? '✗'
                                                  : '◻'}
                                        </td>
                                        <td className='font-mono'>
                                            {s.channelSessionId}
                                        </td>
                                        <td className='font-mono'>
                                            {s.scopeKey}
                                        </td>
                                        <td>{s.displayName ?? '—'}</td>
                                        <td>
                                            <span className='block max-w-[24rem] truncate'>
                                                {s.chatTitle ?? '—'}
                                            </span>
                                        </td>
                                        <td className='tnum whitespace-nowrap'>
                                            {new Date(
                                                s.createdAt
                                            ).toLocaleString()}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </Card>

            <Card elevation='ambient' className='overflow-hidden'>
                <div className='border-border border-b px-4 py-2.5'>
                    <Heading level={3}>Recent deliveries</Heading>
                </div>
                {channel.recentDeliveries.length === 0 ? (
                    <p className='text-caption text-body p-2'>
                        No deliveries yet.
                    </p>
                ) : (
                    <div className='overflow-x-auto'>
                        <table className='admin-table min-w-[760px]'>
                            <thead>
                                <tr>
                                    <th>Direction</th>
                                    <th>Status</th>
                                    <th>Scope</th>
                                    <th>Summary</th>
                                    <th>At</th>
                                </tr>
                            </thead>
                            <tbody>
                                {channel.recentDeliveries.map((d) => (
                                    <tr key={d.id}>
                                        <td className='font-mono'>
                                            {d.direction}
                                        </td>
                                        <td className='font-mono'>
                                            {d.status}
                                        </td>
                                        <td className='font-mono'>
                                            {d.scopeKey}
                                        </td>
                                        <td>
                                            <span
                                                className={`block max-w-[24rem] truncate ${
                                                    d.errorMessage
                                                        ? 'text-accent-ruby'
                                                        : 'text-heading'
                                                }`}
                                            >
                                                {d.errorMessage ??
                                                    d.summaryText ??
                                                    '—'}
                                            </span>
                                        </td>
                                        <td className='tnum whitespace-nowrap'>
                                            {new Date(
                                                d.createdAt
                                            ).toLocaleString()}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </Card>
        </DetailPage>
    )
}

const menuItemClass =
    'text-caption text-body hover:bg-surface-muted flex w-full items-center gap-2 rounded px-2.5 py-1.5 transition-colors disabled:cursor-not-allowed disabled:opacity-50'

const destructiveMenuItemClass =
    'text-caption text-accent-ruby hover:bg-accent-ruby/5 flex w-full items-center gap-2 rounded px-2.5 py-1.5 transition-colors disabled:cursor-not-allowed disabled:opacity-50'

const hasWebhookUrl = (channel: ChannelDetailType): boolean => {
    if (channel.provider === 'discord' || channel.provider === 'matrix')
        return false
    if (channel.provider !== 'lark') return true
    return (
        (channel.config as LarkChannelConfig).subscriptionMode !== 'websocket'
    )
}

export default ChannelDetail