// After a deploy replaces the hashed chunk set, a long-lived tab's next lazy
// import 404s and the route crashes (#540). Recovery is a guarded one-shot
// reload: location.reload() keeps pathname/query and replays no POSTs, and a
// sessionStorage stamp makes it one-shot per window so a genuinely broken
// deploy, CDN or network outage falls through to the existing
// ErrorBoundary/Sentry pipeline instead of looping.
//
// The reload is driven from guardedImport, and the vite:preloadError listener
// deliberately does not preventDefault. Vite 6.4.2 emits
// `baseModule().catch(handlePreloadError)` and handlePreloadError only
// rethrows while the event is unprevented (vite/dist/node/chunks/dep-*.js,
// preload()), so preventing it fulfils the import with undefined and
// React.lazy then reads .default off undefined — the TypeError this issue
// keeps reporting. Letting it throw preserves the rejection; guardedImport
// converts that into a promise that stays pending until the reload commits, so
// React keeps showing the Suspense fallback instead of a crash.
//
// Injected environment because the axiom logger reads import.meta.env at
// import time, which does not exist under the tsx test runner.

type PreloadErrorEvent = Event & { payload?: unknown }

export type PreloadErrorRecoveryEnv = {
    addEventListener: (
        type: 'vite:preloadError',
        listener: (event: PreloadErrorEvent) => void
    ) => void
    storage: () => Pick<Storage, 'getItem' | 'setItem'>
    reload: () => void
    now: () => number
    setTimer: (run: () => void, ms: number) => void
    report: (message: string, error: unknown) => void
}

export type PreloadErrorRecovery = {
    install: () => void
    guardedImport: <T>(load: () => Promise<T>) => Promise<T>
}

const GUARD_KEY = 'mf:preload-error-reloaded-at'
export const GUARD_WINDOW_MS = 60_000
export const RELOAD_COMMIT_TIMEOUT_MS = 15_000

export const SWALLOWED_MODULE_DIAGNOSTIC =
    'dynamic import fulfilled with no module namespace; a vite:preloadError listener swallowed the failure'

// How Chrome, Firefox and Safari word a module the network could not deliver,
// plus the MIME rejection a proxy serving HTML as JS produces and Vite's own
// CSS preload failure. Anything else — a module that throws while evaluating,
// an app-level runtime error — is not a stale deployment and must never cost
// the user a reload.
const CHUNK_LOAD_MESSAGES = [
    'failed to fetch dynamically imported module',
    'error loading dynamically imported module',
    'importing a module script failed',
    'failed to load module script',
    'unable to preload css'
]

const isChunkLoadError = (error: unknown): boolean => {
    const message = error instanceof Error ? error.message : String(error ?? '')
    const lowered = message.toLowerCase()
    return CHUNK_LOAD_MESSAGES.some((needle) => lowered.includes(needle))
}

const readGuard = (env: PreloadErrorRecoveryEnv): number | null => {
    try {
        const raw = env.storage().getItem(GUARD_KEY)
        if (raw === null) return null
        const at = Number(raw)
        return Number.isFinite(at) ? at : null
    } catch {
        return null
    }
}

const writeGuard = (env: PreloadErrorRecoveryEnv): boolean => {
    const at = String(env.now())
    try {
        const storage = env.storage()
        storage.setItem(GUARD_KEY, at)
        return storage.getItem(GUARD_KEY) === at
    } catch {
        return false
    }
}

export const createPreloadErrorRecovery = (
    env: PreloadErrorRecoveryEnv
): PreloadErrorRecovery => {
    let reloading = false

    const requestReload = (error: unknown): boolean => {
        if (reloading) return true
        const guardedAt = readGuard(env)
        if (guardedAt !== null && env.now() - guardedAt < GUARD_WINDOW_MS) {
            env.report(
                'preload failed again within the reload guard window; surfacing the error',
                error
            )
            return false
        }
        if (!writeGuard(env)) {
            env.report(
                'preload failed but the reload guard is not persistable; surfacing the error',
                error
            )
            return false
        }
        reloading = true
        env.report(
            'stale chunk after deployment; reloading once to pick up the current release',
            error
        )
        env.reload()
        return true
    }

    const recover = <T>(error: unknown): Promise<T> => {
        if (!requestReload(error)) return Promise.reject(error)
        return new Promise<T>((_resolve, reject) => {
            env.setTimer(() => {
                env.report(
                    'the recovery reload never committed; surfacing the preload error',
                    error
                )
                reject(error)
            }, RELOAD_COMMIT_TIMEOUT_MS)
        })
    }

    return {
        install: () => {
            env.addEventListener('vite:preloadError', (event) => {
                env.report(
                    'vite reported a failed chunk preload',
                    event.payload
                )
            })
        },
        guardedImport: async (load) => {
            let loaded
            try {
                loaded = await load()
            } catch (error) {
                if (!isChunkLoadError(error)) throw error
                return recover(error)
            }
            if (loaded === undefined || loaded === null) {
                return recover(new Error(SWALLOWED_MODULE_DIAGNOSTIC))
            }
            return loaded
        }
    }
}

export const browserPreloadErrorRecoveryEnv = (
    report: PreloadErrorRecoveryEnv['report']
): PreloadErrorRecoveryEnv => ({
    addEventListener: (type, listener) =>
        window.addEventListener(type, listener as EventListener),
    storage: () => window.sessionStorage,
    reload: () => window.location.reload(),
    now: () => Date.now(),
    setTimer: (run, ms) => {
        window.setTimeout(run, ms)
    },
    report
})
