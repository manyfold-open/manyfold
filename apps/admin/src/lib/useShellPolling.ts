import { useCallback, useEffect, useRef } from 'react'
import { createPollController, type PollController } from '@/lib/shellPolling'

interface UseShellPollingOptions {
    minSpacingMs?: number
}

export const useShellPolling = (
    task: () => Promise<unknown> | unknown,
    intervalMs: number,
    options?: UseShellPollingOptions
): (() => void) => {
    const minSpacingMs = options?.minSpacingMs
    const controllerRef = useRef<PollController | null>(null)
    useEffect(() => {
        const controller = createPollController({
            task,
            intervalMs,
            minSpacingMs,
            isVisible: () => document.visibilityState === 'visible'
        })
        controllerRef.current = controller
        controller.start()
        const handleVisibilityChange = (): void =>
            controller.handleVisibilityChange()
        const handleKick = (): void => controller.kick()
        document.addEventListener('visibilitychange', handleVisibilityChange)
        window.addEventListener('focus', handleKick)
        window.addEventListener('online', handleKick)
        return () => {
            document.removeEventListener(
                'visibilitychange',
                handleVisibilityChange
            )
            window.removeEventListener('focus', handleKick)
            window.removeEventListener('online', handleKick)
            controller.stop()
            if (controllerRef.current === controller)
                controllerRef.current = null
        }
    }, [task, intervalMs, minSpacingMs])
    return useCallback(() => {
        controllerRef.current?.refresh()
    }, [])
}
