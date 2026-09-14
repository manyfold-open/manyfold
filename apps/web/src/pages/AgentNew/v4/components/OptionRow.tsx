import type { FC, ReactNode } from 'react'
import { CheckIcon } from '@/components/icons'

// One choice in a step. Rows sit directly on the page canvas — no card, no
// nested list container — so the whole step is two levels deep (page → row)
// instead of four.
//
// Everything about the row's own surface lives in `.create-option-row`
// (styles.css): the inset hairline that separates siblings without following
// their radius, its withdrawal around the selected row, and the §8.12
// static-tier selection language (active fill + ring, with the trailing
// --color-link check below).
export interface OptionRowProps {
    title: string
    // What this row IS — one quiet line under the title.
    detail?: ReactNode
    // Right-hand attribute: a subscription badge, a cost read-out, a status.
    meta?: ReactNode
    // Whatever identifies the row: a framework logo, a Lucide glyph. The row
    // only reserves the space and keeps the column aligned.
    mark?: ReactNode
    selected?: boolean
    // A row the user cannot pick stays in place and says why — hiding it
    // leaves them wondering where their own machine went.
    disabled?: boolean
    onSelect?: () => void
}

export const OptionRow: FC<OptionRowProps> = ({
    title,
    detail,
    meta,
    mark,
    selected = false,
    disabled = false,
    onSelect
}): ReactNode => (
    <button
        type='button'
        role='radio'
        aria-checked={selected}
        disabled={disabled}
        onClick={disabled ? undefined : onSelect}
        className='create-option-row'
    >
        <span className='create-option-mark' aria-hidden='true'>
            {mark}
        </span>
        <span className='min-w-0 flex-1'>
            <span className='text-ui text-fg block font-medium'>{title}</span>
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
            className='mt-1 inline-flex h-4 w-4 shrink-0 items-center justify-center'
            aria-hidden='true'
        >
            {selected && <CheckIcon className='text-link h-4 w-4' />}
        </span>
    </button>
)

// A set of sibling rows under one heading. The heading names a FACT about the
// set — where these run — never a judgement about what they are good at.
//
// The list is pulled out by the row's own padding so the row text, the group
// heading and the step's question all start on the same left edge; indenting
// the rows instead would make the list read as a nested thing.
export const OptionGroup: FC<{
    title: string
    hint?: string
    children: ReactNode
}> = ({ title, hint, children }): ReactNode => (
    <div className='mt-6 first:mt-0'>
        <span className='workbench-group-label mb-0.5'>
            {title}
            {hint !== undefined && (
                <span className='text-placeholder font-normal'>
                    {' · ' + hint}
                </span>
            )}
        </span>
        <div role='radiogroup' aria-label={title} className='-mx-3'>
            {children}
        </div>
    </div>
)
