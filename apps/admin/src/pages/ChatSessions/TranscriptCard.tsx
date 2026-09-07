import type {
    AdminChatSessionTurnDetail,
    AdminChatTurnMessage,
    ChatContentBlock
} from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { getLocale } from '@manyfold/i18n'
import { useApiClient } from '@/lib/apiClient'
import { Badge, Button, Card, Heading } from '@/ui'
import { cn } from '@/ui/classNames'
import { foldBlocks, foldedExtrasLabel, formatBytes } from './blocks'
import { turnStateTone } from './tones'

const TURNS_PAGE_SIZE = 20

const formatMs = (value: number | null): string =>
    value === null ? '—' : `${value.toLocaleString()} ms`

interface Props {
    sessionId: string
    inflightMessageId: string | null
    lockedTurn: string | null
    // Bumped by the page's Refresh button. A running turn only gets its
    // content blocks at its terminal event, so the newest entry here is stale
    // until something reloads it.
    refreshToken: number
    onTraceTurn: (messageId: string) => void
}

const TextBody: FC<{ text: string }> = ({ text }): ReactNode => (
    <pre className='text-caption text-heading bg-surface-subtle max-h-96 overflow-auto whitespace-pre-wrap break-words rounded p-2 font-sans'>
        {text}
    </pre>
)

const JsonBody: FC<{ value: unknown }> = ({ value }): ReactNode => (
    <pre className='text-caption-sm bg-surface-subtle max-h-64 overflow-auto whitespace-pre-wrap rounded p-2'>
        {JSON.stringify(value, null, 2)}
    </pre>
)

const ExtraBlock: FC<{ block: ChatContentBlock }> = ({ block }): ReactNode => {
    if (block.type === 'thinking')
        return (
            <div>
                <Badge tone='neutral'>thinking</Badge>
                <TextBody text={block.text} />
            </div>
        )
    if (block.type === 'tool_call')
        return (
            <div>
                <Badge tone='brand'>tool_call</Badge>
                <span className='text-caption text-heading ml-1 font-mono'>
                    {block.toolName}
                </span>
                <JsonBody value={block.args} />
            </div>
        )
    if (block.type === 'tool_result')
        return (
            <div>
                <Badge tone='brand'>tool_result</Badge>
                <span className='text-caption-sm text-body ml-1 font-mono'>
                    {block.toolCallId}
                </span>
                <JsonBody value={block.result} />
            </div>
        )
    return (
        <div>
            <Badge tone='neutral'>{block.type}</Badge>
            <JsonBody value={block} />
        </div>
    )
}

const InputMessage: FC<{ message: AdminChatTurnMessage }> = ({
    message
}): ReactNode => {
    const folded = foldBlocks(message.contentBlocks)
    const chips = [
        ...folded.attachments.map(
            (a) => `${a.name} · ${a.contentType} · ${formatBytes(a.size)}`
        ),
        ...folded.uploads.map(
            (u) => `${u.name} · ${u.contentType} · ${formatBytes(u.size)}`
        ),
        ...folded.contextRefs.map(
            (c) =>
                `${c.name} · ${c.entryType}${
                    c.size === undefined ? '' : ` · ${formatBytes(c.size)}`
                }`
        )
    ]
    return (
        <div className='space-y-1'>
            {message.role !== 'user' && (
                <Badge tone='warning'>{message.role}</Badge>
            )}
            {folded.text ? (
                <TextBody text={folded.text} />
            ) : (
                <p className='text-caption text-body'>
                    {chips.length > 0
                        ? 'No text — attachments only.'
                        : 'No text in this message.'}
                </p>
            )}
            {chips.length > 0 && (
                <div className='flex flex-wrap gap-1'>
                    {chips.map((chip) => (
                        <Badge key={chip} tone='neutral'>
                            {chip}
                        </Badge>
                    ))}
                </div>
            )}
            {folded.extras.length > 0 && (
                <div className='space-y-2'>
                    {folded.extras.map((block, i) => (
                        <ExtraBlock key={i} block={block} />
                    ))}
                </div>
            )}
        </div>
    )
}

