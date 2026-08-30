import type { ChatContextUsage, ChatUsage } from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { getLocale } from '@manyfold/i18n'
import ShortcutTooltip from '@/components/ShortcutTooltip'
import ElapsedTimer from '@/components/chat/ElapsedTimer'
import {
    CheckIcon,
    CodeIcon,
    CopyIcon,
    InfoIcon,
    RawIcon
} from '@/components/icons'
import { useI18n } from '@/lib/i18n'
import { fmt, fmtCost } from '@/lib/usageFormat'

interface Props {
    usage: ChatUsage | null
    messageModel?: string | null
    contextUsage?: ChatContextUsage | null
    createdAt?: string | null
    copyText?: string
    markdownText?: string
    rawResponse?: unknown
    isStreaming?: boolean
    streamLabel?: string
    streamHint?: string
    streamStartedAt?: number | null
    hideActions?: boolean
}

const MessageMetaFooter: FC<Props> = ({
    usage,
    messageModel,
    contextUsage,
    createdAt,
    copyText,
    markdownText,
    rawResponse,
    isStreaming = false,
    streamLabel,
    streamHint,
    streamStartedAt,
    hideActions = false
}): ReactNode => {
    const { t } = useI18n()
    const [open, setOpen] = useState(false)
    const [copied, setCopied] = useState<'text' | 'markdown' | 'raw' | null>(
        null
    )
    const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const model = isStreaming ? null : (usage?.model ?? messageModel ?? null)
    const streamingLabel = streamLabel ?? t('web.chatStream.working')
    const canCopyText = Boolean(copyText?.trim())
    const canCopyMarkdown = Boolean(markdownText?.trim())
    const canCopyRaw = rawResponse !== undefined

    useEffect(
        () => () => {
            if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current)
        },
        []
    )

    const copyToClipboard = (
        kind: 'text' | 'markdown' | 'raw',
        value: string
    ): void => {
        if (!value) return
        navigator.clipboard
            ?.writeText(value)
            .then(() => {
                setCopied(kind)
                if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current)
                copiedTimerRef.current = setTimeout(() => setCopied(null), 1500)
            })
            .catch(() => undefined)
    }

    return (
        <div className='mt-1 flex items-center gap-2 px-0.5'>
            {isStreaming ? (
                <span className='text-caption text-workflow-develop inline-flex items-center gap-1 font-mono tracking-tight'>
                    <span className='bg-workflow-develop h-1.5 w-1.5 animate-pulse rounded-full' />
                    <span className='chat-shiny-text truncate'>
                        {streamingLabel}
                    </span>
                    <ElapsedTimer
                        startedAt={streamStartedAt ?? null}
                        active={isStreaming}
                    />
                    {streamHint && (
                        <span className='text-placeholder truncate font-sans'>
                            {streamHint}
                        </span>
                    )}
                </span>
            ) : (
                <span className='group/meta relative inline-flex'>
                    <button
                        type='button'
                        aria-expanded={open}
                        aria-label={t('web.chatStream.messageDetails')}
                        onClick={(): void => setOpen((v) => !v)}
                        onBlur={(): void => setOpen(false)}
                        className={[
                            'rounded-xs inline-flex h-6 w-6 items-center justify-center transition-colors',
                            open
                                ? 'bg-app dark:bg-surface text-subtle'
                                : 'text-placeholder hover:bg-surface-subtle dark:hover:bg-surface'
                        ].join(' ')}
                    >
                        <InfoIcon className='h-3.5 w-3.5' />
                    </button>
                    <span
                        role='tooltip'
                        className={[
                            'border-divider/80 bg-surface text-fg shadow-elevated text-caption absolute left-0 top-full z-[90] mt-1 w-max min-w-[14rem] max-w-[20rem] rounded-md border px-3 py-2 transition-opacity duration-100',
                            'group-focus-within/meta:opacity-100 group-hover/meta:opacity-100',
                            open
                                ? 'opacity-100'
                                : 'pointer-events-none opacity-0 group-focus-within/meta:pointer-events-auto group-hover/meta:pointer-events-auto'
                        ].join(' ')}
                    >
                        <PopoverBody
                            usage={usage}
                            model={model}
                            contextUsage={contextUsage ?? null}
                            createdAt={createdAt}
                        />
                    </span>
                </span>
            )}
            {!isStreaming && !hideActions && (
                <span className='flex items-center gap-1'>
                    <CopyButton
                        label={
                            copied === 'text'
                                ? t('web.chatStream.copiedText')
                                : t('web.chatStream.copyText')
                        }
                        disabled={!canCopyText}
                        copied={copied === 'text'}
                        onClick={() => copyToClipboard('text', copyText ?? '')}
                    >
                        {copied === 'text' ? <CheckIcon /> : <CopyIcon />}
                    </CopyButton>
                    <CopyButton
                        label={
                            copied === 'markdown'
                                ? t('web.chatStream.copiedMarkdown')
                                : t('web.chatStream.copyMarkdown')
                        }
                        disabled={!canCopyMarkdown}
                        copied={copied === 'markdown'}
                        onClick={() =>
                            copyToClipboard('markdown', markdownText ?? '')
                        }
                    >
                        {copied === 'markdown' ? <CheckIcon /> : <CodeIcon />}
                    </CopyButton>
                    <CopyButton
                        label={
                            copied === 'raw'
                                ? t('web.chatStream.copiedRaw')
                                : t('web.chatStream.copyRaw')
                        }
                        disabled={!canCopyRaw}
                        copied={copied === 'raw'}
                        onClick={() =>
                            copyToClipboard(
                                'raw',
                                stringifyRawResponse(rawResponse)
                            )
                        }
                    >
                        {copied === 'raw' ? <CheckIcon /> : <RawIcon />}
                    </CopyButton>
                </span>
            )}
        </div>
    )
}

