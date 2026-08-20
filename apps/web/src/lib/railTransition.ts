import { flushSync } from 'react-dom'
import type { NavigateFunction, NavigateOptions } from 'react-router-dom'

type RailNavDirection = 'forward' | 'back'

// Workspace ↔ settings share the same rail background color and width, so the
// only thing that should move across the route change is the rail's *content*.
// We drive that with the View Transitions API (see `.rail-vt-pane` + the
// `::view-transition-*(mf-rail-pane)` rules in styles.css). The direction attr
// lets the same paint mirror itself on the way back.
//
// The app mounts a non-data `<BrowserRouter>`, so React Router's own
// `viewTransition` navigate option is a no-op here — we wrap the navigation in
// `startViewTransition` ourselves and `flushSync` the route update so the new
// rail is committed before the browser captures the "new" snapshot. Browsers
// without `startViewTransition` (or a missing document) just navigate plainly.
export const navigateWithRailTransition = (
    navigate: NavigateFunction,
    to: string,
    direction: RailNavDirection,
    options?: NavigateOptions
): void => {
    const doc =
        typeof document !== 'undefined'
            ? (document as Document & {
                  startViewTransition?: (
                      callback: () => void
                  ) => { finished?: Promise<unknown> }
              })
            : undefined
    const start = doc?.startViewTransition?.bind(doc)
    if (!doc || !start) {
        navigate(to, options)
        return
    }
    const root = doc.documentElement
    root.setAttribute('data-rail-nav', direction)
    const transition = start(() => {
        flushSync(() => {
            navigate(to, options)
        })
    })
    // Keep the flag (and its scoped CSS) alive only for the duration of the
    // transition so it can't bleed into a later, unrelated view transition.
    void Promise.resolve(transition?.finished).finally(() => {
        root.removeAttribute('data-rail-nav')
    })
}
