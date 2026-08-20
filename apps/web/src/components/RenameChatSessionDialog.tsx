import type { FC, FormEvent, ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CloseIcon } from '@/components/icons'
import { Spinner } from '@/components/Loading'
import { useBodyScrollLock } from '@/hooks/useBodyScrollLock'
import { useApiClient } from '@/lib/apiClient'
import { apiErrorMessage } from '@/lib/errorMessage'
import { useI18n } from '@/lib/i18n'

const TITLE_MAX = 200

interface RenameChatSessionDialogProps {
    agentId: string
    sessionId: string
    initialTitle: string
    onClose: () => void
    onRenamed: (title: string | null) => void
}

const RenameChatSessionDialog: FC<RenameChatSessionDialogProps> = ({
    agentId,
    sessionId,
    initialTitle,
    onClose,
    onRenamed
}): ReactNode => {
    const client = useApiClient()
    const { t } = useI18n()
    useBodyScrollLock(true)
    const [value, setValue] = useState(initialTitle)
    const [submitting, setSubmitting] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const inputRef = useRef<HTMLInputElement>(null)

    useEffect(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
    }, [])

    useEffect(() => {
        const onKey = (e: KeyboardEvent): void => {
            if (e.key === 'Escape' && !submitting) onClose()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [onClose, submitting])

    const trimmed = value.trim()
    const tooLong = trimmed.length > TITLE_MAX
    const unchanged = trimmed === initialTitle.trim()
    const canSubmit = !tooLong && !unchanged && !submitting

    const handleSubmit = async (e: FormEvent): Promise<void> => {
        e.preventDefault()
        if (!canSubmit) return
        setSubmitting(true)
        setError(null)
        try {
            const nextTitle = trimmed.length === 0 ? null : trimmed
            await client.chat.updateSession(agentId, sessionId, {
                title: nextTitle
            })
            onRenamed(nextTitle)
            onClose()
        } catch (err) {
            setError(apiErrorMessage(err))
            setSubmitting(false)
        }
    }

    return createPortal(
        <div
            className='fixed inset-0 z-[100] flex items-center justify-center bg-black/30 p-4 backdrop-blur-sm'
            role='dialog'
            aria-modal='true'
            aria-label={t('web.rename.ariaLabel')}
            onClick={(e) => {
                if (e.target === e.currentTarget && !submitting) onClose()
            }}
        >
            <form
                className='workbench-panel flex w-full max-w-md flex-col overflow-hidden'
                onSubmit={(e) => void handleSubmit(e)}
            >
                <header className='border-divider/80 flex items-center justify-between gap-3 border-b px-5 py-3'>
                    <h2 className='text-ui text-fg font-medium'>
                        {t('web.rename.chatTitle')}
                    </h2>
                    <button
                        type='button'
                        className='text-muted hover:bg-surface-hover shadow-ring-light bg-surface rounded-pill flex h-8 w-8 shrink-0 items-center justify-center transition-colors'
                        aria-label={t('web.rename.ariaClose')}
                        onClick={onClose}
                        disabled={submitting}
                    >
                        <CloseIcon className='h-4 w-4' />
                    </button>
                </header>

                <div className='flex flex-col gap-3 px-5 py-4'>
                    <input
                        ref={inputRef}
                        className='workbench-input'
                        value={value}
                        onChange={(e) => setValue(e.target.value)}
                        disabled={submitting}
                        spellCheck={false}
                        autoComplete='off'
                        maxLength={TITLE_MAX}
                    />
                    <div className='text-caption text-subtle'>
                        {t('web.rename.chatHint', { max: TITLE_MAX })}
                    </div>
                    {error && (
                        <div className='workbench-alert-error'>{error}</div>
                    )}
                </div>

                <footer className='flex items-center justify-end gap-2 px-5 pb-5 pt-2'>
                    <button
                        type='button'
                        className='workbench-button-secondary'
                        onClick={onClose}
                        disabled={submitting}
                    >
                        {t('web.rename.cancel')}
                    </button>
                    <button
                        type='submit'
                        className='workbench-button-primary'
                        disabled={!canSubmit}
                    >
                        {submitting ? (
                            <span className='inline-flex items-center gap-2'>
                                <Spinner size={16} />
                                {t('web.rename.saving')}
                            </span>
                        ) : (
                            t('web.rename.save')
                        )}
                    </button>
                </footer>
            </form>
        </div>,
        document.body
    )
}

export default RenameChatSessionDialog
