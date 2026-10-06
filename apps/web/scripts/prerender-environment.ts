/* The prerender renders what a first-time visitor's browser sees before any
   script runs: the page's address, no stored choices, no session. The app's
   initial-state readers (language, theme, the marketing auth bypass) and its
   module-level setup get exactly that. Anything else they read is a bug in a
   marketing page's first render, and fails the build rather than reaching a
   visitor as a hydration mismatch (ADR-0042). Returns the setter that points
   the address at the next page. */
export const installFirstVisit = (): ((path: string) => void) => {
    const visit = { path: '/' }
    const origin = 'https://manyfold.ai'
    const location = {
        get href() {
            return origin + visit.path
        },
        get pathname() {
            return visit.path
        },
        origin,
        host: 'manyfold.ai',
        hostname: 'manyfold.ai',
        protocol: 'https:',
        search: '',
        hash: ''
    }
    const storage = (): Storage => {
        const items = new Map<string, string>()
        return {
            get length() {
                return items.size
            },
            clear: () => items.clear(),
            getItem: (key) => items.get(key) ?? null,
            key: () => null,
            removeItem: (key) => void items.delete(key),
            setItem: (key, value) => void items.set(key, String(value))
        }
    }
    const noop = (): void => {}
    const element = (): object => ({
        style: {},
        dataset: {},
        classList: { add: noop, remove: noop, contains: () => false },
        setAttribute: noop,
        getAttribute: () => null,
        appendChild: noop,
        addEventListener: noop,
        removeEventListener: noop
    })
    Object.assign(globalThis, {
        window: globalThis,
        location,
        localStorage: storage(),
        sessionStorage: storage(),
        matchMedia: () => ({
            matches: false,
            addEventListener: noop,
            removeEventListener: noop
        }),
        document: {
            documentElement: element(),
            head: element(),
            body: element(),
            cookie: '',
            visibilityState: 'visible',
            createElement: element,
            createElementNS: element,
            getElementById: () => null,
            querySelector: () => null,
            querySelectorAll: () => [],
            addEventListener: noop,
            removeEventListener: noop
        },
        addEventListener: noop,
        removeEventListener: noop
    })
    return (path) => {
        visit.path = path
    }
}
