import type { AdminChatSessionSummary } from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { getLocale, t } from '@manyfold/i18n'
import { useApiClient } from '@/lib/apiClient'
import { adminRoutes } from '@/routes'
import { Badge, Card, CardBody, Heading } from '@/ui'
import { sessionStatusTone, turnStateTone } from '@/pages/ChatSessions/tones'

const PAGE_SIZE = 10

const AgentSessionsCard: FC<{ agentId: string }> = ({ agentId }): ReactNode => {
    const client = useApiClient()
    const [rows, setRows] = useState<AdminChatSessionSummary[] | null>(null)
    const [error, setError] = useState<string | null>(null)

    const refresh = useCallback((): void => {
        setError(null)
        client.admin.chatSessions
            .list({ agentId, limit: PAGE_SIZE })
            .then((page) => setRows(page.items))
            .catch((e: Error) => setError(e.message))
    }, [client, agentId])

    useEffect(refresh, [refresh])

    return (
        <Card elevation='ambient' className='mt-2'>
            <CardBody>
                <div className='mb-3 flex items-start justify-between gap-4'>
                    <div>
                        <Heading level={3} className='mb-1'>
                            {t('admin.agents.detail.sessions.title')}
                        </Heading>
                        <p className='text-caption text-body'>
                            {t('admin.agents.detail.sessions.subtitle')}
                        </p>
                    </div>
                    <Link
                        to={`${adminRoutes.chatSessions}?agentId=${encodeURIComponent(agentId)}`}
                        className='text-caption text-brand hover:text-brand-hover whitespace-nowrap'
                    >
                        {t('admin.agents.detail.sessions.viewAll')}
                    </Link>
                </div>

                {error && (
                    <pre className='text-caption-sm text-accent-ruby whitespace-pre-wrap'>
                        {error}
                    </pre>
                )}

                {rows === null && !error && (
                    <p className='text-caption text-body'>
                        {t('admin.agents.detail.sessions.loading')}
                    </p>
                )}

                {rows && rows.length === 0 && (
                    <p className='text-caption text-body'>
                        {t('admin.agents.detail.sessions.empty')}
                    </p>
                )}

                {rows && rows.length > 0 && (
                    <div className='overflow-x-auto'>
                        <table className='admin-table min-w-[900px]'>
                            <thead>
                                <tr>
                                    <th>
                                        {t(
                                            'admin.agents.detail.sessions.cols.session'
                                        )}
                                    </th>
                                    <th>
                                        {t(
                                            'admin.agents.detail.sessions.cols.user'
                                        )}
                                    </th>
                                    <th>
                                        {t(
                                            'admin.agents.detail.sessions.cols.status'
                                        )}
                                    </th>
                                    <th>
                                        {t(
                                            'admin.agents.detail.sessions.cols.lastTurn'
                                        )}
                                    </th>
                                    <th>
                                        {t(
                                            'admin.agents.detail.sessions.cols.messages'
                                        )}
                                    </th>
                                    <th>
                                        {t(
                                            'admin.agents.detail.sessions.cols.tokens'
                                        )}
                                    </th>
                                    <th>
                                        {t(
                                            'admin.agents.detail.sessions.cols.cost'
                                        )}
                                    </th>
                                    <th>
                                        {t(
                                            'admin.agents.detail.sessions.cols.lastActivity'
                                        )}
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                {rows.map((row) => (
                                    <tr key={row.id}>
                                        <td>
                                            <Link
                                                to={adminRoutes.chatSession(
                                                    row.id
                                                )}
                                                className='hover:text-brand block max-w-[18rem] truncate'
                                            >
                                                {row.title ?? 'Untitled'}
                                            </Link>
                                            <span className='text-caption-sm text-body font-mono'>
                                                {row.id}
                                            </span>
                                        </td>
                                        <td>
                                            <span className='block max-w-[14rem] truncate'>
                                                {row.userEmail ?? row.userId}
                                            </span>
                                        </td>
                                        <td>
                                            <Badge
                                                tone={
                                                    sessionStatusTone[
                                                        row.status
                                                    ]
                                                }
                                            >
                                                {row.status}
                                            </Badge>
                                        </td>
                                        <td>
                                            {row.lastTurnState ? (
                                                <Badge
                                                    tone={turnStateTone(
                                                        row.lastTurnState
                                                    )}
                                                >
                                                    {row.lastTurnState}
                                                </Badge>
                                            ) : (
                                                '—'
                                            )}
                                            {row.lastError && (
                                                <span className='text-accent-ruby text-caption-sm mt-0.5 block max-w-[24ch] truncate'>
                                                    {row.lastError.message ??
                                                        row.lastError.code ??
                                                        'error'}
                                                </span>
                                            )}
                                        </td>
                                        <td className='tnum'>
                                            {row.messageCount}
                                        </td>
                                        <td className='tnum whitespace-nowrap'>
                                            {row.inputTokens.toLocaleString()} /{' '}
                                            {row.outputTokens.toLocaleString()}
                                        </td>
                                        <td className='tnum'>
                                            {row.costUsd === null
                                                ? '—'
                                                : `$${row.costUsd.toFixed(4)}`}
                                        </td>
                                        <td className='tnum whitespace-nowrap'>
                                            {new Date(
                                                row.updatedAt
                                            ).toLocaleString(getLocale())}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </CardBody>
        </Card>
    )
}

export default AgentSessionsCard
