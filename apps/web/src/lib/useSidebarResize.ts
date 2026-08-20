import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react'

export const SIDEBAR_MIN_WIDTH = 200
export const SIDEBAR_MAX_WIDTH = 480
export const SIDEBAR_DEFAULT_WIDTH = 304

const clampWidth = (value: number, min: number, max: number): number =>
    Math.min(Math.max(value, min), max)

interface SidebarResizeOptions {
    storageKey: string
    direction: 'ltr' | 'rtl'
    min?: number
    max?: number
    defaultWidth?: number
}

export interface SidebarResize {
    width: number
    resizing: boolean
    asideRef: RefObject<HTMLElement>
    startResize: (event: ReactPointerEvent) => void
    resetWidth: () => void
}

const readStoredWidth = (
    storageKey: string,
    min: number,
    max: number,
    defaultWidth: number
): number => {
    if (typeof window === 'undefined') return defaultWidth
    try {
        const raw = window.localStorage.getItem(storageKey)
        if (!raw) return defaultWidth
        const value = Number.parseInt(raw, 10)
        if (Number.isNaN(value)) return defaultWidth
        return clampWidth(value, min, max)
    } catch {
        return defaultWidth
    }
}

// Drag-to-resize for a navigation sidebar. The live drag writes width straight
// to the DOM node (no per-move React render of the surrounding tree) and only
// commits to state — and localStorage — on pointer-up. Reading the ref through
// the returned `width` keeps a mid-drag re-render from snapping back.
export const useSidebarResize = (
    options: SidebarResizeOptions
): SidebarResize => {
    const { storageKey, direction } = options
    const min = options.min ?? SIDEBAR_MIN_WIDTH
    const max = options.max ?? SIDEBAR_MAX_WIDTH
    const defaultWidth = options.defaultWidth ?? SIDEBAR_DEFAULT_WIDTH
    const [width, setWidth] = useState<number>(() =>
        readStoredWidth(storageKey, min, max, defaultWidth)
    )
    const [resizing, setResizing] = useState(false)
    const widthRef = useRef(width)
    const asideRef = useRef<HTMLElement>(null)

    useEffect(() => {
        widthRef.current = width
        if (typeof window === 'undefined') return
        try {
            window.localStorage.setItem(storageKey, String(width))
        } catch {
            // ignore quota / disabled storage
        }
    }, [width, storageKey])

    useEffect(() => {
        if (!resizing) return
        const onMove = (event: PointerEvent): void => {
            const aside = asideRef.current
            if (!aside) return
            const rect = aside.getBoundingClientRect()
            const raw =
                direction === 'rtl'
                    ? rect.right - event.clientX
                    : event.clientX - rect.left
            const next = clampWidth(Math.round(raw), min, max)
            widthRef.current = next
            aside.style.width = `${next}px`
        }
        const onUp = (): void => {
            setResizing(false)
            setWidth(widthRef.current)
        }
        const prevUserSelect = document.body.style.userSelect
        const prevCursor = document.body.style.cursor
        document.body.style.userSelect = 'none'
        document.body.style.cursor = 'col-resize'
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
        return () => {
            window.removeEventListener('pointermove', onMove)
            window.removeEventListener('pointerup', onUp)
            document.body.style.userSelect = prevUserSelect
            document.body.style.cursor = prevCursor
        }
    }, [resizing, direction, min, max])

    const startResize = useCallback((event: ReactPointerEvent): void => {
        event.preventDefault()
        setResizing(true)
    }, [])

    const resetWidth = useCallback(
        (): void => setWidth(defaultWidth),
        [defaultWidth]
    )

    return {
        width: resizing ? widthRef.current : width,
        resizing,
        asideRef,
        startResize,
        resetWidth
    }
}
