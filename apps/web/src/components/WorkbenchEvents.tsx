import { useEffect } from 'react'
import { useApiClient } from '@/lib/apiClient'
import { publishResourceChanged } from '@/lib/resourceChanges'
import { createReconnectingStream } from '@/lib/spriteStatusStream'
import { dispatchWorkbenchEvents } from '@/lib/workbenchEvents'

// Mounted by the authenticated route, including settings and customization
// layouts. All views in a tab share this connection.
export const WorkbenchEvents = (): null => {
    const client = useApiClient()
    useEffect(() => {
        const stream = createReconnectingStream({
            connect: ({ onOpen, onDown }) =>
                client.agents.streamSpriteStatus({
                    onOpen: () => {
                        onOpen()
                    },
                    onResourceChanged: publishResourceChanged,
                    onSnapshot: (value) => {
                        publishResourceChanged({ resource: '*' })
                        dispatchWorkbenchEvents((h) => h.onSnapshot?.(value))
                    },
                    onUpdate: (value) =>
                        dispatchWorkbenchEvents((h) => h.onUpdate?.(value)),
                    onHostUpdate: (value) =>
                        dispatchWorkbenchEvents((h) => h.onHostUpdate?.(value)),
                    onSessionsChanged: (value) =>
                        dispatchWorkbenchEvents((h) =>
                            h.onSessionsChanged?.(value)
                        ),
                    onQuotaWarning: (value) =>
                        dispatchWorkbenchEvents((h) =>
                            h.onQuotaWarning?.(value)
                        ),
                    onError: onDown,
                    onClose: onDown
                }),
            onReconnected: () =>
                dispatchWorkbenchEvents((h) => h.onReconnected?.()),
            isVisible: () => document.visibilityState === 'visible'
        })
        stream.start()
        const online = (): void => stream.notifyOnline()
        const visible = (): void => {
            if (document.visibilityState === 'visible') stream.notifyVisible()
        }
        window.addEventListener('online', online)
        document.addEventListener('visibilitychange', visible)
        return () => {
            stream.dispose()
            window.removeEventListener('online', online)
            document.removeEventListener('visibilitychange', visible)
        }
    }, [client])
    return null
}
