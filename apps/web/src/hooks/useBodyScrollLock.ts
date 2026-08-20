import { useEffect } from 'react'

// Keep a dialog's internal scrolling from chaining out to the page behind it,
// without locking or moving the document scroll.
//
// The app root is `html, body, #root { height: 100% }` (styles.css), so
// full-page routes like /settings scroll on the *window*. Two tempting locks
// both backfire there:
//   - `overflow: hidden` on html/body collapses the window scroll to the top
//     the instant a dialog opens (a viewport-height root has nowhere to hold
//     the offset), yanking the page to position 0.
//   - `position: fixed` on the body freezes it in place but turns the body into
//     its own stacking context, which kills the dialog's `backdrop-blur` — the
//     backdrop then renders opaque.
// `overscroll-behavior: none` avoids both: it only suppresses scroll-chaining /
// rubber-banding, leaving the scroll position and the see-through backdrop
// untouched.
export function useBodyScrollLock(active: boolean): void {
    useEffect(() => {
        if (!active) return
        if (typeof document === 'undefined') return

        const html = document.documentElement
        const body = document.body
        const prevHtmlOverscroll = html.style.overscrollBehavior
        const prevBodyOverscroll = body.style.overscrollBehavior

        html.style.overscrollBehavior = 'none'
        body.style.overscrollBehavior = 'none'

        return () => {
            html.style.overscrollBehavior = prevHtmlOverscroll
            body.style.overscrollBehavior = prevBodyOverscroll
        }
    }, [active])
}
