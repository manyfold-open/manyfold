export interface PollControllerOptions {
    task: () => Promise<unknown> | unknown
    intervalMs: number
    minSpacingMs?: number
    isVisible: () => boolean
    now?: () => number
}

export interface PollController {
    start: () => void
    stop: () => void
    handleVisibilityChange: () => void
    kick: () => void
}

const DEFAULT_MIN_SPACING_MS = 5_000

export const createPollController = (
    options: PollControllerOptions
): PollController => {
    const { task, intervalMs, isVisible } = options
    const minSpacingMs = options.minSpacingMs ?? DEFAULT_MIN_SPACING_MS
    const now = options.now ?? Date.now
    let active = false
    let running = false
    let timer: ReturnType<typeof setInterval> | null = null
    let lastRunStartedAt = -Infinity

    const run = async (): Promise<void> => {
        if (running) return
        running = true
        lastRunStartedAt = now()
        try {
            await task()
        } catch {
            /* task owns its errors; polling must survive */
        } finally {
            running = false
        }
    }

    const clearTimer = (): void => {
        if (timer === null) return
        clearInterval(timer)
        timer = null
    }

    const scheduleTimer = (): void => {
        clearTimer()
        timer = setInterval(() => {
            if (!isVisible()) return
            void run()
        }, intervalMs)
    }

    const runNowAndReschedule = (): void => {
        if (now() - lastRunStartedAt < minSpacingMs) {
            if (timer === null) scheduleTimer()
            return
        }
        void run()
        scheduleTimer()
    }

    return {
        start: (): void => {
            if (active) return
            active = true
            if (!isVisible()) return
            void run()
            scheduleTimer()
        },
        stop: (): void => {
            active = false
            clearTimer()
        },
        handleVisibilityChange: (): void => {
            if (!active) return
            if (isVisible()) runNowAndReschedule()
            else clearTimer()
        },
        kick: (): void => {
            if (!active || !isVisible()) return
            runNowAndReschedule()
        }
    }
}
