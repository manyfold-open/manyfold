import assert from 'node:assert/strict'
import test from 'node:test'
import { createTextSmoother } from '../src/lib/textSmoother'

type RafGlobals = Omit<
    typeof globalThis,
    'requestAnimationFrame' | 'cancelAnimationFrame'
> & {
    requestAnimationFrame?: (cb: (t: number) => void) => number
    cancelAnimationFrame?: (id: number) => void
}

const g = globalThis as RafGlobals

const installFakeRaf = (): {
    frames: Array<(t: number) => void>
    step: (maxFrames: number) => void
    restore: () => void
} => {
    const frames: Array<(t: number) => void> = []
    const prevRaf = g.requestAnimationFrame
    const prevCancel = g.cancelAnimationFrame
    const prevNow = performance.now
    let clock = 0
    g.requestAnimationFrame = (cb): number => {
        frames.push(cb)
        return frames.length
    }
    g.cancelAnimationFrame = (): void => {
        frames.length = 0
    }
    performance.now = (): number => clock
    const step = (maxFrames: number): void => {
        for (let i = 0; i < maxFrames && frames.length > 0; i += 1) {
            const cb = frames.shift()
            clock += 16
            cb?.(clock)
        }
    }
    const restore = (): void => {
        g.requestAnimationFrame = prevRaf
        g.cancelAnimationFrame = prevCancel
        performance.now = prevNow
    }
    return { frames, step, restore }
}

test('reveals text immediately when no animation frame is available', () => {
    // node has no requestAnimationFrame, so the smoother degrades to a
    // synchronous pass-through — this is what keeps SSR and the store tests
    // behaving exactly as they did before smoothing existed.
    const revealed: string[] = []
    const smoother = createTextSmoother((delta) => revealed.push(delta))
    smoother.push('hello world')
    assert.deepEqual(revealed, ['hello world'])
    smoother.flush()
    smoother.reset()
    assert.deepEqual(revealed, ['hello world'])
})

test('drains queued text in order with nothing lost across frames', () => {
    const raf = installFakeRaf()
    try {
        const revealed: string[] = []
        const smoother = createTextSmoother((delta) => revealed.push(delta))
        smoother.push('Hello, streaming world!')
        assert.equal(revealed.join(''), '', 'nothing reveals before a frame')

        raf.step(2000)

        assert.equal(
            revealed.join(''),
            'Hello, streaming world!',
            'every character is revealed once, in order'
        )
        assert.equal(raf.frames.length, 0, 'loop stops once the queue drains')
    } finally {
        raf.restore()
    }
})

test('flush reveals the remaining buffer synchronously and stops the loop', () => {
    const raf = installFakeRaf()
    try {
        const revealed: string[] = []
        const smoother = createTextSmoother((delta) => revealed.push(delta))
        smoother.push('abcdef')
        smoother.flush()
        assert.equal(revealed.join(''), 'abcdef')
        assert.equal(raf.frames.length, 0)
    } finally {
        raf.restore()
    }
})

test('reset drops buffered text without revealing it', () => {
    const raf = installFakeRaf()
    try {
        const revealed: string[] = []
        const smoother = createTextSmoother((delta) => revealed.push(delta))
        smoother.push('discard me')
        smoother.reset()
        raf.step(50)
        assert.equal(revealed.join(''), '')
    } finally {
        raf.restore()
    }
})
