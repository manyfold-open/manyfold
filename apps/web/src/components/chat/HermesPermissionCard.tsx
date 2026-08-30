import type { FC, ReactNode } from 'react'
import { useState } from 'react'
import { CheckIcon, CloseIcon, ShieldAlertIcon } from '@/components/icons'
import type { PermissionCardBlock } from '@/components/chat/utils/pairToolBlocks'
import { useI18n } from '@/lib/i18n'

// The interactive half of hermes's ask permission modes: the agent is blocked
// on this choice, so the card must interrupt the transcript and stay
// answerable across reconnects (the request/resolution events are durable
// stream rows). A card whose turn reached a terminal without a resolution was
// never answered (crash, cancel, page away past the deny-on-timeout) and
// renders inert rather than pretending to be actionable.
const HermesPermissionCard: FC<{
    card: PermissionCardBlock
    turnActive: boolean
    onAnswer?: (requestId: string, optionId: string) => Promise<void>
}> = ({ card, turnActive, onAnswer }): ReactNode => {
    const { t } = useI18n()
    const [submitting, setSubmitting] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)
    const resolution = card.resolution

    const answer = async (optionId: string): Promise<void> => {
        if (!onAnswer || submitting) return
        setSubmitting(optionId)
        setError(null)
        try {
            await onAnswer(card.request.requestId, optionId)
        } catch (err) {
            setError((err as Error).message)
        } finally {
            setSubmitting(null)
        }
    }

    if (resolution) {
        const option = card.request.options.find(
            (o) => o.optionId === resolution.optionId
        )
        const approved =
            resolution.outcome === 'selected' &&
            (option?.kind.startsWith('allow') ?? false)
        const label =
            resolution.outcome === 'timeout'
                ? t('web.chat.permissionCard.timedOut')
                : resolution.outcome === 'cancelled'
                  ? t('web.chat.permissionCard.cancelled')
                  : approved
                    ? t('web.chat.permissionCard.approvedWith', {
                          option: option?.name ?? resolution.optionId ?? ''
                      })
                    : t('web.chat.permissionCard.denied')
        return (
            <div
                className={
                    approved
                        ? 'border-success/40 bg-success-bg shadow-ring-light text-ui my-2 rounded-md border px-3.5 py-3'
                        : 'bg-surface-subtle shadow-ring text-ui text-muted my-2 rounded-md px-3.5 py-3'
                }
            >
                <div className='flex items-center gap-2'>
                    {approved ? (
                        <CheckIcon className='text-success h-4 w-4 shrink-0' />
                    ) : (
                        <CloseIcon className='h-4 w-4 shrink-0' />
                    )}
                    <span className='min-w-0 truncate'>
                        {card.request.title}
                    </span>
                    <span className='text-muted shrink-0'>{label}</span>
                </div>
            </div>
        )
    }

    const answerable = turnActive && Boolean(onAnswer)

    return (
        <div className='bg-surface shadow-ring my-2 rounded-md p-4'>
            <div className='flex items-start gap-3'>
                <span className='bg-badge-bg text-link rounded-pill flex h-8 w-8 shrink-0 items-center justify-center'>
                    <ShieldAlertIcon className='h-4 w-4' />
                </span>
                <div className='min-w-0 flex-1'>
                    <div className='text-ui text-fg font-medium'>
                        {card.request.title}
                    </div>
                    {card.request.detail && (
                        <pre className='text-caption text-muted bg-app mt-1.5 overflow-x-auto whitespace-pre-wrap break-all rounded-md px-2.5 py-1.5 font-mono'>
                            {card.request.detail}
                        </pre>
                    )}
                    {answerable ? (
                        <div className='mt-3 flex flex-wrap items-center gap-2'>
                            {card.request.options.map((option) => (
                                <button
                                    key={option.optionId}
                                    type='button'
                                    disabled={submitting !== null}
                                    onClick={() => void answer(option.optionId)}
                                    className={
                                        option.kind.startsWith('allow')
                                            ? 'workbench-button-primary'
                                            : 'workbench-button-secondary'
                                    }
                                >
                                    {submitting === option.optionId
                                        ? t('web.chat.permissionCard.sending')
                                        : option.name}
                                </button>
                            ))}
                        </div>
                    ) : (
                        <p className='text-caption text-muted mt-2'>
                            {t('web.chat.permissionCard.expired')}
                        </p>
                    )}
                    {error && (
                        <p className='text-caption text-danger mt-2'>
                            {t('web.chat.permissionCard.answerFailed', {
                                message: error
                            })}
                        </p>
                    )}
                </div>
            </div>
        </div>
    )
}

export default HermesPermissionCard
