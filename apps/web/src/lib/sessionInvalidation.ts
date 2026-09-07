export interface SessionInvalidationQueueOptions {
    refresh: (agentId: string) => void
    shouldRefresh: (agentId: string) => boolean
    windowMs?: number
}

export interface SessionInvalidationQueue {
    invalidate: (agentId: string) => void
    dispose: () => void
}

// Trailing edge, not leading: a channel fan-out or an automation batch emits
// several events within milliseconds, and refetching on the first one races the
// remaining inserts and renders a partial list.
export const SESSION_INVALIDATION_WINDOW_MS = 400

export const createSessionInvalidationQueue = (
    options: SessionInvalidationQueueOptions
): SessionInvalidationQueue => {
    const { refresh, shouldRefresh } = options
    const windowMs = options.windowMs ?? SESSION_INVALIDATION_WINDOW_MS
    const pending = new Set<string>()
    let timer: ReturnType<typeof setTimeout> | null = null

    const fire = (): void => {
        timer = null
        const agentIds = Array.from(pending)
        pending.clear()
        for (const agentId of agentIds) {
            if (!shouldRefresh(agentId)) continue
            refresh(agentId)
        }
    }

    return {
        invalidate: (agentId: string): void => {
            if (!shouldRefresh(agentId)) return
            pending.add(agentId)
            if (timer !== null) return
            timer = setTimeout(fire, windowMs)
        },
        dispose: (): void => {
            if (timer !== null) clearTimeout(timer)
            timer = null
        }
    }
}
