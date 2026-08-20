import { useCallback, useMemo, useState } from 'react'
import type { SortDirection } from '@/ui'

type SortValue = string | number | null | undefined
export type SortAccessors<T, K extends string> = Record<
    K,
    (row: T) => SortValue
>

interface UseTableSortResult<T, K extends string> {
    sorted: T[]
    sortKey: K | null
    direction: SortDirection
    toggle: (key: K) => void
}

const compare = (a: SortValue, b: SortValue): number => {
    if (a === b) return 0
    if (a === null || a === undefined) return 1
    if (b === null || b === undefined) return -1
    if (typeof a === 'number' && typeof b === 'number') return a - b
    return String(a).localeCompare(String(b))
}

export const useTableSort = <T, K extends string>(
    rows: T[],
    accessors: SortAccessors<T, K>,
    defaultKey: K | null = null,
    defaultDirection: SortDirection = 'desc'
): UseTableSortResult<T, K> => {
    const [sortKey, setSortKey] = useState<K | null>(defaultKey)
    const [direction, setDirection] = useState<SortDirection>(defaultDirection)

    const toggle = useCallback(
        (key: K): void => {
            if (sortKey === key) {
                setDirection((d) => (d === 'asc' ? 'desc' : 'asc'))
                return
            }
            setSortKey(key)
            setDirection('desc')
        },
        [sortKey]
    )

    const sorted = useMemo(() => {
        if (!sortKey) return rows
        const accessor = accessors[sortKey]
        const sign = direction === 'asc' ? 1 : -1
        return [...rows].sort((a, b) => sign * compare(accessor(a), accessor(b)))
    }, [rows, sortKey, direction, accessors])

    return { sorted, sortKey, direction, toggle }
}
