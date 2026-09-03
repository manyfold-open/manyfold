import { chatCapabilitiesByFramework } from '@manyfold/shared'
import type {
    A2aTaskTraceItem,
    ChatMessage
} from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import type { SdkAgent } from '@manyfold/sdk'
import EmptyState from '@/components/EmptyState'
import { useApiClient } from '@/lib/apiClient'
import { apiErrorMessage } from '@/lib/errorMessage'
import { useI18n } from '@/lib/i18n'
import { lazyChunk } from '@/lib/lazyChunk'
import { useA2aBackgroundTasks } from '@/lib/useA2aBackgroundTasks'
import {
    a2aPeerLabel,
    a2aStateTone,
    formatElapsed,
    formatTokens,
    isTerminalA2aState
} from '@/lib/a2aTaskState'
import { fmtCost, formatLocalDateTime } from '@/lib/usageFormat'
import A2aStateBadge from '@/components/a2a/A2aStateBadge'
import ShortcutTooltip from '@/components/ShortcutTooltip'
import { ArrowLeftIcon } from '@/components/icons'
import { Spinner } from '@/components/Loading'

const MessageList = lazyChunk(() => import('@/components/chat/MessageList'))

const ICON_BTN =
    'text-muted hover:bg-surface-hover hover:text-fg inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-pill transition-colors'

const TONE_DOT: Record<string, string> = {
    info: 'bg-info',
    success: 'bg-success',
    warning: 'bg-warning',
    error: 'bg-error',
    idle: 'bg-idle'
}

const taskEnd = (task: A2aTaskTraceItem): string | undefined =>
    task.completedAt ??
    (isTerminalA2aState(task.state) ? task.updatedAt : undefined)

const TaskDot: FC<{ state: string }> = ({ state }): ReactNode => {
    const tone = a2aStateTone(state)
    const running = !isTerminalA2aState(state)
    return (
        <span
            className='relative mt-1 inline-flex h-2 w-2 shrink-0'
            aria-hidden='true'
        >
            {running && (
                <span
                    className={`absolute inset-0 inline-flex animate-ping rounded-full opacity-75 ${TONE_DOT[tone]}`}
                />
            )}
            <span
                className={`relative inline-flex h-2 w-2 rounded-full ${TONE_DOT[tone]}`}
            />
        </span>
    )
}

const TaskCard: FC<{ task: A2aTaskTraceItem; onOpen: () => void }> = ({
    task,
    onOpen
}): ReactNode => {
    const { t } = useI18n()
    const elapsed = formatElapsed(task.createdAt, taskEnd(task))
    const tokens = formatTokens(task.usage)
    const cost =
        task.usage?.costUsd != null ? fmtCost(task.usage.costUsd) : null
    return (
        <button
            type='button'
            onClick={onOpen}
            className='bg-surface hover:bg-surface-hover shadow-ring-light flex w-full items-start gap-2.5 rounded-md px-3 py-2.5 text-left transition-colors'
        >
            <TaskDot state={task.state} />
            <span className='min-w-0 flex-1'>
                <span className='flex items-center justify-between gap-2'>
                    <span className='text-fg text-ui truncate font-medium'>
                        {a2aPeerLabel(task)}
                    </span>
                    <A2aStateBadge state={task.state} />
                </span>
                <span className='text-subtle text-caption mt-0.5 flex flex-wrap items-center gap-x-1.5'>
                    <span>{t('web.backgroundTasks.type')}</span>
                    <span aria-hidden='true'>·</span>
                    <span>
                        {t(`web.backgroundTasks.direction.${task.direction}`)}
                    </span>
                    {elapsed ? (
                        <>
                            <span aria-hidden='true'>·</span>
                            <span className='tabular-nums'>{elapsed}</span>
                        </>
                    ) : null}
                </span>
                {task.errorMessage ? (
                    <ShortcutTooltip
                        label={task.errorMessage}
                        className='mt-1 w-full'
                    >
                        <span className='text-error text-caption line-clamp-2 block min-w-0 flex-1'>
                            {task.errorMessage}
                        </span>
                    </ShortcutTooltip>
                ) : null}
                <span className='text-caption mt-1.5 flex items-center gap-3'>
                    {tokens ? (
                        <span className='text-muted tabular-nums'>
                            {t('web.backgroundTasks.tokens', { count: tokens })}
                        </span>
                    ) : null}
                    {cost ? (
                        <span className='text-muted tabular-nums'>{cost}</span>
                    ) : null}
                    <span className='text-link ml-auto'>
                        {t('web.backgroundTasks.viewTranscript')}
                    </span>
                </span>
            </span>
        </button>
    )
}

