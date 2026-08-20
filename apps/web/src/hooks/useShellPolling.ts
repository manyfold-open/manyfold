import { useEffect } from 'react'
import { createPollController } from '@/lib/shellPolling'

interface UseShellPollingOptions {
    minSpacingMs?: number
}

export const useShellPolling = (
    task: () => Promise<unknown> | unknown,
    intervalMs: number,
    options?: UseShellPollingOptions
): void => {
    const minSpacingMs = options?.minSpacingMs
    useEffect(() => {
        const controller = createPollController({
            task,
            intervalMs,
            minSpacingMs,
            isVisible: () => document.visibilityState === 'visible'
        })
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
        }
    }, [task, intervalMs, minSpacingMs])
}
