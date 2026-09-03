import type { FC, ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { t } from '@manyfold/i18n'
import { EllipsisHorizontalIcon } from '@/components/icons'
import ShortcutTooltip from '@/components/ShortcutTooltip'

export interface OverflowMenuItem {
    label: string
    onSelect: () => void
    danger?: boolean
    disabled?: boolean
    disabledReason?: string
    // Right-aligned glyph that says the click leaves this object: '→' for
    // another area, '↗' for a new tab. See `lib/agentMenu`.
    trailing?: string | null
}

// Groups actions by what they do (in-place dialogs, navigation, destructive).
export interface OverflowMenuSeparator {
    separator: true
}

export type OverflowMenuEntry = OverflowMenuItem | OverflowMenuSeparator

const isSeparator = (
    entry: OverflowMenuEntry
): entry is OverflowMenuSeparator => 'separator' in entry

const OverflowMenu: FC<{
    ariaLabel?: string
    items: OverflowMenuEntry[]
    compact?: boolean
    // Override the trigger's styling so it can match a host bar's other
    // buttons (e.g. the chat header's ringed action pills). Defaults to the
    // bare icon-button look.
    triggerClassName?: string
}> = ({
    ariaLabel = t('common.moreActions'),
    items,
    compact = false,
    triggerClassName
}): ReactNode => {
    const [open, setOpen] = useState(false)
    const rootRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
        if (!open) return
        const onDocClick = (e: MouseEvent): void => {
            if (rootRef.current && !rootRef.current.contains(e.target as Node))
                setOpen(false)
        }
        const onKey = (e: KeyboardEvent): void => {
            if (e.key === 'Escape') setOpen(false)
        }
        document.addEventListener('mousedown', onDocClick)
        window.addEventListener('keydown', onKey)
        return () => {
            document.removeEventListener('mousedown', onDocClick)
            window.removeEventListener('keydown', onKey)
        }
    }, [open])

    if (items.filter((entry) => !isSeparator(entry)).length === 0) return null

    const itemClass = (item: OverflowMenuItem): string =>
        [
            'flex w-full items-center gap-2.5 rounded-sm px-2.5 py-1.5 text-ui text-left transition-colors',
            item.disabled
                ? 'text-muted cursor-not-allowed opacity-60'
                : item.danger
                  ? 'text-workflow-ship hover:bg-danger-bg'
                  : 'text-fg hover:bg-soft'
        ].join(' ')

    return (
        <div ref={rootRef} className='relative shrink-0'>
            <button
                type='button'
                aria-label={ariaLabel}
                aria-haspopup='menu'
                aria-expanded={open}
                onClick={() => setOpen((v) => !v)}
                className={
                    triggerClassName ??
                    `text-muted hover:bg-surface-hover flex items-center justify-center transition-colors ${
                        compact ? 'h-8 w-8 rounded-md' : 'rounded-pill h-9 w-9'
                    }`
                }
            >
                <EllipsisHorizontalIcon className='h-4 w-4' />
            </button>
            {open && (
                <div
                    role='menu'
                    aria-label={ariaLabel}
                    className='popover-panel bg-surface-elevated shadow-elevated absolute right-0 top-full z-50 mt-1 w-48 rounded-md p-1'
                >
                    {items.map((entry, index) => {
                        if (isSeparator(entry))
                            return (
                                <div
                                    key={`separator-${index}`}
                                    className='popover-separator'
                                />
                            )
                        const item = entry
                        const row = (
                            <button
                                key={item.label}
                                type='button'
                                role='menuitem'
                                disabled={item.disabled}
                                onClick={() => {
                                    if (item.disabled) return
                                    setOpen(false)
                                    item.onSelect()
                                }}
                                className={itemClass(item)}
                            >
                                <span className='min-w-0 flex-1 truncate'>
                                    {item.label}
                                </span>
                                {item.trailing && (
                                    <span
                                        aria-hidden='true'
                                        className='text-subtle shrink-0'
                                    >
                                        {item.trailing}
                                    </span>
                                )}
                            </button>
                        )
                        return item.disabled && item.disabledReason ? (
                            <ShortcutTooltip
                                key={item.label}
                                label={item.disabledReason}
                                placement='bottom-end'
                                className='block w-full'
                            >
                                {row}
                            </ShortcutTooltip>
                        ) : (
                            row
                        )
                    })}
                </div>
            )}
        </div>
    )
}

export default OverflowMenu
