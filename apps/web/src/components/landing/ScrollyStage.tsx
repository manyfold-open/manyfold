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
    /* Where the camera centres. `focusX` is each plane's own centre, labels
       included — the planes do not share the world's, and at any zoom above 1
       that difference is magnified into a plane sitting off to one side. */
    focusX: number
    focusY: number
    op: [number, number, number, number, number]
}

/* `km` is the narrow twin of `k`. In portrait the art band is only as wide as
   the phone, and a plane plus its leader captions is about 240px across at
   rest, so anything past ~1.45 pushes the plane's own edges and its labels off
   both sides. The desktop `k` can be bolder: that column has width to spare. */
const CAMERA: CameraKey[] = [
    { p: 0, k: 1.02, km: 1.04, focusX: 388, focusY: 527, op: [1, 1, 1, 1, 1] },
    {
        p: 0.25,
        k: 1.68,
        km: 1.45,
        focusX: 346,
        focusY: 214,
        op: [1, 0.22, 0.14, 0.1, 0.1]
    },
    {
        p: 0.5,
        k: 1.68,
        km: 1.45,
        focusX: 368,
        focusY: 518,
        op: [0.2, 0.5, 1, 0.3, 0.14]
    },
    {
        p: 0.75,
        k: 1.42,
        km: 1.35,
        focusX: 359,
        focusY: 840,
        op: [0.1, 0.14, 0.25, 0.85, 1]
    },
    { p: 1, k: 1.02, km: 1.04, focusX: 388, focusY: 527, op: [1, 1, 1, 1, 1] }
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
const WORLD_CX = 388
const WORLD_CY = 527

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

/* The faces that make up a solid. Surface detail — bars, screens, sockets —
   is deliberately absent: those are markings on a face, not sides of a body,
   and they keep whatever stroke they were authored with. */
const SOLID_FACES = new Set([
    'var(--lp-w-box-top)',
    'var(--lp-w-box-l)',
    'var(--lp-w-box-r)',
    'var(--lp-w-box-accent)',
    'var(--lp-w-slab-l)',
    'var(--lp-w-slab-r)',
    'url(#lp-slabTop)'
])
const SLAB_FACES = new Set([
    'var(--lp-w-slab-l)',
    'var(--lp-w-slab-r)',
    'url(#lp-slabTop)'
])

const polygonOf = (d: string): Array<[number, number]> | null => {
    const cmds = d.trim().match(/[MLZmlz][^MLZmlz]*/g)
    if (!cmds || !/^[Zz]/.test(cmds[cmds.length - 1])) return null
    const pts: Array<[number, number]> = []
    for (const c of cmds) {
        const head = c[0].toUpperCase()
        if (head === 'Z') continue
        if (head !== 'M' && head !== 'L') return null
        const n = c.slice(1).match(/[-+]?\d*\.?\d+/g)
        if (!n || n.length !== 2) return null
        pts.push([Number(n[0]), Number(n[1])])
    }
    return pts.length >= 3 ? pts : null
}

/* Outline each solid along its silhouette only.
   A face-by-face stroke draws every seam between the top and the sides, which
   turns a clean body into a wireframe. The silhouette is exactly the set of
   edges that belong to one face only: an edge shared by two faces of the same
   solid is interior, so it drops out. Faces sharing an edge are, by the same
   token, the definition of "same solid", so the grouping comes free — no
   reliance on document order.
   The result is emitted as loose segments rather than a closed loop; with
   round caps the corners close on their own, and no ordering pass is needed. */
const outlineSolids = (svg: SVGSVGElement): void => {
    type Face = {
        el: SVGPathElement
        pts: Array<[number, number]>
        slab: boolean
    }
    const faces: Face[] = []
    svg.querySelectorAll<SVGPathElement>('path[d]').forEach((el) => {
        const fill = el.getAttribute('fill') ?? ''
        if (!SOLID_FACES.has(fill)) return
        const pts = polygonOf(el.getAttribute('d') ?? '')
        if (!pts) return
        el.setAttribute('stroke', 'none')
        faces.push({ el, pts, slab: SLAB_FACES.has(fill) })
    })
    if (!faces.length) return

    const key = (a: [number, number], b: [number, number]): string => {
        const f = (p: [number, number]): string =>
            `${p[0].toFixed(1)},${p[1].toFixed(1)}`
        const [x, y] = [f(a), f(b)]
        return x < y ? `${x}|${y}` : `${y}|${x}`
    }
    const owners = new Map<string, number[]>()
    const edges: Array<Array<[string, [number, number], [number, number]]>> =
        faces.map(() => [])
    faces.forEach((face, i) => {
        face.pts.forEach((p, j) => {
            const q = face.pts[(j + 1) % face.pts.length]
            const k = key(p, q)
            edges[i].push([k, p, q])
            const list = owners.get(k)
            if (list) list.push(i)
            else owners.set(k, [i])
        })
    })

    // Union-find over "shares an edge", so each body finds its own faces.
    const parent = faces.map((_, i) => i)
    const find = (i: number): number => {
        while (parent[i] !== i) {
            parent[i] = parent[parent[i]]
            i = parent[i]
        }
        return i
    }
    owners.forEach((list) => {
        for (let n = 1; n < list.length; n++) {
            const a = find(list[0])
            const b = find(list[n])
            if (a !== b) parent[b] = a
        }
    })

    const bodies = new Map<number, number[]>()
    faces.forEach((_, i) => {
        const root = find(i)
        const list = bodies.get(root)
        if (list) list.push(i)
        else bodies.set(root, [i])
    })

    const NS = 'http://www.w3.org/2000/svg'
    bodies.forEach((members) => {
        let d = ''
        members.forEach((i) => {
            edges[i].forEach(([k, p, q]) => {
                if ((owners.get(k)?.length ?? 0) > 1) return
                d += `M${p[0]} ${p[1]}L${q[0]} ${q[1]}`
            })
        })
        if (!d) return
        const last = faces[members[members.length - 1]].el
        const outline = document.createElementNS(NS, 'path')
        outline.setAttribute('d', d)
        outline.setAttribute('fill', 'none')
        outline.setAttribute(
            'stroke',
            faces[members[0]].slab
                ? 'var(--lp-w-slab-edge)'
                : 'var(--lp-w-box-edge)'
        )
        outline.setAttribute('stroke-width', faces[members[0]].slab ? '1' : '0.9')
        outline.setAttribute('stroke-linecap', 'round')
        outline.setAttribute('data-outline', '')
        last.parentNode?.insertBefore(outline, last.nextSibling)
    })
}

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
        []
    )

    /* Outline pass. The subtree is rebuilt when the language changes, hence
       the dependency; the guard keeps a re-run from stacking outlines. */
    useEffect(() => {
        const svg = svgRef.current
        if (!svg || svg.querySelector('[data-outline]')) return
        outlineSolids(svg)
    }, [language, svgRef])

    /* One scroll-linked loop drives the camera, the layer opacities and the
       card cross-fade straight on the DOM. Routing it through state would
       re-render the whole world (350+ SVG nodes) on every scroll frame. */
    useEffect(() => {
        const pin = pinRef.current
        const group = groupRef.current
        if (!pin || !group) return
        /* Each plane's annotations exist only while the camera is on that
           plane: fully on within a small window around the scene's centre,
           dissolving on the way in and out, absent from the overview at both
           ends. Element identity survives language changes (React swaps only
           the text nodes), so collecting once here is safe. */
        const NOTES: Array<[SVGGElement | null, number]> = [
            ['a', 0.25],
            ['b', 0.5],
            ['c', 0.75]
        ].map(([key, centre]) => [
            svgRef.current?.querySelector<SVGGElement>(
                `[data-notes='${key}']`
            ) ?? null,
            centre as number
        ])
        const TITLES: Array<[SVGGElement | null, number]> = [
            ['a', 0.25],
            ['b', 0.5],
            ['c', 0.75]
        ].map(([key, centre]) => [
            svgRef.current?.querySelector<SVGGElement>(
                `[data-layer-title='${key}']`
            ) ?? null,
            centre as number
        ])

        const narrow = matchMedia('(max-width: 900px)')
        const short = matchMedia('(max-height: 760px)')
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
            const baseK = lerp(
                narrow.matches ? a.km : a.k,
                narrow.matches ? b.km : b.k,
                e
            )
            /* Keep the world strictly proportional. Layer spacing is tightened
               by translating complete planes in ScrollyWorld, never by
               applying a non-uniform scale that would deform the artwork. */
            const kx = baseK
            const ky = baseK
            const focusX = lerp(a.focusX, b.focusX, e)
            const focusY = lerp(a.focusY, b.focusY, e)
            const tx = -kx * (focusX - WORLD_CX)
            const ty = -ky * (focusY - WORLD_CY)
            group.setAttribute(
                'transform',
                `translate(${tx.toFixed(1)} ${ty.toFixed(1)}) translate(${WORLD_CX} ${WORLD_CY}) scale(${kx.toFixed(3)} ${ky.toFixed(3)}) translate(${-WORLD_CX} ${-WORLD_CY})`
            )
            layerOrder.forEach((layer, li) => {
                const el = layer.current
                if (el)
                    el.style.opacity = lerp(a.op[li], b.op[li], e).toFixed(2)
            })

            NOTES.forEach(([el, centre]) => {
                if (!el) return
                const hold = 0.05
                const gone = 0.14
                const away = Math.abs(p - centre)
                const proximity = Math.max(
                    0,
                    Math.min(1, (gone - away) / (gone - hold))
                )
                /* A note belongs to the scene only after its camera move has
                   settled. On the way in this is the end of the interval;
                   when scrolling back it is the beginning of the interval. */
                const zoomProgress = p <= centre ? e : 1 - e
                const settledOpacity = Math.max(
                    0,
                    Math.min(1, (zoomProgress - 0.96) / 0.04)
                )
                el.style.opacity = (proximity * settledOpacity).toFixed(2)
            })
            TITLES.forEach(([el, centre]) => {
                if (!el) return
                const away = Math.abs(p - centre)
                const opacity = Math.max(
                    0,
                    Math.min(1, (0.14 - away) / (0.14 - 0.05))
                )
                el.style.opacity = opacity.toFixed(2)
            })

            let nearest = 0
            cardsRef.current.forEach((card, ci) => {
                const centre = ci * IV
                const distance = Math.abs(p - centre)
                if (distance < Math.abs(p - nearest * IV)) nearest = ci
                if (!card) return
                const o = Math.max(0, 1 - distance / CARD_FADE)
                card.style.opacity = o.toFixed(2)
                // Narrow stacks the copy under the art and top-aligns it (§ the
                // portrait rules in styles.css), so it drifts off zero there.
                const base = narrow.matches ? '0%' : '-50%'
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
        short.addEventListener('change', onResize)
        return () => {
            removeEventListener('scroll', onScroll)
            removeEventListener('resize', onResize)
            narrow.removeEventListener('change', onResize)
            short.removeEventListener('change', onResize)
            clearTimeout(snapTimer)
            if (raf) cancelAnimationFrame(raf)
        }
    }, [layerOrder])

    return (
        <div className='lp-pin' ref={pinRef}>
            <div className='lp-stage'>
                <div className='lp-stage-inner'>
                    <div className='lp-rail'>
                        {/* Keyed by position, never by the copy inside. A
                            card's opacity and offset live in inline styles the
                            scroll loop writes, and `.lp-scene` defaults to
                            opacity 0; a key that changes with the language
                            remounts all five cards, and the fresh nodes carry
                            no inline style, so the whole rail goes blank until
                            the next scroll. The scene list is fixed in length
                            and order, so the index is a stable identity. */}
                        {scenes.map((scene, index) => {
                            const Heading = index === 0 ? 'h1' : 'h2'
                            return (
                                <div
                                    key={index}
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
                {scenes.map((_scene, index) => (
                    <span
                        key={index}
                        className={
                            index === active ? 'lp-pdot lp-on' : 'lp-pdot'
                        }
                    />
                ))}
            </div>
        </div>
    )
}
