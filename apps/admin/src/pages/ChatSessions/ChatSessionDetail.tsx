import type {
    AdminChatSessionDetail as SessionDetail,
    AdminChatSessionTurn as SessionTurn,
    AdminChatStreamEvent
} from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { Fragment, useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { getLocale } from '@manyfold/i18n'
import { useApiClient } from '@/lib/apiClient'
import { adminRoutes } from '@/routes'
import {
    Badge,
    Breadcrumbs,
    Button,
    Card,
    DetailPage,
    Heading,
    type BadgeTone
} from '@/ui'
import { sessionCompaction, turnCompaction } from './compaction'
import { sessionStatusTone, turnStateTone } from './tones'

const EVENTS_PAGE_SIZE = 100

const KNOWN_EVENT_TYPES = [
    'token',
    'thinking',
    'tool_call',
    'tool_result',
    'replace',
    'error',
    'done',
    'suspended',
    'turn_status'
]

// Token rows dominate a busy session (one row per ~120ms of streaming), so they
// start hidden — everything else is what tells you whether the turn worked.
const DEFAULT_EVENT_TYPES = KNOWN_EVENT_TYPES.filter((t) => t !== 'token')

const eventTone = (eventType: string): BadgeTone => {
    if (eventType === 'error') return 'error'
    if (eventType === 'done') return 'success'
    if (eventType === 'suspended' || eventType === 'turn_status')
        return 'warning'
    if (eventType === 'tool_call' || eventType === 'tool_result') return 'brand'
    return 'neutral'
}

const formatMs = (value: number | null): string =>
    value === null ? '—' : `${value.toLocaleString()} ms`

const formatDuration = (ms: number): string =>
    ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`

const previewPayload = (payload: unknown): string => {
    const text = JSON.stringify(payload) ?? 'null'
    return text.length > 120 ? `${text.slice(0, 120)}…` : text
}

interface EventTiming {
    offsetMs: number
    deltaMs: number
    barLeftPct: number
    barWidthPct: number
}

// Span-style timings, measured per turn against the events actually loaded:
// each event's bar covers the gap since the previous one, so a long bar is
// time the agent spent before emitting that event. Hiding a type (tokens, by
// default) widens the gaps around it — these are waits between *visible*
// events, not raw event-to-event deltas.
const buildTimings = (
    events: AdminChatStreamEvent[]
): Map<string, EventTiming> => {
    const byTurn = new Map<string, AdminChatStreamEvent[]>()
    for (const event of events) {
        const list = byTurn.get(event.messageId)
        if (list) list.push(event)
        else byTurn.set(event.messageId, [event])
    }
    const timings = new Map<string, EventTiming>()
    for (const list of byTurn.values()) {
        const ordered = [...list].sort((a, b) =>
            BigInt(a.id) < BigInt(b.id) ? -1 : 1
        )
        const first = ordered[0]
        const last = ordered[ordered.length - 1]
        if (!first || !last) continue
        const start = Date.parse(first.createdAt)
        const span = Math.max(Date.parse(last.createdAt) - start, 1)
        let prev = start
        for (const event of ordered) {
            const at = Date.parse(event.createdAt)
            const offsetMs = at - start
            const deltaMs = at - prev
            prev = at
            const barWidthPct = Math.max((deltaMs / span) * 100, 1.5)
            timings.set(event.id, {
                offsetMs,
                deltaMs,
                barWidthPct,
                barLeftPct: Math.max(
                    Math.min(
                        ((offsetMs - deltaMs) / span) * 100,
                        100 - barWidthPct
                    ),
                    0
                )
            })
        }
    }
    return timings
}

const DetailRow: FC<{ label: string; children: ReactNode }> = ({
    label,
    children
}): ReactNode => (
    <div className='flex gap-2 py-1'>
        <dt className='text-caption text-body w-44 shrink-0'>{label}</dt>
        <dd className='text-caption text-heading min-w-0 break-all'>
            {children}
        </dd>
    </div>
)

// Both figures are rendered as text rather than hung off a title attribute:
// "how much was taken" and "when it was last taken" are the two things an
// operator compares against the event counts, and a tooltip is not available
// to a screen reader or to a copied screenshot.
const StreamLogCell: FC<{ turn: SessionTurn }> = ({ turn }): ReactNode => {
    const compaction = turnCompaction(turn, getLocale())
    if (!compaction.compacted) return compaction.label
    return (
        <>
            <Badge tone='warning'>{compaction.label}</Badge>
            <span className='text-caption-sm text-body ml-1'>
                {compaction.at}
            </span>
        </>
    )
}

const ChatSessionDetail: FC = (): ReactNode => {
    const { id } = useParams<{ id: string }>()
    const client = useApiClient()
    const [detail, setDetail] = useState<SessionDetail | null>(null)
    const [error, setError] = useState<string | null>(null)

    const [events, setEvents] = useState<AdminChatStreamEvent[] | null>(null)
    const [eventsCursor, setEventsCursor] = useState<string | null>(null)
    const [eventsLoading, setEventsLoading] = useState(false)
    const [eventsError, setEventsError] = useState<string | null>(null)
    const [types, setTypes] = useState<string[]>(DEFAULT_EVENT_TYPES)
    const [expandedId, setExpandedId] = useState<string | null>(null)
    const [lockedTurn, setLockedTurn] = useState<string | null>(null)

    const refresh = useCallback((): void => {
        if (!id) return
        setError(null)
        client.admin.chatSessions
            .get(id)
            .then(setDetail)
            .catch((e: Error) => setError(e.message))
    }, [client, id])

    useEffect(refresh, [refresh])

    const fetchEvents = useCallback(
        async (opts: {
            append: boolean
            cursor: string | null
            selected: string[]
            turn: string | null
        }) => {
            if (!id) return
            // An empty type set means "show nothing"; sending no types at all
            // would read as "no filter" and return every event instead.
            if (opts.selected.length === 0) {
                setEvents([])
                setEventsCursor(null)
                return
            }
            setEventsLoading(true)
            setEventsError(null)
            try {
                const page = await client.admin.chatSessions.listEvents(id, {
                    limit: EVENTS_PAGE_SIZE,
                    // A locked turn reads as a trace, so run it oldest-first;
                    // the whole-session view stays newest-first.
                    order: opts.turn ? 'asc' : 'desc',
                    types: opts.selected,
                    messageId: opts.turn ?? undefined,
                    cursor: opts.cursor ?? undefined
                })
                setEvents((prev) =>
                    opts.append && prev ? [...prev, ...page.items] : page.items
                )
                setEventsCursor(page.nextCursor)
            } catch (err) {
                setEventsError((err as Error).message)
            } finally {
                setEventsLoading(false)
            }
        },
        [client, id]
    )

    useEffect(() => {
        void fetchEvents({
            append: false,
            cursor: null,
            selected: types,
            turn: lockedTurn
        })
    }, [fetchEvents])

    const toggleType = (type: string): void => {
        const next = types.includes(type)
            ? types.filter((t) => t !== type)
            : [...types, type]
        setTypes(next)
        void fetchEvents({
            append: false,
            cursor: null,
            selected: next,
            turn: lockedTurn
        })
    }

    const lockTurn = (messageId: string | null): void => {
        setLockedTurn(messageId)
        setExpandedId(null)
        void fetchEvents({
            append: false,
            cursor: null,
            selected: types,
            turn: messageId
        })
    }

    const breadcrumbs = (
        <Breadcrumbs
            items={[
                { label: 'Chat sessions', to: adminRoutes.chatSessions },
                { label: detail?.session.title ?? id ?? 'Session' }
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
    if (!detail)
        return (
            <DetailPage>
                {breadcrumbs}
                <p className='text-caption text-body'>Loading…</p>
            </DetailPage>
        )

    const session = detail.session
    const eventTypeSummary = Object.entries(detail.eventCounts).sort((a, b) =>
        a[0].localeCompare(b[0])
    )
    const filterTypes = [
        ...new Set([...KNOWN_EVENT_TYPES, ...Object.keys(detail.eventCounts)])
    ]
    const compaction = sessionCompaction(detail.turns, getLocale())
    const timings = buildTimings(events ?? [])

    return (
        <DetailPage>
            {breadcrumbs}
            <div className='mb-2 flex items-center justify-between gap-4'>
                <div className='min-w-0'>
                    <Heading level={2}>{session.title ?? 'Untitled'}</Heading>
                    <p className='text-caption text-body mt-1 font-mono'>
                        {session.id}
                    </p>
                </div>
                <div className='flex items-center gap-2'>
                    <Badge tone={sessionStatusTone[session.status]}>
                        {session.status}
                    </Badge>
                    <Button variant='neutral' size='sm' onClick={refresh}>
                        Refresh
                    </Button>
                </div>
            </div>

            <div className='space-y-4'>
                <Card elevation='ambient' className='overflow-hidden'>
                    <div className='border-border border-b px-4 py-2.5'>
                        <Heading level={3}>Session</Heading>
                    </div>
                    <dl className='divide-border divide-y px-4 py-2'>
                        <DetailRow label='User'>
                            <Link
                                to={`${adminRoutes.chatSessions}?userId=${session.userId}`}
                                className='hover:text-brand'
                            >
                                {session.userEmail ?? session.userId}
                            </Link>
                            <span className='text-body ml-2 font-mono'>
                                {session.userId}
                            </span>
                        </DetailRow>
                        <DetailRow label='Agent'>
                            <Link
                                to={adminRoutes.agent(session.agentId)}
                                className='hover:text-brand'
                            >
                                {session.agentName ?? session.agentId}
                            </Link>
                            <span className='ml-2'>
                                {session.agentFramework && (
                                    <Badge tone='neutral'>
                                        {session.agentFramework}
                                    </Badge>
                                )}{' '}
                                {session.agentRuntime && (
                                    <Badge tone='neutral'>
                                        {session.agentRuntime}
                                    </Badge>
                                )}
                            </span>
                        </DetailRow>
                        <DetailRow label='Channel'>
                            {session.channel
                                ? `${session.channel.provider} · ${session.channel.label}`
                                : '—'}
                        </DetailRow>
                        <DetailRow label='Framework session'>
                            <span className='font-mono'>
                                {session.frameworkSessionRef ?? '—'}
                            </span>
                        </DetailRow>
                        <DetailRow label='Inflight message'>
                            <span className='font-mono'>
                                {session.inflightMessageId ?? '—'}
                            </span>
                        </DetailRow>
                        <DetailRow label='Messages'>
                            {session.messageCount}
                        </DetailRow>
                        <DetailRow label='Tokens in / out'>
                            {session.inputTokens.toLocaleString()} /{' '}
                            {session.outputTokens.toLocaleString()}
                        </DetailRow>
                        <DetailRow label='Cost'>
                            {session.costUsd === null
                                ? '—'
                                : `$${session.costUsd.toFixed(4)}`}
                        </DetailRow>
                        <DetailRow label='Events'>
                            {eventTypeSummary.length === 0
                                ? '—'
                                : eventTypeSummary.map(([type, total], i) => (
                                      <span key={type}>
                                          {i > 0 && ' · '}
                                          <span
                                              className={
                                                  type === 'error'
                                                      ? 'text-accent-ruby'
                                                      : undefined
                                              }
                                          >
                                              {type} ×{total}
                                          </span>
                                      </span>
                                  ))}
                            {compaction.note && (
                                <span className='text-accent-lemon mt-0.5 block'>
                                    {compaction.note}
                                </span>
                            )}
                        </DetailRow>
                        <DetailRow label='Created'>
                            {new Date(session.createdAt).toLocaleString(
                                getLocale()
                            )}
                        </DetailRow>
                        <DetailRow label='Last activity'>
                            {new Date(session.updatedAt).toLocaleString(
                                getLocale()
                            )}
                        </DetailRow>
                    </dl>
                </Card>

                <Card elevation='ambient' className='overflow-hidden'>
                    <div className='border-border border-b px-4 py-2.5'>
                        <Heading level={3}>Turns</Heading>
                        <p className='text-caption text-body mt-1'>
                            Click a turn to trace only its events below. Click
                            it again to go back to the whole session. Stream log
                            reports the token/thinking rows retention has
                            already deleted from a turn, so an em dash means the
                            turn was never compacted.
                        </p>
                    </div>
                    {detail.turns.length === 0 ? (
                        <p className='text-caption text-body p-2'>
                            No assistant turns yet.
                        </p>
                    ) : (
                        <div className='overflow-x-auto'>
                            <table className='admin-table min-w-[1240px]'>
                                <thead>
                                    <tr>
                                        <th>Message</th>
                                        <th>Started</th>
                                        <th>State</th>
                                        <th>Runtime</th>
                                        <th>Model</th>
                                        <th>Tokens</th>
                                        <th>Cost</th>
                                        <th>TTFT</th>
                                        <th>Duration</th>
                                        <th className='text-right'>
                                            Stream log
                                        </th>
                                        <th>Error</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {detail.turns.map((turn) => (
                                        <tr
                                            key={turn.messageId}
                                            aria-selected={
                                                lockedTurn === turn.messageId
                                            }
                                            className={`hover:bg-surface-muted cursor-pointer transition-colors${
                                                lockedTurn === turn.messageId
                                                    ? 'bg-brand-subtle'
                                                    : ''
                                            }`}
                                            onClick={() =>
                                                lockTurn(
                                                    lockedTurn ===
                                                        turn.messageId
                                                        ? null
                                                        : turn.messageId
                                                )
                                            }
                                        >
                                            <td className='font-mono'>
                                                {turn.messageId}
                                            </td>
                                            <td className='tnum whitespace-nowrap'>
                                                {new Date(
                                                    turn.createdAt
                                                ).toLocaleString(getLocale())}
                                            </td>
                                            <td>
                                                {turn.execution ? (
                                                    <Badge
                                                        tone={turnStateTone(
                                                            turn.execution.state
                                                        )}
                                                    >
                                                        {turn.execution.state}
                                                    </Badge>
                                                ) : (
                                                    '—'
                                                )}
                                                {turn.execution &&
                                                    turn.execution.adoptCount >
                                                        0 && (
                                                        <Badge tone='warning'>
                                                            adopted ×
                                                            {
                                                                turn.execution
                                                                    .adoptCount
                                                            }
                                                        </Badge>
                                                    )}
                                            </td>
                                            <td>
                                                {turn.execution
                                                    ? `${turn.execution.runtime}${
                                                          turn.execution
                                                              .spriteName
                                                              ? ` · ${turn.execution.spriteName}`
                                                              : ''
                                                      }`
                                                    : '—'}
                                            </td>
                                            <td>{turn.model ?? '—'}</td>
                                            <td className='tnum whitespace-nowrap'>
                                                {turn.inputTokens === null &&
                                                turn.outputTokens === null
                                                    ? '—'
                                                    : `${turn.inputTokens ?? 0} / ${turn.outputTokens ?? 0}`}
                                            </td>
                                            <td className='tnum'>
                                                {turn.costUsd === null
                                                    ? '—'
                                                    : `$${turn.costUsd.toFixed(4)}`}
                                            </td>
                                            <td className='tnum whitespace-nowrap'>
                                                {formatMs(turn.firstTokenMs)}
                                            </td>
                                            <td className='tnum whitespace-nowrap'>
                                                {formatMs(turn.totalMs)}
                                            </td>
                                            <td className='tnum whitespace-nowrap text-right'>
                                                <StreamLogCell turn={turn} />
                                            </td>
                                            <td>
                                                {turn.error ? (
                                                    <span className='text-accent-ruby block max-w-[24rem] truncate'>
                                                        {turn.error.message ??
                                                            turn.error.code ??
                                                            'error'}
                                                    </span>
                                                ) : (
                                                    '—'
                                                )}
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
                        <Heading level={3}>Events</Heading>
                        <p className='text-caption text-body mt-1'>
                            {lockedTurn
                                ? 'Oldest first, as a trace of one turn. Each bar covers the gap since the previous shown event.'
                                : 'Newest first, across the whole session. Click a row to expand its payload.'}{' '}
                            Only rows still stored are listed; a compacted turn
                            no longer has its token/thinking events.
                        </p>
                        {lockedTurn && (
                            <div className='mt-2 flex items-center gap-2'>
                                <span className='border-brand-light bg-brand-subtle text-brand text-caption-sm inline-flex items-center gap-1 rounded border px-2 py-0.5'>
                                    <span className='font-mono'>
                                        turn {lockedTurn}
                                    </span>
                                    <button
                                        type='button'
                                        aria-label='Clear turn filter'
                                        title='Clear turn filter'
                                        className='hover:text-heading leading-none'
                                        onClick={() => lockTurn(null)}
                                    >
                                        ×
                                    </button>
                                </span>
                                <Button
                                    variant='ghost'
                                    size='sm'
                                    onClick={() => lockTurn(null)}
                                >
                                    Show whole session
                                </Button>
                            </div>
                        )}
                    </div>
                    <div className='border-border flex flex-wrap gap-1 border-b px-4 py-2'>
                        {filterTypes.map((type) => (
                            <Button
                                key={type}
                                type='button'
                                size='sm'
                                variant={
                                    types.includes(type) ? 'primary' : 'neutral'
                                }
                                onClick={() => toggleType(type)}
                            >
                                {type}
                                {detail.eventCounts[type]
                                    ? ` (${detail.eventCounts[type]})`
                                    : ''}
                            </Button>
                        ))}
                    </div>

                    {eventsError && (
                        <pre className='text-caption-sm text-accent-ruby whitespace-pre-wrap p-2'>
                            {eventsError}
                        </pre>
                    )}

                    {events === null && !eventsError && (
                        <p className='text-caption text-body p-2'>Loading…</p>
                    )}

                    {events && events.length === 0 && (
                        <p className='text-caption text-body p-2'>
                            No events match the selected types.
                        </p>
                    )}

                    {events && events.length > 0 && (
                        <div className='overflow-x-auto'>
                            <table className='admin-table min-w-[1400px]'>
                                <thead>
                                    <tr>
                                        <th>Id</th>
                                        <th>Seq</th>
                                        <th>Type</th>
                                        <th>Message</th>
                                        <th>Δ</th>
                                        <th>Timeline</th>
                                        <th>Runner seq</th>
                                        <th>Time</th>
                                        <th>Payload</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {events.map((event) => {
                                        const timing = timings.get(event.id)
                                        return (
                                            <Fragment key={event.id}>
                                                <tr
                                                    className='hover:bg-surface-muted cursor-pointer transition-colors'
                                                    onClick={() =>
                                                        setExpandedId((prev) =>
                                                            prev === event.id
                                                                ? null
                                                                : event.id
                                                        )
                                                    }
                                                >
                                                    <td className='font-mono'>
                                                        {event.id}
                                                    </td>
                                                    <td className='tnum'>
                                                        {event.seq}
                                                    </td>
                                                    <td>
                                                        <Badge
                                                            tone={eventTone(
                                                                event.eventType
                                                            )}
                                                        >
                                                            {event.eventType}
                                                        </Badge>
                                                    </td>
                                                    <td className='font-mono'>
                                                        {event.messageId}
                                                    </td>
                                                    <td className='tnum whitespace-nowrap'>
                                                        {timing
                                                            ? formatDuration(
                                                                  timing.deltaMs
                                                              )
                                                            : '—'}
                                                    </td>
                                                    <td>
                                                        {timing ? (
                                                            <div className='flex items-center gap-2'>
                                                                <span className='bg-surface-muted relative block h-2 w-40 shrink-0 overflow-hidden rounded'>
                                                                    <span
                                                                        className='bg-brand absolute inset-y-0 block rounded'
                                                                        style={{
                                                                            left: `${timing.barLeftPct}%`,
                                                                            width: `${timing.barWidthPct}%`
                                                                        }}
                                                                    />
                                                                </span>
                                                                <span className='tnum text-caption-sm text-body whitespace-nowrap'>
                                                                    +
                                                                    {formatDuration(
                                                                        timing.offsetMs
                                                                    )}
                                                                </span>
                                                            </div>
                                                        ) : (
                                                            '—'
                                                        )}
                                                    </td>
                                                    <td className='tnum'>
                                                        {event.runnerSeq ?? '—'}
                                                    </td>
                                                    <td className='tnum whitespace-nowrap'>
                                                        {new Date(
                                                            event.createdAt
                                                        ).toLocaleString(
                                                            getLocale()
                                                        )}
                                                    </td>
                                                    <td>
                                                        <span className='block max-w-[32rem] truncate font-mono'>
                                                            {previewPayload(
                                                                event.payloadJson
                                                            )}
                                                        </span>
                                                    </td>
                                                </tr>
                                                {expandedId === event.id && (
                                                    <tr>
                                                        <td colSpan={9}>
                                                            <pre className='text-caption-sm bg-surface-subtle max-h-96 overflow-auto whitespace-pre-wrap rounded p-2'>
                                                                {JSON.stringify(
                                                                    event.payloadJson,
                                                                    null,
                                                                    2
                                                                )}
                                                            </pre>
                                                        </td>
                                                    </tr>
                                                )}
                                            </Fragment>
                                        )
                                    })}
                                </tbody>
                            </table>
                        </div>
                    )}

                    {events && eventsCursor && (
                        <div className='flex justify-center py-3'>
                            <Button
                                variant='ghost'
                                size='sm'
                                disabled={eventsLoading}
                                onClick={() =>
                                    void fetchEvents({
                                        append: true,
                                        cursor: eventsCursor,
                                        selected: types,
                                        turn: lockedTurn
                                    })
                                }
                            >
                                {eventsLoading ? 'Loading…' : 'Load more'}
                            </Button>
                        </div>
                    )}
                </Card>
            </div>
        </DetailPage>
    )
}

export default ChatSessionDetail
