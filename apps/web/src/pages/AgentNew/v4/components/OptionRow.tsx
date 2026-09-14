import type { FC, ReactNode } from 'react'
import { CheckIcon } from '@/components/icons'
import type { LucideIcon } from '@/components/icons'
import type { IconType } from '@/lib/brandIcons'

// One choice in a step. Rows sit directly on the page canvas — no card, no
// nested list container — so the whole step is two levels deep (page → row)
// instead of four. Only a divider separates siblings.
//
// Selection language follows DESIGN.md §8.12: this is a STATIC pick-one list
// living in the page, so the fill belongs to selection (not to hover) and the
// chosen row wears the §8.10 active fill + ring alongside the trailing
// --color-link check. The canvas is `bg-main`, whose hover pair is
// surface-subtle / surface per the §8.9 parent-matching rule.
export interface OptionRowProps {
    title: string
    // What this row IS — one quiet line under the title.
    detail?: ReactNode
    // Right-hand attribute: a subscription badge, a cost read-out, a status.
    meta?: ReactNode
    Icon?: LucideIcon
    Mark?: IconType
    selected?: boolean
    // A row the user cannot pick stays in place and says why — hiding it
    // leaves them wondering where their own machine went.
    disabled?: boolean
    onSelect?: () => void
}

const ROW_BASE =
    'group flex w-full items-start gap-3 rounded-sm px-3 py-3 text-left transition-colors'
const ROW_REST =
    'hover:bg-surface-subtle dark:hover:bg-surface cursor-pointer'
const ROW_SELECTED = 'bg-surface-subtle dark:bg-surface shadow-ring-light'
const ROW_DISABLED = 'cursor-not-allowed opacity-60'

export const OptionRow: FC<OptionRowProps> = ({
    title,
    detail,
    meta,
    Icon,
    Mark,
    selected = false,
    disabled = false,
    onSelect
}): ReactNode => {
    const state = disabled
        ? ROW_DISABLED
        : selected
          ? ROW_SELECTED
          : ROW_REST
    return (
        <button
            type='button'
            role='radio'
            aria-checked={selected}
            disabled={disabled}
            onClick={disabled ? undefined : onSelect}
            className={ROW_BASE + ' ' + state}
        >
            <span
                className='text-subtle mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center'
                aria-hidden='true'
            >
                {Mark ? <Mark size={18} /> : Icon ? <Icon /> : null}
            </span>
            <span className='min-w-0 flex-1'>
                <span className='text-ui text-fg block font-medium'>
                    {title}
                </span>
                {detail !== undefined && detail !== null && (
                    <span className='text-caption text-muted mt-0.5 block'>
                        {detail}
                    </span>
                )}
            </span>
            {meta !== undefined && meta !== null && (
                <span className='text-caption text-subtle mt-0.5 shrink-0 text-right'>
                    {meta}
                </span>
            )}
            <span
                className='mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center'
                aria-hidden='true'
            >
                {selected && <CheckIcon className='text-link h-4 w-4' />}
            </span>
        </button>
    )
}

// A set of sibling rows under one heading. The heading names a FACT about the
// set — where these run — never a judgement about what they are good at.
export const OptionGroup: FC<{
    title: string
    hint?: string
    children: ReactNode
}> = ({ title, hint, children }): ReactNode => (
    <div className='mt-6 first:mt-0'>
        <div className='px-3 pb-1'>
            <span className='workbench-group-label'>
                {title}
                {hint !== undefined && (
                    <span className='text-placeholder font-normal'>
                        {' · ' + hint}
                    </span>
                )}
            </span>
        </div>
        <div
            role='radiogroup'
            aria-label={title}
            className='divide-divider divide-y'
        >
            {children}
        </div>
    </div>
)
