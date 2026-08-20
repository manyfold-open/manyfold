import { useEffect, useRef, useState } from 'react'

// The §10.8 timing gate, shared by every loading indicator. A request
// that resolves inside 150ms never shows an indicator (anything that
// fast would only flash); once an indicator appears it stays a minimum
// 300ms even if data lands earlier (a skeleton that blinks away reads
// as a glitch). `fadeIn` tells the caller whether arriving content
// should play the 140ms .loading-fade-in entrance — only after an
// indicator was actually shown; fast paths deliver content bare.
const SHOW_DELAY_MS = 150
const MIN_VISIBLE_MS = 300

export interface LoadingGate {
    showLoading: boolean
    fadeIn: boolean
}

export const useLoadingGate = (pending: boolean): LoadingGate => {
    const [showLoading, setShowLoading] = useState(false)
    const shownAt = useRef(0)
    const everShown = useRef(false)

    useEffect(() => {
        if (pending) {
            if (showLoading) return
            const timer = setTimeout(() => {
                shownAt.current = Date.now()
                everShown.current = true
                setShowLoading(true)
            }, SHOW_DELAY_MS)
            return () => clearTimeout(timer)
        }
        if (!showLoading) return
        const remaining = MIN_VISIBLE_MS - (Date.now() - shownAt.current)
        if (remaining <= 0) {
            setShowLoading(false)
            return
        }
        const timer = setTimeout(() => setShowLoading(false), remaining)
        return () => clearTimeout(timer)
    }, [pending, showLoading])

    return { showLoading, fadeIn: everShown.current }
}
