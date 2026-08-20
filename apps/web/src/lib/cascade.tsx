import type { AgentFramework } from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { t } from '@manyfold/i18n'
import {
    CheckIcon,
    ChevronDownIcon,
    ChevronRightIcon,
    type LucideIcon
} from '@/components/icons'
import { FrameworkLogo } from '@/lib/frameworkMeta'

export type Health = 'error' | 'warn' | null

export const healthDotClass = (health: Exclude<Health, null>): string =>
    health === 'error' ? 'bg-error' : 'bg-warning'

export const Highlight: FC<{ text: string; q: string }> = ({
    text,
    q
}): ReactNode => {
    if (!q) return <>{text}</>
    const idx = text.toLowerCase().indexOf(q)
    if (idx < 0) return <>{text}</>
    return (
        <>
            {text.slice(0, idx)}
            <mark className='rounded-[3px] bg-[rgb(var(--color-info-bg))] px-0.5 text-[rgb(var(--color-info-strong))]'>
                {text.slice(idx, idx + q.length)}
            </mark>
            {text.slice(idx + q.length)}
        </>
    )
}

export interface GroupByOption<T extends string> {
    value: T
    label: string
    icon: LucideIcon
}

export function GroupByControl<T extends string>({
    value,
    onChange,
    options
}: {
    value: T
    onChange: (value: T) => void
    options: ReadonlyArray<GroupByOption<T>>
}): ReactNode {
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

    const current = options.find((o) => o.value === value) ?? options[0]
    const choose = (next: T): void => {
        onChange(next)
        setOpen(false)
    }

    return (
        <div ref={rootRef} className='relative'>
            <button
                type='button'
                onClick={() => setOpen((prev) => !prev)}
                aria-haspopup='menu'
                aria-expanded={open}
                className='text-caption text-muted hover:bg-rail-hover inline-flex h-7 items-center gap-1.5 rounded-full bg-transparent pr-2 pl-2.5 font-medium transition-colors'
            >
                {t('web.cascade.groupBy')}{' '}
                <span className='text-fg'>{current.label}</span>
                <ChevronDownIcon className='h-3.5 w-3.5' />
            </button>
            {open && (
                <>
                    <div className='popover-panel bg-surface-elevated shadow-elevated absolute top-full left-0 z-30 mt-1 hidden w-44 rounded-md p-1 lg:block'>
                        {options.map((option) => {
                            const Icon = option.icon
                            return (
                                <button
                                    key={option.value}
                                    type='button'
                                    onClick={() => choose(option.value)}
                                    className='text-ui hover:bg-soft flex w-full items-center gap-2.5 rounded-sm px-2.5 py-1.5 text-left'
                                >
                                    <Icon className='text-muted h-4 w-4' />
                                    <span className='flex-1'>{option.label}</span>
                                    {option.value === value && (
                                        <CheckIcon className='text-link h-4 w-4' />
                                    )}
                                </button>
                            )
                        })}
                    </div>
                    <div className='fixed inset-0 z-40 lg:hidden'>
                        <button
                            type='button'
                            aria-label={t('web.cascade.close')}
                            onClick={() => setOpen(false)}
                            className='absolute inset-0 bg-black/40'
                        />
                        <div className='bg-surface-elevated shadow-elevated absolute inset-x-0 bottom-0 rounded-t-2xl p-2 pb-6'>
                            <div className='bg-divider mx-auto mt-1 mb-2 h-1 w-9 rounded-full' />
                            <div className='text-caption text-subtle px-3 py-1.5'>
                                {t('web.cascade.groupBy')}
                            </div>
                            {options.map((option) => {
                                const Icon = option.icon
                                return (
                                    <button
                                        key={option.value}
                                        type='button'
                                        onClick={() => choose(option.value)}
                                        className='text-body active:bg-soft flex w-full items-center gap-3 rounded-md px-3 py-3 text-left'
                                    >
                                        <Icon className='text-muted h-5 w-5' />
                                        <span className='flex-1'>
                                            {option.label}
                                        </span>
                                        {option.value === value && (
                                            <CheckIcon className='text-link h-5 w-5' />
                                        )}
                                    </button>
                                )
                            })}
                        </div>
                    </div>
                </>
            )}
        </div>
    )
}

