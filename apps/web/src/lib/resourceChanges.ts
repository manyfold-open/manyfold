import type { ResourceChangedEvent } from '@manyfold/shared'

export type ResourceInvalidation = {
    resource: ResourceChangedEvent['resource'] | '*'
    resourceId?: string
    agentId?: string
}

export const matchesResourceChange = (
    event: ResourceInvalidation,
    resource: ResourceChangedEvent['resource'],
    resourceId?: string,
    agentId?: string
): boolean =>
    (event.resource === '*' || event.resource === resource) &&
    (!resourceId || !event.resourceId || event.resourceId === resourceId) &&
    (!agentId || !event.agentId || event.agentId === agentId)

type Listener = (event: ResourceInvalidation) => void
const listeners = new Set<Listener>()

export const publishResourceChanged = (event: ResourceInvalidation): void => {
    for (const listener of listeners) listener(event)
}

export const subscribeResourceChanges = (listener: Listener): (() => void) => {
    listeners.add(listener)
    return () => {
        listeners.delete(listener)
    }
}

export const createResourceRefresh = (
    refresh: () => Promise<unknown>,
    delayMs = 100
): { request: (immediate?: boolean) => void; dispose: () => void } => {
    let disposed = false
    let running = false
    let pending = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const run = async (): Promise<void> => {
        timer = undefined
        if (disposed || running) return
        running = true
        pending = false
        try {
            await refresh()
        } catch {
            // The page owns error presentation; invalidation must remain usable.
        } finally {
            running = false
            if (pending && !disposed)
                timer = setTimeout(() => void run(), delayMs)
        }
    }
    return {
        request: (immediate = false) => {
            if (disposed) return
            pending = true
            if (immediate && !running) {
                clearTimeout(timer)
                void run()
                return
            }
            if (!running && timer === undefined)
                timer = setTimeout(() => void run(), delayMs)
        },
        dispose: () => {
            disposed = true
            clearTimeout(timer)
        }
    }
}
