type RevealFn = (delta: string) => void

export interface TextSmoother {
    push: (text: string) => void
    flush: () => void
    reset: () => void
}

const START_SPEED = 10

const smoothingAvailable = (): boolean =>
    typeof requestAnimationFrame === 'function' &&
    typeof cancelAnimationFrame === 'function' &&
    typeof performance !== 'undefined' &&
    typeof performance.now === 'function'

const prefersReducedMotion = (): boolean => {
    try {
        return (
            globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')
                .matches === true
        )
    } catch {
        return false
    }
}

const createPassthrough = (reveal: RevealFn): TextSmoother => ({
    push: (text: string): void => {
        if (text) reveal(text)
    },
    flush: (): void => {},
    reset: (): void => {}
})

// Frame-paced typewriter: incoming chunks are split into code points and
// drained on requestAnimationFrame at a speed that eases toward the backlog
// depth, so bursty network frames render as smooth, even text. Decouples the
// visible cadence from SSE jitter without touching the stream reducer.
export const createTextSmoother = (reveal: RevealFn): TextSmoother => {
    if (!smoothingAvailable() || prefersReducedMotion())
        return createPassthrough(reveal)

    const queue: string[] = []
    let rafId: number | null = null
    let lastFrame = 0
    let carryMs = 0
    let speed = START_SPEED
    let lastQueueLength = 0

    const stop = (): void => {
        if (rafId === null) return
        cancelAnimationFrame(rafId)
        rafId = null
    }

    const tick = (now: number): void => {
        carryMs += now - lastFrame
        lastFrame = now

        let count = 0
        if (queue.length > 0) {
            const target = Math.max(START_SPEED, queue.length)
            const rate =
                Math.abs(queue.length - lastQueueLength) * 0.0008 + 0.005
            speed += (target - speed) * rate
            count = Math.floor((carryMs * speed) / 1000)
        }

        if (count > 0) {
            const take = Math.min(count, queue.length)
            carryMs -= (take * 1000) / speed
            reveal(queue.splice(0, take).join(''))
        }

        lastQueueLength = queue.length
        rafId = queue.length > 0 ? requestAnimationFrame(tick) : null
    }

    const start = (): void => {
        if (rafId !== null) return
        lastFrame = performance.now()
        carryMs = 0
        rafId = requestAnimationFrame(tick)
    }

    return {
        push: (text: string): void => {
            if (!text) return
            for (const char of text) queue.push(char)
            start()
        },
        flush: (): void => {
            stop()
            if (queue.length > 0) reveal(queue.splice(0).join(''))
            carryMs = 0
            speed = START_SPEED
            lastQueueLength = 0
        },
        reset: (): void => {
            stop()
            queue.length = 0
            carryMs = 0
            speed = START_SPEED
            lastQueueLength = 0
        }
    }
}
