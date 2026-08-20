import type { FC, ReactNode } from 'react'
import { t } from '@manyfold/i18n'
import { useLoadingGate } from '@/components/useLoadingGate'

// App boot (DESIGN.md §10.8) — the one wait with no chrome to keep real:
// auth resolving and the first route chunk landing, before any layout
// exists. A page skeleton would have to guess the incoming layout and
// guesses wrong for every surface, so boot makes no structural promise
// at all — the brand mark simply breathes until the app can render.
//
// The mark IS a folded strip, so the wait animates the fold: all four
// creases rock open 3.4° together and back, which keeps each panel's
// length fixed the way a real folding rule does. Points carry the whole
// motion (no scale — scaling would fatten the band), and the two fills
// stay on BrandMark's own tokens so the mark is the product's mark in
// both themes.
const FOLD_REST = [
    '10,80 35,15 47.5,15 22.5,80',
    '35,15 60,80 47.5,15 72.5,80',
    '60,80 85,15 72.5,80 97.5,15',
    '85,15 110,80 97.5,15 122.5,80'
]

const FOLD_OPEN = [
    '2.4,79.2 31.2,15.8 43.7,15.8 14.9,79.2',
    '31.2,15.8 60,79.2 43.7,15.8 72.5,79.2',
    '60,79.2 88.8,15.8 72.5,79.2 101.3,15.8',
    '88.8,15.8 117.6,79.2 101.3,15.8 130.1,79.2'
]

// Breath envelope: open for 45% of the period, hold, fold back, hold —
// the same "travel then rest a beat" rhythm the sheen band keeps, so
// boot reads as the same clock as every other loading primitive.
const BREATH_KEY_TIMES = '0;0.45;0.55;0.9;1'
const BREATH_SPLINES = '0.45 0 0.55 1;0 0 1 1;0.45 0 0.55 1;0 0 1 1'

// SMIL cannot read a CSS custom property, so this duration is the one
// place --sheen-period (2.4s) is duplicated. Change both together.
const BREATH_DUR = '2.4s'

const BootMark: FC = (): ReactNode => {
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    return (
        <svg
            className='text-fg w-[67px]'
            viewBox='0 0 135 100'
            aria-hidden='true'
            focusable='false'
        >
            {FOLD_REST.map((rest, panel) => (
                <polygon
                    key={rest}
                    points={rest}
                    fill={
                        panel % 2 ? 'rgb(var(--color-muted))' : 'currentColor'
                    }
                >
                    {!still && (
                        <animate
                            attributeName='points'
                            dur={BREATH_DUR}
                            repeatCount='indefinite'
                            calcMode='spline'
                            keyTimes={BREATH_KEY_TIMES}
                            keySplines={BREATH_SPLINES}
                            values={[
                                rest,
                                FOLD_OPEN[panel],
                                FOLD_OPEN[panel],
                                rest,
                                rest
                            ].join(';')}
                        />
                    )}
                </polygon>
            ))}
        </svg>
    )
}

// Gated like every other indicator: a boot that resolves inside 150ms
// (warm chunk, cached session) shows nothing at all.
const BootScreen: FC = (): ReactNode => {
    const gate = useLoadingGate(true)
    if (!gate.showLoading) return null
    return (
        <div
            role='status'
            aria-label={t('common.loading')}
            className='bg-main loading-fade-in flex min-h-dvh items-center justify-center'
        >
            <BootMark />
        </div>
    )
}

export default BootScreen
