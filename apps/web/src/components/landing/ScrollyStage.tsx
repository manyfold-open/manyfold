import type { FC, ReactNode } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useI18n } from '@/lib/i18n'
import { marketingLinkLanguage, marketingLinksFor } from '@/seo/marketingLinks'
import { ScrollyWorld, type WorldLayerRefs } from './ScrollyWorld'

/* Camera keyframes, one per scene, in the SVG's own coordinates. `k` is the
   zoom (`km` its narrow-viewport twin, where less of the world fits), focusY
   the point the camera centres on, and `op` the opacity of the five world
   layers in LAYER_ORDER. Everything between two scenes is interpolated. */
interface CameraKey {
    p: number
    k: number
    km: number
    focusY: number
    op: [number, number, number, number, number]
}

const CAMERA: CameraKey[] = [
    { p: 0, k: 1.02, km: 1.04, focusY: 527, op: [1, 1, 1, 1, 1] },
    { p: 0.25, k: 1.68, km: 2.3, focusY: 214, op: [1, 0.22, 0.14, 0.1, 0.1] },
    { p: 0.5, k: 1.68, km: 2.3, focusY: 518, op: [0.2, 0.5, 1, 0.3, 0.14] },
    { p: 0.75, k: 1.42, km: 2.05, focusY: 840, op: [0.1, 0.14, 0.25, 0.85, 1] },
    { p: 1, k: 1.02, km: 1.04, focusY: 527, op: [1, 1, 1, 1, 1] }
]

const SCENE_COUNT = CAMERA.length
const LAST = SCENE_COUNT - 1
// Scene n sits at n/LAST of the pinned range, so the camera keys above and
// the copy cards share one progress axis.
const IV = 1 / LAST
// How far into an interval a scroll has to travel before it commits to the
// next scene. Below it, the snap returns to where the reader started.
const COMMIT = 0.3
// Half-width of a card's fade window, as a fraction of the pinned range.
const CARD_FADE = 0.13

// The world's own centre, in its coordinates: the camera scales around this
// point and parks focusY on it. It tracks the viewBox, so both move together.
const WORLD_CX = 324
const WORLD_CY = 527

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

interface SceneItem {
    label: string
    body: string
}

interface Scene {
    eyebrow: string
    title: ReactNode
    lead: string
    items?: SceneItem[]
    withCta?: boolean
    hint?: string
}

