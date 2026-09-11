import type { FC, ReactNode } from 'react'
import ShortcutTooltip from '@/components/ShortcutTooltip'
import type { LucideIcon } from '@/components/icons'

// The compact filter chips over a pick-one list (agent runtime kinds, the
// provider section's Cloud / Local): a recessed track of h-7 counters, the
// active one lifted onto the surface. A filter, never a selection — the
// list's own rows carry the check.
export const FilterChipRow: FC<{
    ariaLabel: string
    children: ReactNode
    className?: string
}> = ({ ariaLabel, children, className }): ReactNode => (
    <div
        role='group'
        aria-label={ariaLabel}
        className={[
            'bg-soft shadow-ring-light inline-flex flex-wrap gap-1 rounded-md p-1',
            className
        ]
            .filter(Boolean)
            .join(' ')}
    >
        {children}
    </div>
)

export const FilterChip: FC<{
    icon?: LucideIcon
    label: string
    count: number
    active: boolean
    onSelect: () => void
}> = ({ icon: Icon, label, count, active, onSelect }): ReactNode => {
    const chip = (
        <button
            type='button'
            aria-label={Icon ? label : undefined}
            aria-pressed={active}
            onClick={onSelect}
            className={[
                'text-caption inline-flex h-7 items-center gap-1.5 rounded-sm px-2.5 transition-colors',
                active
                    ? 'bg-surface text-fg shadow-ring-light'
                    : 'text-muted hover:bg-surface-hover'
            ].join(' ')}
        >
            {Icon ? (
                <Icon className='h-4 w-4 shrink-0' aria-hidden='true' />
            ) : (
                <span>{label}</span>
            )}
            <span className='tabular-nums'>{count}</span>
        </button>
    )
    // A visible label is already the accessible name; only the icon-only chips
    // need the hover affordance that repeats it.
    return Icon ? <ShortcutTooltip label={label}>{chip}</ShortcutTooltip> : chip
}
