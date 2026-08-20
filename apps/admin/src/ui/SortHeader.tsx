import type { ReactNode } from 'react'
import { cn } from './classNames'

export type SortDirection = 'asc' | 'desc'

interface Props<K extends string> {
    sortKey: K
    activeKey: K | null
    direction: SortDirection
    onToggle: (key: K) => void
    align?: 'left' | 'right'
    className?: string
    children: ReactNode
}

export const SortHeader = <K extends string>({
    sortKey,
    activeKey,
    direction,
    onToggle,
    align = 'left',
    className,
    children
}: Props<K>): ReactNode => {
    const active = activeKey === sortKey
    const indicator = active ? (direction === 'asc' ? '↑' : '↓') : ''
    return (
        <th
            scope='col'
            className={cn(
                'px-2 py-1.5 font-normal',
                align === 'right' ? 'text-right' : 'text-left',
                className
            )}
        >
            <button
                type='button'
                onClick={(): void => onToggle(sortKey)}
                aria-sort={
                    active
                        ? direction === 'asc'
                            ? 'ascending'
                            : 'descending'
                        : 'none'
                }
                className={cn(
                    'hover:text-brand inline-flex items-center gap-1 transition-colors',
                    active ? 'text-brand' : 'text-body'
                )}
            >
                <span>{children}</span>
                <span className='tnum text-caption-sm w-2 leading-none'>
                    {indicator}
                </span>
            </button>
        </th>
    )
}
