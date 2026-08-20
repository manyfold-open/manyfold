import {
    inputValidation,
    normalizeAgentName,
    validateAgentName
} from '@manyfold/shared'
import type { FC, FormEvent, ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CloseIcon } from '@/components/icons'
import { Spinner } from '@/components/Loading'
import { useBodyScrollLock } from '@/hooks/useBodyScrollLock'
import { useApiClient } from '@/lib/apiClient'
import { apiErrorMessage } from '@/lib/errorMessage'
import { useI18n } from '@/lib/i18n'

const AGENT_NAME_MAX = inputValidation.AGENT_NAME.MAX

const agentNameValidationKey = {
    empty: 'errors.agentName.empty',
    too_long: 'errors.agentName.tooLong',
    control_character: 'errors.agentName.controlCharacter',
    invalid_start: 'errors.agentName.invalidStart',
    invalid_character: 'errors.agentName.invalidCharacter'
} as const

interface RenameAgentDialogProps {
    agent: { id: string; name: string }
    onClose: () => void
    onRenamed: (updated: { id: string; name: string }) => void
}

const RenameAgentDialog: FC<RenameAgentDialogProps> = ({
    agent,
    onClose,
    onRenamed
}): ReactNode => {
    const client = useApiClient()
    const { t } = useI18n()
    useBodyScrollLock(true)
    const [name, setName] = useState(agent.name)
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

    const validation = validateAgentName(name)
    const normalized = validation.valid
        ? validation.value
        : normalizeAgentName(name)
    const unchanged = normalized === agent.name
    const validationMessage =
        validation.valid || name.length === 0
            ? null
            : t(agentNameValidationKey[validation.code], {
                  max: AGENT_NAME_MAX
              })
    const canSubmit = validation.valid && !unchanged && !submitting

    const handleSubmit = async (e: FormEvent): Promise<void> => {
        e.preventDefault()
        if (!canSubmit) return
        setSubmitting(true)
        setError(null)
        try {
            const updated = await client.agents.update(agent.id, {
                name: normalized
            })
            onRenamed({ id: updated.id, name: updated.name })
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
                        {t('web.rename.title')}
                    </h2>
                    <button
                        type='button'
                        className='text-muted hover:bg-surface-hover shadow-ring-light bg-surface flex h-8 w-8 shrink-0 items-center justify-center rounded-pill transition-colors'
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
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        disabled={submitting}
                        spellCheck={false}
                        autoComplete='off'
                    />
                    <div className='text-caption text-subtle font-mono'>
                        {t('web.rename.hint', { max: AGENT_NAME_MAX })}
                    </div>
                    {validationMessage && (
                        <div className='text-caption text-accent-ruby'>
                            {validationMessage}
                        </div>
                    )}
                    {error && (
                        <div className='workbench-alert-error'>{error}</div>
                    )}
                </div>

                <footer className='flex items-center justify-end gap-2 px-5 pt-2 pb-5'>
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

export default RenameAgentDialog