export const GroupHeader: FC<{
    label: string
    count: number
    open: boolean
    health: Health
    logo?: AgentFramework
    onToggle: () => void
}> = ({ label, count, open, health, logo, onToggle }): ReactNode => (
    <button
        type='button'
        onClick={onToggle}
        aria-expanded={open}
        className='hover:bg-rail-hover flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left transition-colors'
    >
        {open ? (
            <ChevronDownIcon className='text-subtle h-4 w-4 shrink-0' />
        ) : (
            <ChevronRightIcon className='text-subtle h-4 w-4 shrink-0' />
        )}
        {logo && <FrameworkLogo framework={logo} size={16} />}
        <span className='text-ui text-muted min-w-0 flex-1 truncate font-medium'>
            {label}
        </span>
        {!open && health && (
            <span
                className={[
                    'h-2 w-2 shrink-0 rounded-full',
                    healthDotClass(health)
                ].join(' ')}
            />
        )}
        <span className='text-caption text-subtle tabular-nums'>{count}</span>
    </button>
)

type ExpandedByDim<D extends string> = Record<D, Set<string>>

interface StoredCascade<D extends string> {
    groupBy: D
    expanded: Record<D, string[]>
}

const emptyDims = <D extends string>(
    dims: readonly D[]
): ExpandedByDim<D> => {
    const out = {} as ExpandedByDim<D>
    for (const d of dims) out[d] = new Set<string>()
    return out
}

const loadStored = <D extends string>(
    storeKey: string,
    dims: readonly D[],
    fallback: D
): { groupBy: D; expanded: ExpandedByDim<D> } => {
    try {
        const raw = localStorage.getItem(storeKey)
        if (!raw) return { groupBy: fallback, expanded: emptyDims(dims) }
        const parsed = JSON.parse(raw) as Partial<StoredCascade<D>>
        const groupBy = dims.includes(parsed.groupBy as D)
            ? (parsed.groupBy as D)
            : fallback
        const expanded = emptyDims(dims)
        for (const d of dims) expanded[d] = new Set(parsed.expanded?.[d] ?? [])
        return { groupBy, expanded }
    } catch {
        return { groupBy: fallback, expanded: emptyDims(dims) }
    }
}

export interface CascadeState<D extends string> {
    groupBy: D
    setGroupBy: (value: D) => void
    expanded: Set<string>
    toggle: (key: string) => void
    collapseAll: () => void
    expandAll: (keys: string[]) => void
    reveal: (keys: string[]) => void
}

export function useCascadeState<D extends string>(
    storeKey: string,
    dims: readonly D[],
    fallback: D
): CascadeState<D> {
    const initial = useRef(loadStored(storeKey, dims, fallback))
    const [groupBy, setGroupBy] = useState<D>(initial.current.groupBy)
    const [expandedByDim, setExpandedByDim] = useState<ExpandedByDim<D>>(
        initial.current.expanded
    )

    useEffect(() => {
        try {
            const expanded = {} as Record<D, string[]>
            for (const d of dims) expanded[d] = [...expandedByDim[d]]
            localStorage.setItem(
                storeKey,
                JSON.stringify({ groupBy, expanded })
            )
        } catch {
            // ignore persistence failures (private mode, quota)
        }
    }, [groupBy, expandedByDim, dims, storeKey])

    const update = useCallback(
        (next: Set<string>): void => {
            setExpandedByDim(
                (prev) =>
                    ({ ...prev, [groupBy]: next }) as ExpandedByDim<D>
            )
        },
        [groupBy]
    )

    const toggle = useCallback(
        (key: string): void => {
            setExpandedByDim((prev) => {
                const next = new Set(prev[groupBy])
                if (next.has(key)) next.delete(key)
                else next.add(key)
                return { ...prev, [groupBy]: next } as ExpandedByDim<D>
            })
        },
        [groupBy]
    )

    const collapseAll = useCallback(
        (): void => update(new Set<string>()),
        [update]
    )
    const expandAll = useCallback(
        (keys: string[]): void => update(new Set(keys)),
        [update]
    )
    const reveal = useCallback(
        (keys: string[]): void => {
            setExpandedByDim((prev) => {
                const next = new Set(prev[groupBy])
                let changed = false
                for (const k of keys)
                    if (!next.has(k)) {
                        next.add(k)
                        changed = true
                    }
                return changed
                    ? ({ ...prev, [groupBy]: next } as ExpandedByDim<D>)
                    : prev
            })
        },
        [groupBy]
    )

    return {
        groupBy,
        setGroupBy,
        expanded: expandedByDim[groupBy],
        toggle,
        collapseAll,
        expandAll,
        reveal
    }
}