interface BodyProps {
    usage: ChatUsage | null
    model: string | null
    contextUsage: ChatContextUsage | null
    createdAt?: string | null
}

const PopoverBody: FC<BodyProps> = ({
    usage,
    model,
    contextUsage,
    createdAt
}): ReactNode => {
    const { t } = useI18n()
    const fullTime = formatFullMessageTime(createdAt)
    return (
        <div className='flex flex-col gap-2'>
            <div className='flex flex-col gap-1.5'>
                <div className='flex items-center justify-between gap-3'>
                    <span className='text-subtle'>
                        {t('web.chatStream.model')}
                    </span>
                    <span className='font-mono'>
                        {model ?? t('web.chatStream.modelUnknown')}
                    </span>
                </div>
                {fullTime && (
                    <div className='flex items-center justify-between gap-3'>
                        <span className='text-subtle'>
                            {t('web.chatStream.time')}
                        </span>
                        <span className='tabular-nums'>{fullTime}</span>
                    </div>
                )}
                {contextUsage && contextUsage.size > 0 && (
                    <div className='flex items-center justify-between gap-3'>
                        <span className='text-subtle'>
                            {t('web.chatStream.contextUsage')}
                        </span>
                        <span className='tabular-nums'>
                            {t('web.chatStream.contextUsageValue', {
                                used: fmt(contextUsage.used),
                                size: fmt(contextUsage.size),
                                percent: Math.min(
                                    100,
                                    Math.round(
                                        (contextUsage.used /
                                            contextUsage.size) *
                                            100
                                    )
                                ).toString()
                            })}
                        </span>
                    </div>
                )}
                <div className='bg-divider/60 mt-0.5 h-px' />
            </div>
            <UsageDetails usage={usage} />
        </div>
    )
}

interface UsageProps {
    usage: ChatUsage | null
}

