import {
    useEffect,
    useId,
    useRef,
    useState,
    type FC,
    type FormEvent,
    type KeyboardEvent,
    type ReactNode
} from 'react'
import { t } from '@manyfold/i18n'
import { Button } from './Button'
import { Heading } from './Heading'
import { cn } from './classNames'

interface ConfirmDialogProps {
    open: boolean
    title: ReactNode
    // What happens, in full sentences.
    children?: ReactNode
    // When set, confirming takes typing it exactly.
    requireMatch?: string
    confirmLabel: ReactNode
    pendingLabel?: ReactNode
    tone?: 'default' | 'danger'
    pending?: boolean
    error?: string | null
    onConfirm: () => void
    onCancel: () => void
}

const FOCUSABLE =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

// A modal confirmation on the native <dialog>: the page behind it is inert,
// Escape cancels unless the action is running, a click on the backdrop does
// nothing, Tab stays inside, and focus returns to whatever opened it.
export const ConfirmDialog: FC<ConfirmDialogProps> = ({
    open,
    title,
    children,
    requireMatch,
    confirmLabel,
    pendingLabel,
    tone = 'default',
    pending = false,
    error,
    onConfirm,
    onCancel
}): ReactNode => {
    const ref = useRef<HTMLDialogElement>(null)
    const opener = useRef<HTMLElement | null>(null)
    const inputRef = useRef<HTMLInputElement>(null)
    const [typed, setTyped] = useState('')
    const titleId = useId()
    const bodyId = useId()
    const inputId = useId()

    useEffect(() => {
        const dialog = ref.current
        if (!dialog) return
        if (open && !dialog.open) {
            opener.current =
                document.activeElement instanceof HTMLElement
                    ? document.activeElement
                    : null
            setTyped('')
            dialog.showModal()
            ;(
                inputRef.current ??
                dialog.querySelector<HTMLButtonElement>('[data-dialog-cancel]')
            )?.focus()
        }
        if (!open && dialog.open) {
            dialog.close()
            if (opener.current?.isConnected) opener.current.focus()
            opener.current = null
        }
    }, [open])

    const matched = requireMatch === undefined || typed === requireMatch

    const submit = (event: FormEvent): void => {
        event.preventDefault()
        if (matched && !pending) onConfirm()
    }

    const keepFocusInside = (event: KeyboardEvent<HTMLDialogElement>): void => {
        if (event.key !== 'Tab' || !ref.current) return
        const focusable = Array.from(
            ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)
        )
        if (focusable.length === 0) return
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first.focus()
        }
    }

    return (
        <dialog
            ref={ref}
            aria-labelledby={titleId}
            aria-describedby={children ? bodyId : undefined}
            className='border-border shadow-deep m-auto w-full max-w-md rounded-lg border bg-white p-4 backdrop:bg-black/40'
            onCancel={(event): void => {
                event.preventDefault()
                if (!pending) onCancel()
            }}
            onKeyDown={keepFocusInside}
        >
            <form onSubmit={submit}>
                <Heading id={titleId} level={3} className='mb-2'>
                    {title}
                </Heading>
                {children && (
                    <div
                        id={bodyId}
                        className='text-caption text-body space-y-2'
                    >
                        {children}
                    </div>
                )}
                {requireMatch !== undefined && (
                    <>
                        <label
                            htmlFor={inputId}
                            className='text-caption text-label mt-3 block'
                        >
                            {t('common.typeToConfirmPrefix')}{' '}
                            <code className='text-heading font-mono'>
                                {requireMatch}
                            </code>{' '}
                            {t('common.typeToConfirmSuffix')}
                        </label>
                        <input
                            id={inputId}
                            ref={inputRef}
                            value={typed}
                            onChange={(event): void =>
                                setTyped(event.target.value)
                            }
                            className='border-border text-caption text-heading focus:border-brand focus:ring-brand mt-1 block h-8 w-full rounded border bg-white px-2 font-mono transition-colors focus:outline-none focus:ring-1'
                            spellCheck={false}
                            autoComplete='off'
                        />
                    </>
                )}
                {error && (
                    <p
                        role='alert'
                        className='text-caption-sm text-accent-ruby mt-3 break-words'
                    >
                        {error}
                    </p>
                )}
                <div className='mt-4 flex justify-end gap-2'>
                    <Button
                        data-dialog-cancel=''
                        variant='neutral'
                        disabled={pending}
                        onClick={onCancel}
                    >
                        {t('common.cancel')}
                    </Button>
                    <Button
                        type='submit'
                        variant={tone === 'danger' ? 'neutral' : 'primary'}
                        disabled={pending || !matched}
                        className={cn(
                            tone === 'danger' &&
                                '!border-accent-ruby !bg-accent-ruby hover:!bg-accent-ruby/90 !text-white'
                        )}
                    >
                        {pending
                            ? (pendingLabel ?? confirmLabel)
                            : confirmLabel}
                    </Button>
                </div>
            </form>
        </dialog>
    )
}
