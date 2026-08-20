export interface StreamHandle {
    close: () => void
}

export interface StreamLifecycle {
    onOpen: () => void
    onDown: () => void
}

export interface ReconnectingStreamOptions {
    connect: (lifecycle: StreamLifecycle) => StreamHandle
    onReconnected?: () => void
    isVisible?: () => boolean
    initialBackoffMs?: number
    maxBackoffMs?: number
    stableConnectionMs?: number
    random?: () => number
    now?: () => number
}

export interface ReconnectingStream {
    start: () => void
    dispose: () => void
    notifyOnline: () => void
    notifyVisible: () => void
}

const DEFAULT_INITIAL_BACKOFF_MS = 1_000
const DEFAULT_MAX_BACKOFF_MS = 30_000
const DEFAULT_STABLE_CONNECTION_MS = 10_000

export const createReconnectingStream = (
    options: ReconnectingStreamOptions
): ReconnectingStream => {
    const { connect, onReconnected } = options
    const isVisible = options.isVisible ?? ((): boolean => true)
    const initialBackoffMs =
        options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS
    const maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS
    const stableConnectionMs =
        options.stableConnectionMs ?? DEFAULT_STABLE_CONNECTION_MS
    const random = options.random ?? Math.random
    const now = options.now ?? Date.now

    let disposed = false
    let started = false
    let generation = 0
    let handle: StreamHandle | null = null
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let deferredUntilVisible = false
    let backoffMs = initialBackoffMs
    let openedAt: number | null = null
    let hadDrop = false

    const clearRetryTimer = (): void => {
        if (retryTimer === null) return
        clearTimeout(retryTimer)
        retryTimer = null
    }

    const open = (): void => {
        if (disposed) return
        // Close any existing handle before opening a replacement.
        // Critical when onDown fires from an in-stream parse error:
        // the old read loop may still be alive because the SDK's
        // dispatchSpriteStatusFrame calls onError then continues.
        handle?.close()
        handle = null
        const gen = ++generation
        openedAt = null
        handle = connect({
            onOpen: (): void => {
                if (disposed || gen !== generation) return
                openedAt = now()
                if (hadDrop) onReconnected?.()
            },
            onDown: (): void => {
                if (disposed || gen !== generation) return
                generation++
                hadDrop = true
                const wasStable =
                    openedAt !== null && now() - openedAt >= stableConnectionMs
                openedAt = null
                if (wasStable) backoffMs = initialBackoffMs
                scheduleReconnect()
            }
        })
    }

    const scheduleReconnect = (): void => {
        if (disposed || retryTimer !== null) return
        const jitter = 0.8 + random() * 0.4
        const delay = Math.round(backoffMs * jitter)
        backoffMs = Math.min(backoffMs * 2, maxBackoffMs)
        retryTimer = setTimeout(() => {
            retryTimer = null
            if (disposed) return
            if (!isVisible()) {
                deferredUntilVisible = true
                return
            }
            open()
        }, delay)
    }

    return {
        start: (): void => {
            if (started || disposed) return
            started = true
            open()
        },
        dispose: (): void => {
            if (disposed) return
            disposed = true
            generation++
            clearRetryTimer()
            handle?.close()
            handle = null
        },
        notifyOnline: (): void => {
            if (disposed || !started || retryTimer === null) return
            clearRetryTimer()
            backoffMs = initialBackoffMs
            if (!isVisible()) {
                deferredUntilVisible = true
                return
            }
            open()
        },
        notifyVisible: (): void => {
            if (disposed || !started || !deferredUntilVisible) return
            deferredUntilVisible = false
            open()
        }
    }
}
