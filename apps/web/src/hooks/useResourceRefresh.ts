import { useEffect } from 'react'
import type { ResourceChangedEvent } from '@manyfold/shared'
import {
    createResourceRefresh,
    subscribeResourceChanges
} from '@/lib/resourceChanges'

export const useResourceRefresh = (
    resource: ResourceChangedEvent['resource'],
    resourceId: string | undefined,
    refresh: () => Promise<unknown>
): void => {
    useEffect(() => {
        const queue = createResourceRefresh(refresh)
        const visibleRefresh = (): void => {
            if (document.visibilityState === 'visible') queue.request()
        }
        const unsubscribe = subscribeResourceChanges((event) => {
            if (event.resource !== resource) return
            if (
                resourceId &&
                event.resourceId &&
                event.resourceId !== resourceId
            )
                return
            visibleRefresh()
        })
        queue.request()
        // NOTIFY is best-effort. Reconnect/focus plus a slow refresh converge
        // even if a notification was lost while the SSE transport stayed up.
        const timer = window.setInterval(visibleRefresh, 60_000)
        window.addEventListener('focus', visibleRefresh)
        window.addEventListener('online', visibleRefresh)
        document.addEventListener('visibilitychange', visibleRefresh)
        return () => {
            queue.dispose()
            unsubscribe()
            window.clearInterval(timer)
            window.removeEventListener('focus', visibleRefresh)
            window.removeEventListener('online', visibleRefresh)
            document.removeEventListener('visibilitychange', visibleRefresh)
        }
    }, [refresh, resource, resourceId])
}
