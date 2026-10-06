import { lazy, type LazyExoticComponent } from 'react'
import { logger } from '@/lib/axiom'
import {
    browserPreloadErrorRecoveryEnv,
    createPreloadErrorRecovery
} from '@/lib/preloadErrorRecovery'

const recovery = createPreloadErrorRecovery(
    browserPreloadErrorRecoveryEnv((message, error) => {
        logger.error(message, {
            error:
                error instanceof Error
                    ? (error.stack ?? error.message)
                    : String(error ?? '')
        })
    })
)

export const installPreloadErrorRecovery = recovery.install
export const loadChunk = recovery.guardedImport

// Every React.lazy boundary in this app loads through here, so a chunk deleted
// by a deploy recovers the same way everywhere instead of via a route list
// that would rot (#540). eslint.config.js blocks importing lazy from react
// anywhere else in apps/web/src.
//
// `preload` loads the chunk ahead of the first render, which then resolves
// synchronously: React.lazy suspends on any promise, a settled one included,
// and a hydrating page whose boundary is still suspended drops its prerendered
// markup on the first state update that reaches it (React #421, ADR-0042).
// What React.lazy accepts, taken from its own signature.
type LazyComponent = Awaited<ReturnType<Parameters<typeof lazy>[0]>>['default']

export const lazyChunk = <T extends LazyComponent>(
    load: () => Promise<{ default: T }>
): LazyExoticComponent<T> & { preload: () => Promise<unknown> } => {
    let loaded: { default: T } | undefined
    const preload = (): Promise<{ default: T }> =>
        loadChunk(load).then((module) => (loaded = module))
    const component = lazy(() =>
        loaded
            ? // A thenable that settles synchronously, read by React.lazy.
              ({
                  then: (resolve: (module: { default: T }) => void) =>
                      resolve(loaded!)
              } as unknown as Promise<{ default: T }>)
            : preload()
    )
    return Object.assign(component, { preload })
}