const TaskDetail: FC<{
    agent: SdkAgent
    task: A2aTaskTraceItem
    onBack: () => void
}> = ({ agent, task, onBack }): ReactNode => {
    const { t } = useI18n()
    const client = useApiClient()
    const [messages, setMessages] = useState<ChatMessage[] | null>(null)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        let cancelled = false
        setMessages(null)
        setError(null)
        const load = async (): Promise<void> => {
            try {
                const all = await client.chat.listMessages(
                    task.targetAgentId,
                    task.chatSessionId
                )
                if (cancelled) return
                const ids = [
                    task.userMessageId,
                    task.assistantMessageId
                ].filter((id): id is string => Boolean(id))
                const turn =
                    ids.length > 0
                        ? all.filter((message) => ids.includes(message.id))
                        : all
                setMessages(turn.length > 0 ? turn : all)
            } catch (err) {
                if (cancelled) return
                setError(apiErrorMessage(err))
            }
        }
        void load()
        return (): void => {
            cancelled = true
        }
    }, [
        client,
        task.targetAgentId,
        task.chatSessionId,
        task.userMessageId,
        task.assistantMessageId
    ])

    const capabilities = chatCapabilitiesByFramework[agent.framework]
    const elapsed = formatElapsed(task.createdAt, taskEnd(task))
    const tokens = formatTokens(task.usage)
    const cost =
        task.usage?.costUsd != null ? fmtCost(task.usage.costUsd) : null

    return (
        <>
            <header className='border-divider/80 flex h-12 shrink-0 items-center gap-1 border-b px-2'>
                <button
                    type='button'
                    onClick={onBack}
                    aria-label={t('web.backgroundTasks.back')}
                    className={ICON_BTN}
                >
                    <ArrowLeftIcon className='h-4 w-4' />
                </button>
                <span className='text-fg text-ui min-w-0 flex-1 truncate font-medium'>
                    {a2aPeerLabel(task)}
                </span>
            </header>
            <div className='border-divider/60 text-caption text-subtle flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-2'>
                <A2aStateBadge state={task.state} />
                {elapsed ? (
                    <span className='tabular-nums'>{elapsed}</span>
                ) : null}
                {tokens ? (
                    <span className='tabular-nums'>
                        {t('web.backgroundTasks.tokens', { count: tokens })}
                    </span>
                ) : null}
                {cost ? <span className='tabular-nums'>{cost}</span> : null}
                <span className='ml-auto'>
                    {formatLocalDateTime(task.createdAt)}
                </span>
            </div>
            {task.errorMessage ? (
                <div className='text-error text-caption shrink-0 px-3 py-2'>
                    {task.errorMessage}
                </div>
            ) : null}
            <div className='flex min-h-0 flex-1 flex-col'>
                {error ? (
                    <div className='text-error text-ui px-3 py-10 text-center'>
                        {error}
                    </div>
                ) : messages === null ? (
                    <div className='text-muted flex items-center justify-center gap-2 px-3 py-12'>
                        <Spinner size={16} />
                        <span className='text-ui'>
                            {t('web.backgroundTasks.loadingTranscript')}
                        </span>
                    </div>
                ) : messages.length === 0 ? (
                    <div className='text-muted text-ui px-3 py-12 text-center'>
                        {t('web.backgroundTasks.transcriptUnavailable')}
                    </div>
                ) : (
                    <Suspense
                        fallback={
                            <div className='text-muted text-ui px-3 py-12 text-center'>
                                {t('web.backgroundTasks.loadingTranscript')}
                            </div>
                        }
                    >
                        <MessageList
                            messages={messages}
                            streamingAssistantId={null}
                            streamingBlocks={[]}
                            streamStatus='idle'
                            streamStartedAt={null}
                            streamErrors={[]}
                            capabilities={capabilities}
                            framework={agent.framework}
                            editingDisabled
                        />
                    </Suspense>
                )}
            </div>
        </>
    )
}

