import { lazy } from 'react'
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

// Every React.lazy boundary in this app loads through here, so a chunk deleted
// by a deploy recovers the same way everywhere instead of via a route list
// that would rot (#540). eslint.config.js blocks importing lazy from react
// anywhere else in apps/web/src.
export const lazyChunk: typeof lazy = (load) =>
    lazy(() => recovery.guardedImport(load))
