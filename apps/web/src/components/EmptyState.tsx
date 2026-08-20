import type { FC, ReactNode } from 'react'
import type { LucideIcon } from '@/components/icons'

// DESIGN.md §10.7 — the cause of emptiness decides copy and affordance.
// Only first-use may carry an action, and only first-use gets the dashed
// placeholder frame ("a surface that hasn't materialized yet").
export type EmptyStateKind =
    | 'first-use'
    | 'no-results'
    | 'no-selection'
    | 'all-clear'

export type EmptyStateTier = 'stack' | 'line'

interface EmptyStateAction {
    label: string
    onClick: () => void
}

interface Props {
    kind: EmptyStateKind
    tier: EmptyStateTier
    icon?: LucideIcon
    title?: string
    body?: string
    action?: EmptyStateAction
    frame?: boolean
    subtle?: boolean
    mono?: boolean
    className?: string
}

const EmptyState: FC<Props> = ({
    kind,
    tier,
    icon: Icon,
    title,
    body,
    action,
    frame = true,
    subtle,
    mono,
    className
}): ReactNode => {
    if (tier === 'line') {
        return (
            <div
                className={[
                    'text-caption',
                    subtle ? 'text-subtle' : 'text-muted',
                    mono ? 'font-mono' : '',
                    className ?? ''
                ]
                    .filter(Boolean)
                    .join(' ')}
            >
                {body ?? title}
            </div>
        )
    }
    const firstUse = kind === 'first-use'
    return (
        <div
            className={[
                'flex flex-col items-center justify-center px-6 py-10 text-center',
                firstUse && frame
                    ? 'border-divider rounded-md border border-dashed'
                    : '',
                className ?? ''
            ]
                .filter(Boolean)
                .join(' ')}
        >
            {Icon ? <Icon className='text-muted mb-3 h-7 w-7' /> : null}
            {title ? (
                <div className='text-ui text-fg font-medium'>{title}</div>
            ) : null}
            {body ? (
                <div className='text-caption text-muted mt-1 max-w-sm'>
                    {body}
                </div>
            ) : null}
            {firstUse && action ? (
                <button
                    type='button'
                    className='workbench-button-secondary mt-4'
                    onClick={action.onClick}
                >
                    {action.label}
                </button>
            ) : null}
        </div>
    )
}

export default EmptyState