export const ScrollyStage: FC<{ cta: ReactNode }> = ({ cta }): ReactNode => {
    const { t, language } = useI18n()
    const { pathname } = useLocation()
    const docsHref = marketingLinksFor(
        marketingLinkLanguage(pathname, language)
    ).docs

    const pinRef = useRef<HTMLDivElement>(null)
    const svgRef = useRef<SVGSVGElement>(null)
    const groupRef = useRef<SVGGElement>(null)
    const cardsRef = useRef<Array<HTMLDivElement | null>>([])
    const progressRef = useRef<HTMLDivElement>(null)
    const layers: WorldLayerRefs = {
        gA: useRef<SVGGElement>(null),
        gFeed: useRef<SVGGElement>(null),
        gB: useRef<SVGGElement>(null),
        gFlow: useRef<SVGGElement>(null),
        gC: useRef<SVGGElement>(null)
    }
    const [active, setActive] = useState(0)

    const item = (n: number, i: number): SceneItem => ({
        label: t(`web.landing.scene${n}Item${i}Label`),
        body: t(`web.landing.scene${n}Item${i}Body`)
    })

    const scenes: Scene[] = [
        {
            eyebrow: t('web.landing.heroEyebrow'),
            title: (
                <>
                    {t('web.landing.heroTitleBefore')}
                    <br />
                    {t('web.landing.heroTitleAfter')}{' '}
                    <span className='lp-h-accent'>
                        {t('web.landing.heroTitleAccent')}
                    </span>
                </>
            ),
            lead: t('web.landing.heroTagline'),
            withCta: true,
            hint: t('web.landing.sceneHeroHint')
        },
        {
            eyebrow: t('web.landing.scene1Eyebrow'),
            title: (
                <>
                    {t('web.landing.scene1Title')}{' '}
                    <span className='lp-h-accent'>
                        {t('web.landing.scene1TitleAccent')}
                    </span>
                </>
            ),
            lead: t('web.landing.scene1Lead'),
            items: [item(1, 1), item(1, 2), item(1, 3)]
        },
        {
            eyebrow: t('web.landing.scene2Eyebrow'),
            title: (
                <>
                    {t('web.landing.scene2Title')}{' '}
                    <span className='lp-h-accent'>
                        {t('web.landing.scene2TitleAccent')}
                    </span>
                </>
            ),
            lead: t('web.landing.scene2Lead'),
            items: [item(2, 1), item(2, 2), item(2, 3)]
        },
        {
            eyebrow: t('web.landing.scene3Eyebrow'),
            title: (
                <>
                    {t('web.landing.scene3Title')}{' '}
                    <span className='lp-h-accent'>
                        {t('web.landing.scene3TitleAccent')}
                    </span>
                </>
            ),
            lead: t('web.landing.scene3Lead'),
            items: [item(3, 1), item(3, 2), item(3, 3)]
        },
        {
            eyebrow: t('web.landing.scene4Eyebrow'),
            title: (
                <>
                    {t('web.landing.scene4Title')}{' '}
                    <span className='lp-h-accent'>
                        {t('web.landing.scene4TitleAccent')}
                    </span>
                </>
            ),
            lead: t('web.landing.scene4Lead'),
            withCta: true
        }
    ]

    const layerOrder = useMemo(
        () => [layers.gA, layers.gFeed, layers.gB, layers.gFlow, layers.gC],
        // The refs are stable for the component's lifetime.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        []
    )

    /* One scroll-linked loop drives the camera, the layer opacities and the
       card cross-fade straight on the DOM. Routing it through state would
       re-render the whole world (350+ SVG nodes) on every scroll frame. */
    useEffect(() => {
        const pin = pinRef.current
        const group = groupRef.current
        if (!pin || !group) return

        const narrow = matchMedia('(max-width: 900px)')
        const still = matchMedia('(prefers-reduced-motion: reduce)')
        let raf = 0
        let settled = 0
        let snapTimer: ReturnType<typeof setTimeout> | undefined

        const progress = (): number => {
            const span = pin.offsetHeight - innerHeight
            if (span <= 0) return 0
            return Math.min(
                1,
                Math.max(0, -pin.getBoundingClientRect().top / span)
            )
        }

        const draw = (): void => {
            raf = 0
            const p = progress()
            let i = 0
            while (i < CAMERA.length - 2 && p > CAMERA[i + 1].p) i++
            const a = CAMERA[i]
            const b = CAMERA[i + 1]
            const raw = (p - a.p) / (b.p - a.p)
            // easeInOutQuad, so the camera settles rather than arrives.
            const e =
                raw < 0.5 ? 2 * raw * raw : 1 - Math.pow(-2 * raw + 2, 2) / 2
            const k = lerp(
                narrow.matches ? a.km : a.k,
                narrow.matches ? b.km : b.k,
                e
            )
            const focus = lerp(a.focusY, b.focusY, e)
            const ty = -k * (focus - WORLD_CY)
            group.setAttribute(
                'transform',
                `translate(0 ${ty.toFixed(1)}) translate(${WORLD_CX} ${WORLD_CY}) scale(${k.toFixed(3)}) translate(${-WORLD_CX} ${-WORLD_CY})`
            )
            layerOrder.forEach((layer, li) => {
                const el = layer.current
                if (el)
                    el.style.opacity = lerp(a.op[li], b.op[li], e).toFixed(2)
            })

            let nearest = 0
            cardsRef.current.forEach((card, ci) => {
                const centre = ci * IV
                const distance = Math.abs(p - centre)
                if (distance < Math.abs(p - nearest * IV)) nearest = ci
                if (!card) return
                const o = Math.max(0, 1 - distance / CARD_FADE)
                card.style.opacity = o.toFixed(2)
                const base = narrow.matches ? '-46%' : '-50%'
                const drift = (p - centre) * (narrow.matches ? -110 : -240)
                card.style.transform = `translateY(calc(${base} + ${drift.toFixed(1)}px))`
                // Cards that have faded out keep their CTAs out of the tab
                // order, so nobody lands on a button they cannot see.
                if (o < 0.5) card.setAttribute('inert', '')
                else card.removeAttribute('inert')
            })
            setActive(nearest)

            // The dots belong to the pinned stage; they would otherwise hang
            // over every section below it.
            const dots = progressRef.current
            if (dots) {
                const rect = pin.getBoundingClientRect()
                const inStage = rect.top <= 0 && rect.bottom >= innerHeight
                dots.style.opacity = inStage ? '1' : '0'
            }
        }

        const schedule = (): void => {
            if (!raf) raf = requestAnimationFrame(draw)
        }

        /* Page-turn snapping: a short scroll inside a scene springs back, a
           committed one lands on the next scene. Without it the reader can
           park half-way between two scenes, where neither card is legible. */
        const snap = (): void => {
            const rect = pin.getBoundingClientRect()
            const span = pin.offsetHeight - innerHeight
            if (span <= 0) return
            const p = -rect.top / span
            if (rect.top > 1) {
                settled = 0
                return
            }
            if (-rect.top > span - 1) {
                settled = LAST
                return
            }
            const rel = (p - settled * IV) / IV
            let target = settled
            if (Math.abs(rel) >= 1) target = Math.round(p / IV)
            else if (rel >= COMMIT) target = settled + 1
            else if (rel <= -COMMIT) target = settled - 1
            settled = Math.max(0, Math.min(LAST, target))
            const dest = pin.offsetTop + settled * IV * span
            if (Math.abs(scrollY - dest) < 4) return
            scrollTo({
                top: dest,
                behavior: still.matches ? 'auto' : 'smooth'
            })
        }

        const onScroll = (): void => {
            schedule()
            clearTimeout(snapTimer)
            snapTimer = setTimeout(snap, 150)
        }

        const onResize = (): void => {
            schedule()
        }

        draw()
        addEventListener('scroll', onScroll, { passive: true })
        addEventListener('resize', onResize)
        narrow.addEventListener('change', onResize)
        return () => {
            removeEventListener('scroll', onScroll)
            removeEventListener('resize', onResize)
            narrow.removeEventListener('change', onResize)
            clearTimeout(snapTimer)
            if (raf) cancelAnimationFrame(raf)
        }
    }, [layerOrder])

    return (
        <div className='lp-pin' ref={pinRef}>
            <div className='lp-stage'>
                <div className='lp-stage-inner'>
                    <div className='lp-rail'>
                        {scenes.map((scene, index) => {
                            const Heading = index === 0 ? 'h1' : 'h2'
                            return (
                                <div
                                    key={scene.eyebrow}
                                    className='lp-scene'
                                    ref={(el) => {
                                        cardsRef.current[index] = el
                                    }}
                                >
                                    <div className='lp-scene-eyebrow'>
                                        {scene.eyebrow}
                                    </div>
                                    <Heading className='lp-scene-title'>
                                        {scene.title}
                                    </Heading>
                                    <p className='lp-scene-lead'>
                                        {scene.lead}
                                    </p>
                                    {scene.items ? (
                                        <ul className='lp-scene-list'>
                                            {scene.items.map((entry) => (
                                                <li key={entry.label}>
                                                    <b>{entry.label}</b> ·{' '}
                                                    {entry.body}
                                                </li>
                                            ))}
                                        </ul>
                                    ) : null}
                                    {scene.withCta ? (
                                        <div className='lp-scene-ctas'>
                                            {cta}
                                            <a
                                                className='lp-btn lp-btn-secondary'
                                                href={docsHref}
                                            >
                                                {t(
                                                    'web.landing.ctaSecondaryCta'
                                                )}
                                            </a>
                                        </div>
                                    ) : null}
                                    {scene.hint ? (
                                        <div className='lp-scene-hint'>
                                            {scene.hint}
                                        </div>
                                    ) : null}
                                </div>
                            )
                        })}
                    </div>
                    <div className='lp-world-col'>
                        <ScrollyWorld
                            svgRef={svgRef}
                            groupRef={groupRef}
                            layers={layers}
                        />
                    </div>
                </div>
            </div>
            <div className='lp-progress' aria-hidden='true' ref={progressRef}>
                {scenes.map((scene, index) => (
                    <span
                        key={scene.eyebrow}
                        className={
                            index === active ? 'lp-pdot lp-on' : 'lp-pdot'
                        }
                    />
                ))}
            </div>
        </div>
    )
}
