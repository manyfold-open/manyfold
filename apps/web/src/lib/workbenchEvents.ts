import type { NcaClient } from '@manyfold/sdk'

type Handlers = Parameters<NcaClient['agents']['streamSpriteStatus']>[0] & {
    onReconnected?: () => void
}
const listeners = new Set<Handlers>()

export const subscribeWorkbenchEvents = (handlers: Handlers): (() => void) => {
    listeners.add(handlers)
    return () => {
        listeners.delete(handlers)
    }
}

export const dispatchWorkbenchEvents = (
    dispatch: (handlers: Handlers) => void
): void => {
    for (const handlers of listeners) {
        try {
            dispatch(handlers)
        } catch (error) {
            console.error('Workbench event listener failed', error)
        }
    }
}
