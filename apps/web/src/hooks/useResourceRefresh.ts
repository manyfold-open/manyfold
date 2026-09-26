import { useEffect } from 'react'
import type { ResourceChangedEvent } from '@manyfold/shared'
import {
    createResourceRefresh,
    matchesResourceChange,
    subscribeResourceChanges
} from '@/lib/resourceChanges'

export const useResourceRefresh = (
    resource: ResourceChangedEvent['resource'],
    resourceId: string | undefined,
    refresh: (signal: AbortSignal) => Promise<unknown>,
    {
        agentId,
        enabled = true,
        initial = true
    }: {
        agentId?: string
        enabled?: boolean
        initial?: boolean
    } = {}
): void => {
    useEffect(() => {
        if (!enabled) return
        const controller = new AbortController()
        const queue = createResourceRefresh(() => refresh(controller.signal))
        const visibleRefresh = (): void => {
            if (document.visibilityState === 'visible') queue.request()
        }
        const unsubscribe = subscribeResourceChanges((event) => {
            if (!matchesResourceChange(event, resource, resourceId, agentId))
                return
            visibleRefresh()
        })
        if (initial) queue.request(true)
        // NOTIFY is best-effort. Reconnect/focus plus a slow refresh converge
        // even if a notification was lost while the SSE transport stayed up.
        const timer = window.setInterval(visibleRefresh, 60_000)
        window.addEventListener('focus', visibleRefresh)
        window.addEventListener('online', visibleRefresh)
        document.addEventListener('visibilitychange', visibleRefresh)
        return () => {
            controller.abort()
            queue.dispose()
            unsubscribe()
            window.clearInterval(timer)
            window.removeEventListener('focus', visibleRefresh)
            window.removeEventListener('online', visibleRefresh)
            document.removeEventListener('visibilitychange', visibleRefresh)
        }
    }, [refresh, resource, resourceId, agentId, enabled, initial])
}