const SectionHeader: FC<{ label: string }> = ({ label }): ReactNode => (
    <span className='text-subtle text-caption px-1 font-medium'>{label}</span>
)

const BackgroundTasksBody: FC<{ agent: SdkAgent | null }> = ({
    agent
}): ReactNode => {
    const { t } = useI18n()
    const [openTaskId, setOpenTaskId] = useState<string | null>(null)
    const [hiddenIds, setHiddenIds] = useState<Set<string>>(() => new Set())

    const { running, finished, loading, error } = useA2aBackgroundTasks(
        agent?.id ?? null,
        { enabled: true }
    )

    const visibleFinished = useMemo(
        () => finished.filter((task) => !hiddenIds.has(task.id)),
        [finished, hiddenIds]
    )

    const clearFinished = useCallback((): void => {
        setHiddenIds((prev) => {
            const next = new Set(prev)
            for (const task of finished) next.add(task.id)
            return next
        })
    }, [finished])

    const openTask =
        openTaskId !== null
            ? ([...running, ...finished].find(
                  (task) => task.id === openTaskId
              ) ?? null)
            : null

    if (openTask && agent)
        return (
            <TaskDetail
                agent={agent}
                task={openTask}
                onBack={() => setOpenTaskId(null)}
            />
        )

    return (
        <div className='min-h-0 flex-1 overflow-y-auto px-3 py-3'>
            {!agent ? (
                <EmptyState
                    kind='no-selection'
                    tier='stack'
                    body={t('web.backgroundTasks.noAgent')}
                />
            ) : error ? (
                <div className='text-error text-ui px-1 py-6 text-center'>
                    {error}
                </div>
            ) : running.length === 0 && visibleFinished.length === 0 ? (
                loading ? (
                    <div className='text-caption text-muted px-2 py-12 text-center'>
                        {t('web.backgroundTasks.loading')}
                    </div>
                ) : (
                    <EmptyState
                        kind='all-clear'
                        tier='stack'
                        body={t('web.backgroundTasks.empty')}
                    />
                )
            ) : (
                <div className='space-y-4'>
                    {running.length > 0 && (
                        <section className='space-y-2'>
                            <SectionHeader
                                label={t('web.backgroundTasks.running')}
                            />
                            {running.map((task) => (
                                <TaskCard
                                    key={task.id}
                                    task={task}
                                    onOpen={() => setOpenTaskId(task.id)}
                                />
                            ))}
                        </section>
                    )}
                    {visibleFinished.length > 0 && (
                        <section className='space-y-2'>
                            <div className='flex items-center justify-between'>
                                <SectionHeader
                                    label={t('web.backgroundTasks.finished')}
                                />
                                <button
                                    type='button'
                                    onClick={clearFinished}
                                    className='text-subtle hover:text-fg text-caption px-1 transition-colors'
                                >
                                    {t('web.backgroundTasks.clear')}
                                </button>
                            </div>
                            {visibleFinished.map((task) => (
                                <TaskCard
                                    key={task.id}
                                    task={task}
                                    onOpen={() => setOpenTaskId(task.id)}
                                />
                            ))}
                        </section>
                    )}
                </div>
            )}
        </div>
    )
}

export default BackgroundTasksBody
