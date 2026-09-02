import type { FC, ReactNode } from 'react'
import { useEffect, useRef } from 'react'
import {
    LOOP_MS,
    renderPlates,
    type FieldShape,
    type InkRamp
} from '@/components/field/fields'

/* 20fps, not 60. ASCII is a mechanical medium — past ~24fps it stops reading
   as a teletype resolving an image and starts reading as video (§3.4 L6). */
const FPS = 20

type Painter = (t: number) => void

/* One requestAnimationFrame for the whole page. A landing with a dozen fields
   each running its own loop burns CPU for no visual gain, and the shared
   clock is also what keeps every field on the same 12s phase. The loop stops
   completely once nothing is subscribed. */
const painters = new Set<Painter>()
let rafId = 0
let lastPaint = 0

const tick = (now: number): void => {
    rafId = requestAnimationFrame(tick)
    if (now - lastPaint < 1000 / FPS) return
    lastPaint = now
    const t = (now % LOOP_MS) / LOOP_MS
    for (const paint of painters) paint(t)
}

const subscribe = (paint: Painter): (() => void) => {
    painters.add(paint)
    if (!rafId) rafId = requestAnimationFrame(tick)
    return () => {
        painters.delete(paint)
        if (painters.size === 0 && rafId) {
            cancelAnimationFrame(rafId)
            rafId = 0
        }
    }
}

export interface AsciiFieldProps {
    shape: FieldShape
    ramp?: InkRamp
    /* Grid size in cells, not pixels. Drop these before dropping ink levels
       when a field costs too much. */
    cols: number
    rows: number
    mask?: 'radial' | 'band' | 'none'
    /* Loading state: the field develops from sparse to full instead of
       spinning. */
    develop?: boolean
    className?: string
}

export const AsciiField: FC<AsciiFieldProps> = ({
    shape,
    ramp = 'binary',
    cols,
    rows,
    mask = 'radial',
    develop = false,
    className
}): ReactNode => {
    const host = useRef<HTMLDivElement | null>(null)
    const light = useRef<HTMLPreElement | null>(null)
    const mid = useRef<HTMLPreElement | null>(null)
    const deep = useRef<HTMLPreElement | null>(null)

    useEffect(() => {
        const node = host.current
        if (!node || !light.current || !mid.current || !deep.current) return

        const paint = (t: number): void => {
            const [a, b, c] = renderPlates({
                shape,
                ramp,
                cols,
                rows,
                t,
                develop
            })
            /* Three textContent writes per frame, no per-cell nodes. This is
               the whole reason the field can animate at all. */
            if (light.current) light.current.textContent = a
            if (mid.current) mid.current.textContent = b
            if (deep.current) deep.current.textContent = c
        }

        paint(0)

        const motion = matchMedia('(prefers-reduced-motion: reduce)')
        let unsubscribe: (() => void) | null = null
        let observer: IntersectionObserver | null = null

        const stop = (): void => {
            observer?.disconnect()
            observer = null
            unsubscribe?.()
            unsubscribe = null
        }

        const start = (): void => {
            if (motion.matches) {
                /* Reduced motion holds the first frame — it does not slow the
                   loop down. */
                paint(0)
                return
            }
            if (typeof IntersectionObserver === 'undefined') {
                unsubscribe = subscribe(paint)
                return
            }
            observer = new IntersectionObserver(
                (entries) => {
                    const visible = entries.some((e) => e.isIntersecting)
                    if (visible && !unsubscribe) {
                        unsubscribe = subscribe(paint)
                    } else if (!visible && unsubscribe) {
                        unsubscribe()
                        unsubscribe = null
                    }
                },
                { rootMargin: '160px' }
            )
            observer.observe(node)
        }

        const restart = (): void => {
            stop()
            start()
        }

        start()
        motion.addEventListener('change', restart)
        return () => {
            motion.removeEventListener('change', restart)
            stop()
        }
    }, [shape, ramp, cols, rows, develop])

    return (
        <div
            ref={host}
            className={className ? `lp-field ${className}` : 'lp-field'}
            data-mask={mask}
            aria-hidden='true'
        >
            <pre ref={light} data-ink='1' />
            <pre ref={mid} data-ink='2' />
            <pre ref={deep} data-ink='3' />
        </div>
    )
}
