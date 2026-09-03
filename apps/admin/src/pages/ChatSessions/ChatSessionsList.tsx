import type { AdminChatSessionSummary } from '@manyfold/shared'
import type { FC, FormEvent, ReactNode } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { getLocale } from '@manyfold/i18n'
import { useApiClient } from '@/lib/apiClient'
import { adminRoutes } from '@/routes'
import { Badge, Button, Card, Heading, Input } from '@/ui'
import { sessionStatusTone, turnStateTone } from './tones'

const PAGE_SIZE = 50

const ChatSessionsList: FC = (): ReactNode => {
    const client = useApiClient()
    const [params] = useSearchParams()
    const [items, setItems] = useState<AdminChatSessionSummary[] | null>(null)
    const [nextCursor, setNextCursor] = useState<string | null>(null)
    const [q, setQ] = useState('')
    const [runningOnly, setRunningOnly] = useState(false)
    const [hasError, setHasError] = useState(false)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const agentId = params.get('agentId') ?? undefined
    const userId = params.get('userId') ?? undefined

    const fetchPage = useCallback(
        async (opts: {
            append: boolean
            cursor: string | null
            running: boolean
            hasError: boolean
        }) => {
            setLoading(true)
            setError(null)
            try {
                const page = await client.admin.chatSessions.list({
                    q: q.trim() || undefined,
                    status: opts.running ? 'running' : undefined,
                    hasError: opts.hasError || undefined,
                    agentId,
                    userId,
                    cursor: opts.cursor ?? undefined,
                    limit: PAGE_SIZE
                })
                setItems((prev) =>
                    opts.append && prev ? [...prev, ...page.items] : page.items
                )
                setNextCursor(page.nextCursor)
            } catch (err) {
                setError((err as Error).message)
            } finally {
                setLoading(false)
            }
        },
        [client, q, agentId, userId]
    )

    useEffect(() => {
        void fetchPage({
            append: false,
            cursor: null,
            running: runningOnly,
            hasError
        })
    }, [client, agentId, userId])

    const submit = (e: FormEvent<HTMLFormElement>): void => {
        e.preventDefault()
        void fetchPage({
            append: false,
            cursor: null,
            running: runningOnly,
            hasError
        })
    }

    const toggleRunning = (): void => {
        const next = !runningOnly
        setRunningOnly(next)
        void fetchPage({
            append: false,
            cursor: null,
            running: next,
            hasError
        })
    }

    const toggleHasError = (): void => {
        const next = !hasError
        setHasError(next)
        void fetchPage({
            append: false,
            cursor: null,
            running: runningOnly,
            hasError: next
        })
    }

    return (
        <div className='mx-auto max-w-none'>
            <div className='mb-3'>
                <Heading level={2} className='mb-2'>
                    Chat sessions
                </Heading>
                <p className='admin-page-description max-w-2xl'>
                    Every agent chat session across all users, most recently
                    active first. Status is derived: a session is running while
                    a turn holds the session lock, and failed when its last turn
                    ended on an error.
                </p>
            </div>

            <form
                onSubmit={submit}
                className='mb-2 flex flex-wrap items-end gap-2'
            >
                <div className='w-full sm:w-96'>
                    <Input
                        id='q'
                        label='Search'
                        placeholder='Session title, or paste a full cts_… id'
                        value={q}
                        onChange={(e) => setQ(e.target.value)}
                    />
                </div>
                <Button type='submit' variant='neutral' size='md'>
                    Search
                </Button>
                <Button
                    type='button'
                    variant={runningOnly ? 'primary' : 'neutral'}
                    size='md'
                    onClick={toggleRunning}
                >
                    Running only
                </Button>
                <Button
                    type='button'
                    variant={hasError ? 'primary' : 'neutral'}
                    size='md'
                    onClick={toggleHasError}
                >
                    Has errors
                </Button>
            </form>

            {(agentId || userId) && (
                <p className='text-caption text-body mb-2'>
                    Filtered by{' '}
                    {agentId && (
                        <span className='font-mono'>agent {agentId}</span>
                    )}
                    {agentId && userId && ' · '}
                    {userId && <span className='font-mono'>user {userId}</span>}
                    {' · '}
                    <Link
                        to={adminRoutes.chatSessions}
                        className='hover:text-brand'
                    >
                        clear
                    </Link>
                </p>
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

            {items === null && !error && (
                <p className='text-caption text-body'>Loading…</p>
            )}

            {items && items.length === 0 && (
                <div className='border-border-dashed rounded-lg border border-dashed bg-white p-4 text-center'>
                    <p className='admin-page-description'>
                        No sessions match these filters.
                    </p>
                </div>
            )}

            {items && items.length > 0 && (
                <Card elevation='ambient' className='overflow-hidden'>
                    <div className='overflow-x-auto'>
                        <table className='admin-table w-full min-w-[1280px] text-left'>
                            <thead className='border-border bg-surface-subtle text-caption-sm text-body border-b'>
                                <tr>
                                    <th className='px-2 py-1.5 font-normal'>
                                        Session
                                    </th>
                                    <th className='px-2 py-1.5 font-normal'>
                                        User
                                    </th>
                                    <th className='px-2 py-1.5 font-normal'>
                                        Agent
                                    </th>
                                    <th className='px-2 py-1.5 font-normal'>
                                        Status
                                    </th>
                                    <th className='px-2 py-1.5 font-normal'>
                                        Last turn
                                    </th>
                                    <th className='px-2 py-1.5 font-normal'>
                                        Msgs
                                    </th>
                                    <th className='px-2 py-1.5 font-normal'>
                                        Tokens
                                    </th>
                                    <th className='px-2 py-1.5 font-normal'>
                                        Cost
                                    </th>
                                    <th className='px-2 py-1.5 font-normal'>
                                        Last activity
                                    </th>
                                </tr>
                            </thead>
                            <tbody className='divide-border divide-y'>
                                {items.map((row) => (
                                    <tr
                                        key={row.id}
                                        className='text-caption text-heading hover:bg-surface-muted transition-colors'
                                    >
                                        <td className='px-2 py-1.5'>
                                            <Link
                                                to={adminRoutes.chatSession(
                                                    row.id
                                                )}
                                                className='hover:text-brand block max-w-[22rem] truncate'
                                            >
                                                {row.title ?? 'Untitled'}
                                            </Link>
                                            <span className='text-caption-sm text-body font-mono'>
                                                {row.id}
                                            </span>
                                        </td>
                                        <td className='px-2 py-1.5'>
                                            <span className='block max-w-[16rem] truncate'>
                                                {row.userEmail ?? row.userId}
                                            </span>
                                        </td>
                                        <td className='px-2 py-1.5'>
                                            <span className='block max-w-[14rem] truncate'>
                                                {row.agentName ?? row.agentId}
                                            </span>
                                            {row.agentFramework && (
                                                <Badge tone='neutral'>
                                                    {row.agentFramework}
                                                </Badge>
                                            )}
                                        </td>
                                        <td className='px-2 py-1.5'>
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
                                        <td className='px-2 py-1.5'>
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
                                                <span className='text-accent-ruby text-caption-sm mt-0.5 block max-w-[28ch] truncate'>
                                                    {row.lastError.message ??
                                                        row.lastError.code ??
                                                        'error'}
                                                </span>
                                            )}
                                        </td>
                                        <td className='tnum px-2 py-1.5'>
                                            {row.messageCount}
                                        </td>
                                        <td className='tnum whitespace-nowrap px-2 py-1.5'>
                                            {row.inputTokens.toLocaleString()} /{' '}
                                            {row.outputTokens.toLocaleString()}
                                        </td>
                                        <td className='tnum px-2 py-1.5'>
                                            {row.costUsd === null
                                                ? '—'
                                                : `$${row.costUsd.toFixed(4)}`}
                                        </td>
                                        <td className='tnum whitespace-nowrap px-2 py-1.5'>
                                            {new Date(
                                                row.updatedAt
                                            ).toLocaleString(getLocale())}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </Card>
            )}

            {items && nextCursor && (
                <div className='mt-3 flex justify-center'>
                    <Button
                        variant='ghost'
                        size='sm'
                        disabled={loading}
                        onClick={() =>
                            void fetchPage({
                                append: true,
                                cursor: nextCursor,
                                running: runningOnly,
                                hasError
                            })
                        }
                    >
                        {loading ? 'Loading…' : 'Load more'}
                    </Button>
                </div>
            )}
        </div>
    )
}

export default ChatSessionsList
