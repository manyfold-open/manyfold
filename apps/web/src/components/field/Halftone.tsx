import type { FC, ReactNode } from 'react'
import { useEffect, useRef } from 'react'
import { cloudAt, LOOP_MS } from '@/components/field/fields'

/* The atmosphere only needs to breathe, not to animate. 8fps also keeps a
   full-width canvas repaint off the critical path. */
const FPS = 8

/* Square dots, aligned to whole pixels. A diamond reads as a gem; the lattice
   law (§3.4 L1) wants it to read as a pixel. */
const PITCH = 13
const MAX_DOT = 5.4

interface Config {
    /* Which edge the field is dense at; it decays to nothing on the content
       side, because body copy may never sit on cells above α 0.06 (§3.4 L5). */
    edge: 'top' | 'bottom'
    alpha: number
    gamma: number
    speed: number
}

const CONFIG: Record<'top' | 'bottom', Config> = {
    top: { edge: 'top', alpha: 0.66, gamma: 1.3, speed: 1 },
    bottom: { edge: 'bottom', alpha: 0.54, gamma: 1.4, speed: -1 }
}

export interface HalftoneProps {
    edge?: 'top' | 'bottom'
    /* Space-separated rgb triple, e.g. '53 96 235' — same convention as the
       product's --color-* tokens. Defaults to the landing field ink. */
    ink?: string
    className?: string
}

export const Halftone: FC<HalftoneProps> = ({
    edge = 'top',
    ink,
    className
}): ReactNode => {
    const ref = useRef<HTMLCanvasElement | null>(null)

    useEffect(() => {
        const canvas = ref.current
        if (!canvas) return
        const cfg = CONFIG[edge]

        const paint = (t: number): void => {
            const box = canvas.getBoundingClientRect()
            const w = Math.max(1, Math.round(box.width))
            const h = Math.max(1, Math.round(box.height))
            const dpr = Math.min(2, window.devicePixelRatio || 1)
            /* Never write the measured size back as an inline style: that
                locks the canvas at whatever width it had on first paint and
                it stops being responsive. */
            if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
                canvas.width = w * dpr
                canvas.height = h * dpr
            }
            const g = canvas.getContext('2d')
            if (!g) return
            g.setTransform(dpr, 0, 0, dpr, 0, 0)
            g.clearRect(0, 0, w, h)
            const rgb =
                ink ||
                getComputedStyle(canvas)
                    .getPropertyValue('--lp-field')
                    .trim() ||
                '53 96 235'
            for (let y = PITCH / 2; y < h; y += PITCH) {
                const towardEdge = cfg.edge === 'top' ? 1 - y / h : y / h
                const fall = Math.pow(Math.max(0, towardEdge), cfg.gamma)
                if (fall <= 0.002) continue
                for (let x = PITCH / 2; x < w; x += PITCH) {
                    /* x is normalised by viewport width so the harmonics stay
                        integer and the band tiles horizontally. */
                    const cloud = cloudAt(x / w, y / h, t * cfg.speed)
                    const density =
                        fall *
                        (0.12 +
                            0.88 *
                                Math.min(1, Math.max(0, (cloud + 0.3) / 0.64)))
                    const a = Math.round(density * cfg.alpha * 8) / 8
                    if (a <= 0) continue
                    const size = Math.max(
                        1,
                        Math.round(MAX_DOT * (0.26 + 0.74 * density))
                    )
                    g.fillStyle = `rgb(${rgb} / ${a.toFixed(3)})`
                    g.fillRect(
                        Math.round(x - size / 2),
                        Math.round(y - size / 2),
                        size,
                        size
                    )
                }
            }
        }

        paint(0)

        const motion = matchMedia('(prefers-reduced-motion: reduce)')
        let raf = 0
        let last = 0
        let running = false

        const tick = (now: number): void => {
            raf = requestAnimationFrame(tick)
            if (now - last < 1000 / FPS) return
            last = now
            paint((now % LOOP_MS) / LOOP_MS)
        }
        const start = (): void => {
            if (running || motion.matches) return
            running = true
            raf = requestAnimationFrame(tick)
        }
        const stop = (): void => {
            if (raf) cancelAnimationFrame(raf)
            raf = 0
            running = false
        }

        const observer =
            typeof IntersectionObserver === 'undefined'
                ? null
                : new IntersectionObserver(
                      (entries) => {
                          if (entries.some((e) => e.isIntersecting)) start()
                          else stop()
                      },
                      { rootMargin: '160px' }
                  )
        if (observer) observer.observe(canvas)
        else start()

        const onResize = (): void => paint(0)
        window.addEventListener('resize', onResize)
        motion.addEventListener('change', stop)
        return () => {
            window.removeEventListener('resize', onResize)
            motion.removeEventListener('change', stop)
            observer?.disconnect()
            stop()
        }
    }, [edge, ink])

    return (
        <canvas
            ref={ref}
            className={className ? `lp-halftone ${className}` : 'lp-halftone'}
            aria-hidden='true'
        />
    )
}
