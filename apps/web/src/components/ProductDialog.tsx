import type {
    FC,
    FormEventHandler,
    ReactNode,
    TouchEvent,
    WheelEvent
} from 'react'
import { useEffect, useId } from 'react'
import { createPortal } from 'react-dom'
import { t } from '@manyfold/i18n'
import { CloseIcon } from '@/components/icons'
import { useBodyScrollLock } from '@/hooks/useBodyScrollLock'

type ProductDialogSize = 'sm' | 'md' | 'lg' | 'xl'

const sizeClass: Record<ProductDialogSize, string> = {
    sm: 'max-w-md',
    md: 'max-w-lg',
    lg: 'max-w-2xl',
    xl: 'max-w-3xl'
}

interface ProductDialogProps {
    title: ReactNode
    description?: ReactNode
    children: ReactNode
    footer?: ReactNode
    onClose: () => void
    onSubmit?: FormEventHandler<HTMLFormElement>
    size?: ProductDialogSize
    closeLabel?: string
    closeDisabled?: boolean
    closeOnBackdrop?: boolean
    noValidate?: boolean
    headerAccessory?: ReactNode
    bodyClassName?: string
    surfaceClassName?: string
    footerClassName?: string
}

const joinClasses = (...classes: Array<string | false | undefined>): string =>
    classes.filter(Boolean).join(' ')

const ProductDialog: FC<ProductDialogProps> = ({
    title,
    description,
    children,
    footer,
    onClose,
    onSubmit,
    size = 'md',
    closeLabel = t('common.close'),
    closeDisabled = false,
    closeOnBackdrop = true,
    noValidate,
    headerAccessory,
    bodyClassName,
    surfaceClassName,
    footerClassName
}) => {
    useBodyScrollLock(true)
    const titleId = useId()
    const descriptionId = useId()

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key === 'Escape' && !closeDisabled) onClose()
        }
        document.addEventListener('keydown', onKeyDown)
        return () => document.removeEventListener('keydown', onKeyDown)
    }, [closeDisabled, onClose])

    const stopBackgroundScroll = (
        event: WheelEvent<HTMLDivElement> | TouchEvent<HTMLDivElement>
    ): void => {
        const inner = event.currentTarget.querySelector(
            '[data-product-dialog-body]'
        )
        if (inner && inner.contains(event.target as Node)) return
        event.preventDefault()
    }

    const handleBackdropClick = (): void => {
        if (!closeDisabled && closeOnBackdrop) onClose()
    }

    const content = (
        <>
            <header className='flex shrink-0 items-start justify-between gap-4 px-5 pt-5 pb-3'>
                <div className='min-w-0'>
                    <h2 id={titleId} className='text-h2 text-fg'>
                        {title}
                    </h2>
                    {description && (
                        <p
                            id={descriptionId}
                            className='text-ui text-muted mt-1.5'
                        >
                            {description}
                        </p>
                    )}
                </div>
                <div className='flex shrink-0 items-center gap-2'>
                    {headerAccessory}
                    <button
                        type='button'
                        className='text-muted hover:bg-surface-hover rounded-pill flex h-8 w-8 shrink-0 items-center justify-center transition-colors disabled:cursor-not-allowed disabled:opacity-50'
                        aria-label={closeLabel}
                        onClick={onClose}
                        disabled={closeDisabled}
                    >
                        <CloseIcon className='h-4 w-4' />
                    </button>
                </div>
            </header>

            <div
                data-product-dialog-body
                className={joinClasses(
                    'min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-3',
                    bodyClassName
                )}
            >
                {children}
            </div>

            {footer && (
                <footer
                    className={joinClasses(
                        'flex shrink-0 flex-wrap items-center justify-end gap-2 px-5 pt-2 pb-5',
                        footerClassName
                    )}
                >
                    {footer}
                </footer>
            )}
        </>
    )

    const dialogClassName = joinClasses(
        'workbench-panel flex max-h-[calc(100vh-2rem)] w-full flex-col overflow-hidden',
        sizeClass[size],
        surfaceClassName
    )

    return createPortal(
        <div
            className='fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4 backdrop-blur-[10px] dark:bg-black/60'
            onClick={handleBackdropClick}
            onWheel={stopBackgroundScroll}
            onTouchMove={stopBackgroundScroll}
        >
            {onSubmit ? (
                <form
                    role='dialog'
                    aria-modal='true'
                    aria-labelledby={titleId}
                    aria-describedby={description ? descriptionId : undefined}
                    className={dialogClassName}
                    onClick={(event) => event.stopPropagation()}
                    onSubmit={onSubmit}
                    noValidate={noValidate}
                >
                    {content}
                </form>
            ) : (
                <div
                    role='dialog'
                    aria-modal='true'
                    aria-labelledby={titleId}
                    aria-describedby={description ? descriptionId : undefined}
                    className={dialogClassName}
                    onClick={(event) => event.stopPropagation()}
                >
                    {content}
                </div>
            )}
        </div>,
        document.body
    )
}

export default ProductDialog
