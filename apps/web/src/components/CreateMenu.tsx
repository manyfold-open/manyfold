import type { FC, ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { PlusIcon, type LucideIcon } from '@/components/icons'
import { useI18n } from '@/lib/i18n'

// Quick create menu: desktop anchored panel + mobile bottom sheet, the same
// anatomy as GroupByControl in lib/cascade. One line per destination, no modal
// round trip. Shared because the runtimes rail and the providers rail would
// otherwise be two copies of the dismiss handling and the two-panel markup.

export interface CreateMenuOption {
    key: string
    // A plain glyph, or a pre-rendered lead (a brand mark) the menu boxes to
    // the row's icon size. Exactly one.
    icon?: LucideIcon
    lead?: ReactNode
    label: string
    // Exactly one of these: a route to navigate to, or a callback. Routes stay
    // real links so they keep middle-click and open-in-new-tab.
    to?: string
    onSelect?: () => void
}

export const CreateMenu: FC<{
    options: readonly CreateMenuOption[]
    // header: a round icon button in a rail header. footer: the rail's
    // full-width primary button. inline: a secondary button in page content.
    variant: 'header' | 'footer' | 'inline'
    triggerLabel: string
    sheetTitle: string
    disabled?: boolean
}> = ({ options, variant, triggerLabel, sheetTitle, disabled }): ReactNode => {
    const { t } = useI18n()
    const [open, setOpen] = useState(false)
    const rootRef = useRef<HTMLDivElement | null>(null)

    useEffect(() => {
        if (!open) return
        const handlePointerDown = (event: PointerEvent): void => {
            if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
        }
        const handleKeyDown = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('pointerdown', handlePointerDown)
        document.addEventListener('keydown', handleKeyDown)
        return () => {
            document.removeEventListener('pointerdown', handlePointerDown)
            document.removeEventListener('keydown', handleKeyDown)
        }
    }, [open])

    const item = (option: CreateMenuOption, mobile: boolean): ReactNode => {
        const Icon = option.icon
        const iconClass = mobile
            ? 'text-muted h-5 w-5 shrink-0'
            : 'text-muted h-4 w-4 shrink-0'
        const className = mobile
            ? 'text-body active:bg-soft flex w-full items-center gap-3 rounded-md px-3 py-3 text-left'
            : 'text-ui hover:bg-soft flex w-full items-center gap-2.5 rounded-sm px-2.5 py-1.5 text-left'
        const body = (
            <>
                {option.lead ? (
                    <span
                        className={`${iconClass} flex items-center justify-center`}
                    >
                        {option.lead}
                    </span>
                ) : Icon ? (
                    <Icon className={iconClass} />
                ) : null}
                <span className='min-w-0 flex-1 truncate'>{option.label}</span>
            </>
        )
        if (option.to !== undefined)
            return (
                <Link
                    key={option.key}
                    to={option.to}
                    onClick={() => setOpen(false)}
                    className={className}
                >
                    {body}
                </Link>
            )
        return (
            <button
                key={option.key}
                type='button'
                onClick={() => {
                    setOpen(false)
                    option.onSelect?.()
                }}
                className={className}
            >
                {body}
            </button>
        )
    }

    const triggerProps = {
        type: 'button' as const,
        onClick: () => setOpen((prev) => !prev),
        'aria-haspopup': 'menu' as const,
        'aria-expanded': open,
        disabled
    }

    return (
        <div ref={rootRef} className='relative'>
            {variant === 'header' ? (
                <button
                    {...triggerProps}
                    aria-label={triggerLabel}
                    className='text-muted hover:text-fg hover:bg-rail-hover flex h-7 w-7 items-center justify-center rounded-full transition-colors disabled:opacity-40'
                >
                    <PlusIcon className='h-4 w-4' />
                </button>
            ) : variant === 'inline' ? (
                <button
                    {...triggerProps}
                    className='workbench-button-secondary h-8 gap-1.5 px-3 disabled:opacity-40'
                >
                    <PlusIcon className='h-3.5 w-3.5' />
                    {triggerLabel}
                </button>
            ) : (
                <button
                    {...triggerProps}
                    className='workbench-button-primary h-9 w-full justify-center disabled:opacity-40'
                >
                    {triggerLabel}
                </button>
            )}
            {open && (
                <>
                    <div
                        className={[
                            'popover-panel bg-surface-elevated shadow-elevated absolute z-30 hidden rounded-md p-1 lg:block',
                            variant === 'footer'
                                ? 'bottom-full left-0 mb-1 w-full'
                                : 'right-0 top-full mt-1 w-64'
                        ].join(' ')}
                    >
                        {options.map((option) => item(option, false))}
                    </div>
                    <div className='fixed inset-0 z-40 lg:hidden'>
                        <button
                            type='button'
                            aria-label={t('web.cascade.close')}
                            onClick={() => setOpen(false)}
                            className='absolute inset-0 bg-black/40'
                        />
                        <div className='bg-surface-elevated shadow-elevated absolute inset-x-0 bottom-0 rounded-t-2xl p-2 pb-6'>
                            <div className='bg-divider mx-auto mb-2 mt-1 h-1 w-9 rounded-full' />
                            <div className='text-caption text-subtle px-3 py-1.5'>
                                {sheetTitle}
                            </div>
                            {options.map((option) => item(option, true))}
                        </div>
                    </div>
                </>
            )}
        </div>
    )
}