const TurnEntry: FC<{
    entry: AdminChatSessionTurnDetail
    streaming: boolean
    locked: boolean
    onTraceTurn: (messageId: string) => void
}> = ({ entry, streaming, locked, onTraceTurn }): ReactNode => {
    const [showExtras, setShowExtras] = useState(false)
    const turn = entry.turn
    const folded = foldBlocks(entry.result.contentBlocks)
    const extrasLabel = foldedExtrasLabel(folded)
    return (
        <div
            className={cn(
                'border-border border-b px-4 py-3 last:border-b-0',
                locked && 'bg-brand-subtle'
            )}
        >
            <div className='text-caption text-body flex flex-wrap items-center gap-x-2 gap-y-1'>
                <span className='tnum whitespace-nowrap'>
                    {new Date(turn.createdAt).toLocaleString(getLocale())}
                </span>
                {turn.execution && (
                    <Badge tone={turnStateTone(turn.execution.state)}>
                        {turn.execution.state}
                    </Badge>
                )}
                {turn.execution && turn.execution.adoptCount > 0 && (
                    <Badge tone='warning'>
                        adopted ×{turn.execution.adoptCount}
                    </Badge>
                )}
                <span>{turn.model ?? 'model unknown'}</span>
                <span className='tnum whitespace-nowrap'>
                    {turn.inputTokens === null && turn.outputTokens === null
                        ? '— tokens'
                        : `${turn.inputTokens ?? 0} / ${turn.outputTokens ?? 0} tok`}
                </span>
                <span className='tnum'>
                    {turn.costUsd === null
                        ? '— cost'
                        : `$${turn.costUsd.toFixed(4)}`}
                </span>
                <span className='tnum whitespace-nowrap'>
                    TTFT {formatMs(turn.firstTokenMs)} ·{' '}
                    {formatMs(turn.totalMs)}
                </span>
                <span className='text-caption-sm font-mono'>
                    {turn.messageId}
                </span>
                <Button
                    variant='ghost'
                    size='sm'
                    onClick={() => onTraceTurn(turn.messageId)}
                >
                    {locked ? 'Clear trace' : 'Trace events'}
                </Button>
            </div>

            <p className='text-caption-sm text-body mt-2 uppercase tracking-wider'>
                User
            </p>
            {entry.input.length === 0 ? (
                <p className='text-caption text-body'>
                    No prompt row stored. Retention deletes old messages, and it
                    deletes them in batches — a turn can outlive its own prompt.
                </p>
            ) : (
                <div className='space-y-2'>
                    {entry.input.map((message) => (
                        <InputMessage key={message.id} message={message} />
                    ))}
                </div>
            )}

            <p className='text-caption-sm text-body mt-2 uppercase tracking-wider'>
                Assistant
            </p>
            {folded.text ? (
                <TextBody text={folded.text} />
            ) : (
                <p className='text-caption text-body'>
                    {streaming
                        ? 'Streaming — the blocks are written at the turn’s terminal event.'
                        : 'This turn produced no answer text.'}
                </p>
            )}
            {extrasLabel && (
                <div className='mt-1'>
                    <Button
                        variant='neutral'
                        size='sm'
                        onClick={() => setShowExtras((prev) => !prev)}
                    >
                        {showExtras ? 'Hide' : 'Show'} {extrasLabel}
                    </Button>
                </div>
            )}
            {showExtras && (
                <div className='mt-2 space-y-2'>
                    {folded.extras.map((block, i) => (
                        <ExtraBlock key={i} block={block} />
                    ))}
                </div>
            )}
            {turn.error && (
                <p className='text-caption text-accent-ruby mt-2'>
                    {turn.error.code ? `${turn.error.code}: ` : ''}
                    {turn.error.message ?? 'error'}
                </p>
            )}
        </div>
    )
}

const TranscriptCard: FC<Props> = ({
    sessionId,
    inflightMessageId,
    lockedTurn,
    refreshToken,
    onTraceTurn
}): ReactNode => {
    const client = useApiClient()
    const [items, setItems] = useState<AdminChatSessionTurnDetail[] | null>(
        null
    )
    const [nextBefore, setNextBefore] = useState<string | null>(null)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const fetchPage = useCallback(
        async (opts: { append: boolean; before: string | null }) => {
            setLoading(true)
            setError(null)
            try {
                const page = await client.admin.chatSessions.listTurns(
                    sessionId,
                    { limit: TURNS_PAGE_SIZE, before: opts.before ?? undefined }
                )
                setItems((prev) =>
                    opts.append && prev ? [...prev, ...page.items] : page.items
                )
                setNextBefore(page.nextBefore)
            } catch (err) {
                setError((err as Error).message)
            } finally {
                setLoading(false)
            }
        },
        [client, sessionId]
    )

    useEffect(() => {
        void fetchPage({ append: false, before: null })
    }, [fetchPage, refreshToken])

    return (
        <Card elevation='ambient' className='overflow-hidden'>
            <div className='border-border border-b px-4 py-2.5'>
                <Heading level={3}>Transcript</Heading>
                <p className='text-caption text-body mt-1'>
                    Each turn’s stored prompt and result, newest first. Unlike
                    the event log below, this survives stream-log compaction —
                    once retention has compacted a turn, these blocks are the
                    only copy of what it produced.
                </p>
            </div>

            {error && (
                <pre className='text-caption-sm text-accent-ruby whitespace-pre-wrap p-2'>
                    {error}
                </pre>
            )}

            {items === null && !error && (
                <p className='text-caption text-body p-2'>Loading…</p>
            )}

            {items && items.length === 0 && (
                <p className='text-caption text-body p-2'>
                    No assistant turns yet.
                </p>
            )}

            {items?.map((entry) => (
                <TurnEntry
                    key={entry.turn.messageId}
                    entry={entry}
                    streaming={inflightMessageId === entry.turn.messageId}
                    locked={lockedTurn === entry.turn.messageId}
                    onTraceTurn={onTraceTurn}
                />
            ))}

            {items && nextBefore && (
                <div className='flex justify-center py-3'>
                    <Button
                        variant='ghost'
                        size='sm'
                        disabled={loading}
                        onClick={() =>
                            void fetchPage({
                                append: true,
                                before: nextBefore
                            })
                        }
                    >
                        {loading ? 'Loading…' : 'Load more'}
                    </Button>
                </div>
            )}
        </Card>
    )
}

export default TranscriptCard
