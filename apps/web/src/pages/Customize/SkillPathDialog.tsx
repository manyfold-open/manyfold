import type { FC, FormEvent, ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CloseIcon } from '@/components/icons'
import { useBodyScrollLock } from '@/hooks/useBodyScrollLock'
import { useI18n } from '@/lib/i18n'

interface SkillPathDialogProps {
    title: string
    initialPath: string
    validate: (path: string) => string | null
    onSubmit: (path: string) => void
    onClose: () => void
}

const SkillPathDialog: FC<SkillPathDialogProps> = ({
    title,
    initialPath,
    validate,
    onSubmit,
    onClose
}): ReactNode => {
    useBodyScrollLock(true)
    const { t } = useI18n()
    const [path, setPath] = useState(initialPath)
    const inputRef = useRef<HTMLInputElement>(null)

    useEffect(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
    }, [])

    useEffect(() => {
        const onKey = (e: KeyboardEvent): void => {
            if (e.key === 'Escape') onClose()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [onClose])

    const trimmed = path.trim()
    const unchanged = trimmed === initialPath
    const invalidMessage = !trimmed || unchanged ? null : validate(trimmed)
    const canSubmit = Boolean(trimmed) && !unchanged && !invalidMessage

    const handleSubmit = (e: FormEvent): void => {
        e.preventDefault()
        if (!canSubmit) return
        onSubmit(trimmed)
        onClose()
    }

    return createPortal(
        <div
            className='fixed inset-0 z-[100] flex items-center justify-center bg-black/30 p-4 backdrop-blur-sm'
            role='dialog'
            aria-modal='true'
            aria-label={title}
            onClick={(e) => {
                if (e.target === e.currentTarget) onClose()
            }}
        >
            <form
                className='workbench-panel flex w-full max-w-md flex-col overflow-hidden'
                onSubmit={handleSubmit}
            >
                <header className='border-divider/80 flex items-center justify-between gap-3 border-b px-5 py-3'>
                    <h2 className='text-ui text-fg font-medium'>{title}</h2>
                    <button
                        type='button'
                        className='text-muted hover:bg-surface-hover shadow-ring-light bg-surface rounded-pill flex h-8 w-8 shrink-0 items-center justify-center transition-colors'
                        aria-label={t('common.cancel')}
                        onClick={onClose}
                    >
                        <CloseIcon className='h-4 w-4' />
                    </button>
                </header>

                <div className='flex flex-col gap-3 px-5 py-4'>
                    <label className='text-caption text-subtle font-medium'>
                        {t('web.skills.library.renamePathLabel')}
                    </label>
                    <input
                        ref={inputRef}
                        className='workbench-input font-mono'
                        value={path}
                        onChange={(e) => setPath(e.target.value)}
                        spellCheck={false}
                        autoComplete='off'
                    />
                    {invalidMessage && (
                        <div className='text-caption text-accent-ruby'>
                            {invalidMessage}
                        </div>
                    )}
                </div>

                <footer className='flex items-center justify-end gap-2 px-5 pb-5 pt-2'>
                    <button
                        type='button'
                        className='workbench-button-secondary'
                        onClick={onClose}
                    >
                        {t('common.cancel')}
                    </button>
                    <button
                        type='submit'
                        className='workbench-button-primary'
                        disabled={!canSubmit}
                    >
                        {t('web.skills.library.save')}
                    </button>
                </footer>
            </form>
        </div>,
        document.body
    )
}

export default SkillPathDialog