const UsageDetails: FC<UsageProps> = ({ usage }): ReactNode => {
    const { t } = useI18n()
    if (!usage) {
        return (
            <span className='text-subtle'>
                {t('web.chatStream.tokensNotReported')}
            </span>
        )
    }

    const totalTokens =
        usage.inputTokens +
        usage.outputTokens +
        usage.cacheReadTokens +
        usage.cacheCreationTokens
    const hasLatency = usage.firstTokenMs !== null || usage.totalMs !== null

    return (
        <div className='flex flex-col gap-1.5 tabular-nums'>
            <div className='flex items-center justify-between gap-3'>
                <span className='text-subtle'>
                    {t('web.chat.tokensLabel')}
                </span>
                <span>
                    {t('web.chatStream.tokensTotal', {
                        count: fmt(totalTokens)
                    })}
                </span>
            </div>
            <div className='text-muted flex flex-wrap gap-x-3 gap-y-0.5'>
                <span>
                    {t('web.chatStream.tokensIn', {
                        count: fmt(usage.inputTokens)
                    })}
                </span>
                <span>
                    {t('web.chatStream.tokensOut', {
                        count: fmt(usage.outputTokens)
                    })}
                </span>
                {usage.cacheReadTokens > 0 && (
                    <span>
                        {t('web.chatStream.cacheRead', {
                            count: fmt(usage.cacheReadTokens)
                        })}
                    </span>
                )}
                {usage.cacheCreationTokens > 0 && (
                    <span>
                        {t('web.chatStream.cacheCreate', {
                            count: fmt(usage.cacheCreationTokens)
                        })}
                    </span>
                )}
            </div>
            {usage.costUsd !== null && (
                <div className='flex items-center justify-between gap-3'>
                    <span className='text-subtle'>
                        {t('web.chatStream.cost')}
                    </span>
                    <span>{fmtCost(usage.costUsd)}</span>
                </div>
            )}
            {hasLatency && (
                <div className='flex items-center justify-between gap-3'>
                    <span className='text-subtle'>
                        {t('web.chatStream.latency')}
                    </span>
                    <span className='flex gap-2'>
                        {usage.firstTokenMs !== null && (
                            <span>
                                {t('web.chatStream.latencyTtf', {
                                    seconds: (
                                        usage.firstTokenMs / 1000
                                    ).toFixed(1)
                                })}
                            </span>
                        )}
                        {usage.totalMs !== null && (
                            <span>
                                {t('web.chatStream.latencyTotal', {
                                    seconds: (usage.totalMs / 1000).toFixed(1)
                                })}
                            </span>
                        )}
                    </span>
                </div>
            )}
        </div>
    )
}

interface CopyButtonProps {
    label: string
    disabled: boolean
    copied: boolean
    onClick: () => void
    children: ReactNode
}

const CopyButton: FC<CopyButtonProps> = ({
    label,
    disabled,
    copied,
    onClick,
    children
}): ReactNode => (
    <ShortcutTooltip label={label}>
        <button
            type='button'
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
            className={[
                'rounded-xs inline-flex h-6 w-6 items-center justify-center transition-colors',
                copied
                    ? 'text-workflow-develop'
                    : 'text-placeholder hover:bg-surface-subtle dark:hover:bg-surface',
                disabled ? 'cursor-not-allowed opacity-40' : ''
            ].join(' ')}
        >
            <span className='[&>svg]:h-3.5 [&>svg]:w-3.5'>{children}</span>
        </button>
    </ShortcutTooltip>
)

const formatFullMessageTime = (value?: string | null): string => {
    const date = parseDate(value)
    if (!date) return ''
    return new Intl.DateTimeFormat(getLocale(), {
        dateStyle: 'medium',
        timeStyle: 'medium'
    }).format(date)
}

const parseDate = (value?: string | null): Date | null => {
    if (!value) return null
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? null : date
}

const stringifyRawResponse = (value: unknown): string => {
    if (value === undefined) return ''
    try {
        return JSON.stringify(value, null, 2)
    } catch {
        return String(value)
    }
}

export default MessageMetaFooter
