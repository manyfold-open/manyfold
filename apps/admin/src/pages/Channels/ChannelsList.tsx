import type {
    ChannelStatus,
    ChannelSummary,
    SdkUserSummary
} from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useApiClient } from '@/lib/apiClient'
import { useCurrentUser } from '@/lib/useCurrentUser'
import { adminRoutes } from '@/routes'
import { Badge, type BadgeTone, ButtonLink, Card, Heading } from '@/ui'

const statusTone: Record<ChannelStatus, BadgeTone> = {
    draft: 'neutral',
    active: 'success',
    paused: 'warning',
    error: 'error'
}

const ChannelsList: FC = (): ReactNode => {
    const client = useApiClient()
    const { isAdmin, loading } = useCurrentUser()
    const [rows, setRows] = useState<ChannelSummary[] | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [userMap, setUserMap] = useState<Record<string, SdkUserSummary>>({})

    useEffect(() => {
        if (loading) return
        const channelsApi = isAdmin ? client.admin.channels : client.channels
        channelsApi
            .list()
            .then(setRows)
            .catch((e: Error) => setError(e.message))
    }, [client, isAdmin, loading])

    useEffect(() => {
        if (!isAdmin) return
        client.admin.users
            .list()
            .then((rows) => {
                const map: Record<string, SdkUserSummary> = {}
                for (const u of rows) map[u.id] = u
                setUserMap(map)
            })
            .catch(() => {
                // owner column will fall back to userId
            })
    }, [client, isAdmin])

    return (
        <div className='mx-auto max-w-none'>
            <div className='mb-3 flex items-center justify-between'>
                <Heading level={2}>Channels</Heading>
                <ButtonLink
                    to={adminRoutes.channelNew}
                    variant='primary'
                    size='sm'
                >
                    New channel
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
                <p className='text-caption text-body'>Loading…</p>
            )}

            {rows && rows.length === 0 && (
                <div className='border-border-dashed rounded-lg border border-dashed bg-white p-4 text-center'>
                    <p className='admin-page-description'>
                        No channels yet. Connect a Telegram, Slack, Lark, or
                        Feishu bot to chat with your agent from a messenger.
                    </p>
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
                                    {isAdmin && (
                                        <th className='px-2 py-1.5 font-normal'>
                                            Owner
                                        </th>
                                    )}
                                    <th className='px-2 py-1.5 font-normal'>
                                        Provider
                                    </th>
                                    <th className='px-2 py-1.5 font-normal'>
                                        Agent
                                    </th>
                                    <th className='px-2 py-1.5 font-normal'>
                                        Status
                                    </th>
                                    <th className='px-2 py-1.5 font-normal'>
                                        Last connected
                                    </th>
                                    <th className='px-2 py-1.5 font-normal'>
                                        Updated
                                    </th>
                                </tr>
                            </thead>
                            <tbody className='divide-border divide-y'>
                                {rows.map((row) => (
                                    <tr
                                        key={row.id}
                                        className='text-caption text-heading hover:bg-surface-muted transition-colors'
                                    >
                                        <td className='px-2 py-1.5'>
                                            <Link
                                                to={adminRoutes.channel(row.id)}
                                                className='text-brand hover:text-brand-hover block'
                                            >
                                                {row.label}
                                                <div className='text-caption-sm text-body mt-1 font-mono'>
                                                    {row.id}
                                                </div>
                                            </Link>
                                        </td>
                                        {isAdmin && (
                                            <td className='px-2 py-1.5 font-mono'>
                                                {userMap[row.userId]?.email ??
                                                    row.userId}
                                            </td>
                                        )}
                                        <td className='px-2 py-1.5 font-mono'>
                                            {row.provider}
                                        </td>
                                        <td className='px-2 py-1.5'>
                                            <Link
                                                to={adminRoutes.agent(
                                                    row.agentId
                                                )}
                                                className='text-brand hover:text-brand-hover'
                                            >
                                                {row.agent.name}
                                            </Link>
                                        </td>
                                        <td className='px-2 py-1.5'>
                                            <Badge
                                                tone={statusTone[row.status]}
                                            >
                                                {row.status}
                                            </Badge>
                                            {row.lastErrorMessage && (
                                                <div className='text-caption-sm text-accent-ruby mt-1 max-w-xs truncate'>
                                                    {row.lastErrorMessage}
                                                </div>
                                            )}
                                        </td>
                                        <td className='tnum px-2 py-1.5'>
                                            {row.lastConnectedAt
                                                ? new Date(
                                                      row.lastConnectedAt
                                                  ).toLocaleString()
                                                : '—'}
                                        </td>
                                        <td className='tnum px-2 py-1.5'>
                                            {new Date(
                                                row.updatedAt
                                            ).toLocaleString()}
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

export default ChannelsList