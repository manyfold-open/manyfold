import type { FC, ReactNode, RefObject } from 'react'
import {
    ClaudeCodeColor,
    CodexColor,
    DifyColor,
    GeminiCLIColor,
    HermesAgentMono,
    OpenClawColor,
    type IconType
} from '@/lib/brandIcons'
import { useI18n } from '@/lib/i18n'

export interface WorldLayerRefs {
    gA: RefObject<SVGGElement>
    gFeed: RefObject<SVGGElement>
    gB: RefObject<SVGGElement>
    gFlow: RefObject<SVGGElement>
    gC: RefObject<SVGGElement>
}

/* Every agent in the world is the same figure: a blank head carrying its
   framework's own mark, a body wearing the run slot, two feet, and an
   antenna whose lamp is lit green while the agent is working. The mark is
   the only thing that differs between them — the platform is the constant,
   the framework is the variable.
   The figure is drawn before the desk it belongs to, so the desk cuts it at
   the waist: an agent works behind its desk, it does not stand on it. */
/* Every station is handed the same clocks on a different phase, so the plane
   never moves in unison; negative, so nothing waits for a cycle on load. */
const phase = (beat: number, period: number, shift = 0): string =>
    `${(-(beat * period) / 3.7 - shift).toFixed(2)}s`

/* One clock for the whole act of writing a line: the screen's active line, the
   body's tap and the head's nod all run on it. */
const WRITE = 3.1

const WorldAgent: FC<{
    x: number
    y: number
    scale: number
    Logo: IconType
    /* Mono marks paint themselves `currentColor`; give them the page ink so
       they read on both plates. */
    mono?: boolean
    /* Phase offset, so seven agents do not breathe in unison. */
    beat?: number
}> = ({ x, y, scale, Logo, mono = false, beat = 0 }) => (
    <g transform={`translate(${x},${y}) scale(${scale})`}>
        <g className='lp-w-tap' style={{ animationDelay: phase(beat, WRITE) }}>
            <ellipse
                cx='0'
                cy='2'
                rx='11.5'
                ry='3.4'
                fill='#000'
                opacity='0.16'
            />
            <rect
                x='-6.4'
                y='-9.5'
                width='4.2'
                height='9.5'
                rx='2.1'
                fill='var(--lp-w-box-r)'
                stroke='var(--lp-line)'
                strokeWidth='0.9'
            />
            <rect
                x='2.2'
                y='-9.5'
                width='4.2'
                height='9.5'
                rx='2.1'
                fill='var(--lp-w-box-r)'
                stroke='var(--lp-line)'
                strokeWidth='0.9'
            />
            <rect
                x='-11'
                y='-19'
                width='22'
                height='11'
                rx='4.5'
                fill='var(--lp-paper)'
                stroke='var(--lp-line)'
                strokeWidth='1'
            />
            <rect
                className='lp-w-slot'
                x='-5'
                y='-14.8'
                width='10'
                height='2.6'
                rx='1.3'
                fill='var(--lp-info)'
                opacity='0.6'
                style={{ animationDelay: `${(-beat * 0.31).toFixed(2)}s` }}
            />
            <rect
                x='-3.4'
                y='-24'
                width='6.8'
                height='6'
                rx='2.4'
                fill='var(--lp-w-box-r)'
                stroke='var(--lp-line)'
                strokeWidth='0.9'
            />
            <g
                className='lp-w-nod'
                style={{ animationDelay: phase(beat, WRITE) }}
            >
                <line
                    x1='0'
                    y1='-49'
                    x2='0'
                    y2='-56'
                    stroke='var(--lp-line)'
                    strokeWidth='1.1'
                    strokeLinecap='round'
                />
                <circle
                    className='lp-w-lamp'
                    cx='0'
                    cy='-58.8'
                    r='3.2'
                    fill='var(--lp-success)'
                    style={{ animationDelay: `${(-beat * 0.43).toFixed(2)}s` }}
                />
                <circle cx='0' cy='-58.8' r='1.8' fill='var(--lp-success)' />
                <rect
                    x='-14.5'
                    y='-49'
                    width='29'
                    height='27'
                    rx='8.5'
                    fill='var(--lp-paper)'
                    stroke='var(--lp-line)'
                    strokeWidth='1'
                />
                <Logo
                    size={15}
                    x={-7.5}
                    y={-43}
                    style={mono ? { color: 'var(--lp-ink)' } : undefined}
                />
            </g>
        </g>
    </g>
)

/* The isometric frame the world is drawn in: a step along u runs down-right,
   a step along v down-left, and w lifts. All three are the same unit, so a
   body authored 46 x 46 turns two faces of equal width to the camera — the
   thing that keeps a solid from reading as sheared. */
type Anchor = [number, number]

const ISO = Math.sqrt(3) / 2
const px = (o: Anchor, u: number, v: number, w = 0): Anchor => [
    o[0] + ISO * (u - v),
    o[1] + (u + v) / 2 - w
]
const at = (o: Anchor, u: number, v: number, w = 0): string => {
    const [sx, sy] = px(o, u, v, w)
    return `${sx.toFixed(1)},${sy.toFixed(1)}`
}
const quad = (o: Anchor, pts: Array<[number, number, number]>): string =>
    `M ${pts.map((p) => at(o, p[0], p[1], p[2])).join(' L ')} Z`

/* One agent at one desk, the unit the top plane is built out of. A desk is a
   rectangle and the long edge is the one it turns to the camera: the side the
   screen stands on and the figure works behind. `flip` swaps the two ground
   axes, which turns the whole station — screen, figure and all — to face the
   other way, long edge and all, without changing a single proportion. */
const Workstation: FC<{
    /* The desk's back corner, in world coordinates. */
    x: number
    y: number
    Logo: IconType
    mono?: boolean
    size?: number
    flip?: boolean
    scale?: number
    /* Which of the seven desks this is; only the animation phases read it. */
    beat?: number
}> = ({
    x,
    y,
    Logo,
    mono = false,
    size = 54,
    flip = false,
    scale = 0.92,
    beat = 0
}) => {
    const o: Anchor = [x, y]
    const W = size
    const D = (size * 2) / 3
    const H = 15
    const Lu = flip ? D : W
    const Lv = flip ? W : D
    // Along the desk's run and across its depth; `flip` is the only difference
    // between a station that faces left and one that faces right.
    const p = (run: number, cross: number, w = 0): [number, number, number] =>
        flip ? [cross, run, w] : [run, cross, w]
    const MW = W - 22
    const a0 = 4
    const cross = D * 0.65
    const run = W * 0.59
    /* The screen's own axes, so its contents can be authored — and animated —
       as plain rectangles: local x runs along the face, local y down it. A
       `scaleX` inside this frame grows a line along the screen instead of
       shearing it off the isometric grid. */
    const [Ox, Oy] = px(o, ...p(a0, cross, 21))
    const face = `matrix(${flip ? -ISO : ISO},0.5,0,1,${Ox.toFixed(1)},${Oy.toFixed(1)})`
    // Every station is handed the same clocks on a different phase, so the
    // plane never blinks in unison.
    const off = (period: number, shift = 0): string =>
        phase(beat, period, shift)
    return (
        <>
            <WorldAgent
                x={o[0] + (flip ? -ISO : ISO) * (run + 6)}
                y={o[1] + (run - 6) / 2 + H}
                scale={scale}
                Logo={Logo}
                mono={mono}
                beat={beat}
            />
            <path
                d={quad(o, [
                    [Lu, 0, 0],
                    [Lu, Lv, 0],
                    [Lu, Lv, -H],
                    [Lu, 0, -H]
                ])}
                fill='var(--lp-w-box-r)'
                stroke='none'
                strokeWidth='0.9'
            />
            <path
                d={quad(o, [
                    [0, Lv, 0],
                    [Lu, Lv, 0],
                    [Lu, Lv, -H],
                    [0, Lv, -H]
                ])}
                fill='var(--lp-w-box-l)'
                stroke='none'
                strokeWidth='0.9'
            />
            <path
                d={quad(o, [
                    [0, 0, 0],
                    [Lu, 0, 0],
                    [Lu, Lv, 0],
                    [0, Lv, 0]
                ])}
                fill='var(--lp-w-box-top)'
                stroke='var(--lp-w-box-edge)'
                strokeWidth='0.9'
            />
            <path
                d={quad(o, [
                    p(a0 + MW / 2 - 3, cross, -5),
                    p(a0 + MW / 2 + 3, cross, -5),
                    p(a0 + MW / 2 + 3, cross, 0),
                    p(a0 + MW / 2 - 3, cross, 0)
                ])}
                fill='var(--lp-w-box-r)'
                stroke='none'
                strokeWidth='0.9'
            />
            <path
                d={quad(o, [
                    p(a0, cross, 0),
                    p(a0 + MW, cross, 0),
                    p(a0 + MW, cross, 21),
                    p(a0, cross, 21)
                ])}
                fill='var(--lp-w-screen)'
                stroke='var(--lp-w-box-edge)'
                strokeWidth='0.9'
            />
            <g transform={face}>
                <rect
                    className='lp-w-line'
                    x={MW * 0.106}
                    y={6.4}
                    width={MW * 0.67}
                    height={2}
                    fill='var(--lp-w-bar)'
                    style={{ animationDelay: off(4.8) }}
                />
                <rect
                    className='lp-w-line'
                    x={MW * 0.106}
                    y={10.4}
                    width={MW * 0.48}
                    height={2}
                    fill='var(--lp-w-bar)'
                    style={{ animationDelay: off(4.8, 1.9) }}
                />
                <rect
                    className='lp-w-run'
                    x={MW * 0.106}
                    y={14.4}
                    width={MW * 0.79}
                    height={2}
                    fill='var(--lp-info)'
                    style={{ animationDelay: off(WRITE) }}
                />
            </g>
        </>
    )
}

/* Skills & MCP, drawn as the toolbox the label already implies. Three things
   the old one got wrong: the body was authored in screen coordinates and sat
   15px off the centre of its own pad; the handle was a screen-space arch,
   symmetric about a vertical, which reads as a sticker rather than something
   standing on the lid; and the loose ticks and dot on the faces carried no
   meaning.

   Everything is authored in iso units through at()/quad(), so the body is
   square by construction and every part shares the world's axes. The handle
   is a bar — a solid with the same three-face anatomy as the body, so the
   silhouette pass closes it like any other object; a stroked curve could
   never belong to the drawing the way a solid does.

   The one Iris touch is the middle port: this is the object tools plug into,
   so the accent marks a live socket instead of decorating a face. */
const Toolbox: FC<{ x: number; y: number }> = ({ x, y }) => {
    const o: Anchor = [x, y]
    /* Half-length along u, half-depth along v, body height, lid band. */
    const U = 17
    const V = 12
    const H = 17
    const LID = 5.5

    /* Three visible faces of a box, in the order the painter needs them. */
    const solid = (
        key: string,
        hu: number,
        hv: number,
        base: number,
        h: number
    ): ReactNode => (
        <g key={key}>
            <path
                d={quad(o, [
                    [hu, -hv, base + h],
                    [hu, hv, base + h],
                    [hu, hv, base],
                    [hu, -hv, base]
                ])}
                fill='var(--lp-w-box-r)'
                stroke='none'
            />
            <path
                d={quad(o, [
                    [-hu, hv, base + h],
                    [hu, hv, base + h],
                    [hu, hv, base],
                    [-hu, hv, base]
                ])}
                fill='var(--lp-w-box-l)'
                stroke='none'
            />
            <path
                d={quad(o, [
                    [-hu, -hv, base + h],
                    [hu, -hv, base + h],
                    [hu, hv, base + h],
                    [-hu, hv, base + h]
                ])}
                fill='var(--lp-w-box-top)'
                stroke='none'
            />
        </g>
    )

    const port = (u: number, live: boolean): ReactNode => (
        <path
            key={u}
            d={quad(o, [
                [u - 2, V, 9],
                [u + 2, V, 9],
                [u + 2, V, 5],
                [u - 2, V, 5]
            ])}
            fill={live ? 'var(--lp-info)' : 'var(--lp-w-socket)'}
            stroke='var(--lp-w-box-edge)'
            strokeWidth='0.6'
        />
    )

    return (
        <g>
            {solid('body', U, V, 0, H)}
            {/* The lid, as one seam carried across both visible faces. */}
            <path
                d={`M ${at(o, -U, V, H - LID)} L ${at(o, U, V, H - LID)} L ${at(o, U, -V, H - LID)}`}
                fill='none'
                stroke='var(--lp-w-box-edge)'
                strokeWidth='0.8'
            />
            {[-7.5, 0, 7.5].map((u, i) => port(u, i === 1))}
            {/* The grip: a bar across the lid, long on the box's long axis and
                shallow across it, so it reads as something to lift by rather
                than as a second box. */}
            {solid('grip', 9.5, 2.6, H, 4)}
        </g>
    )
}

/* ——— Flux: the light that runs between the planes —————————————————————
   The wires are the only energy in an otherwise Ash world, so they are drawn
   with light rather than with line: a wide, near-transparent bloom under a
   crisp core whose stroke is a gradient that fades with distance. Every
   gradient is userSpaceOnUse — a bezier twenty units wide and three hundred
   tall has no bounding-box width for an objectBoundingBox gradient to run
   across, and the falloff collapses into one flat colour.

   One clock runs the whole chain, so a single run can be followed all the way
   down: BAR is the bar the feed and the trunk share, FAN the fan-out's, BEAT
   the interval between two arrivals at the junction. Every `begin` below is a
   beat on that clock, which is why the packet that reaches the junction, the
   ring it fires there and the route that leaves are one run rather than three
   unrelated loops. */
const BAR = 4.8
const FAN = 6.4
const BEAT = 1.6
/* Fraction of a bar spent travelling; the rest is the gap before the next
   packet on the same wire. */
const FEED_T = 0.45
const TRUNK_T = 0.58
const FAN_T = 0.35
/* The isometric ground plane, as the ratio between a circle's projected axes.
   Rings and pads are ellipses in this ratio so they lie on the plates instead
   of facing the viewer. */
const GROUND = 0.577

interface FluxLeg {
    id: string
    d: string
    /* Both ends of the gradient's own axis. A bezier's endpoints are not its
       bounding box, so they have to be given rather than derived. */
    a: [number, number]
    b: [number, number]
}

/* Four agent plates feed the control plane. Each wire is dim where it leaves
   its plate and bright where it lands, so the light belongs to the arrival. */
const FEED_LEGS: Array<FluxLeg & { hue: string; spill: [number, number] }> = [
    {
        id: 'f1',
        d: 'M 354.1,172 C 354.1,333 373.1,333 373.1,494',
        a: [354.1, 172],
        b: [373.1, 494],
        hue: '1',
        spill: [355, 211]
    },
    {
        id: 'f2',
        d: 'M 525.5,265 C 525.5,379.5 378.3,379.5 373.1,494',
        a: [525.5, 265],
        b: [373.1, 494],
        hue: '2',
        spill: [521, 269]
    },
    {
        id: 'f3',
        d: 'M 216.4,238.5 C 216.4,366.2 378.3,366.2 373.1,494',
        a: [216.4, 238.5],
        b: [373.1, 494],
        hue: '3',
        spill: [216, 242]
    },
    {
        id: 'f4',
        d: 'M 367.9,316 C 367.9,405 378.3,405 373.1,494',
        a: [367.9, 316],
        b: [373.1, 494],
        hue: '4',
        spill: [368, 325]
    }
]

/* The trunk. Three strands rather than one cable, splayed where they leave
   the control plane and gathered into the junction — a bundle has a round
   cross-section, three parallel lines are a barcode. */
const TRUNK_LEGS: Array<
    FluxLeg & { w: number; hue: string; r: number; begin: number }
> = [
    {
        id: 't1',
        d: 'M 364.6,652 C 364.6,710 370.6,742 376.6,794',
        a: [364.6, 652],
        b: [376.6, 842],
        w: 0.9,
        hue: '1',
        r: 3.3,
        begin: 0.6
    },
    {
        id: 't2',
        d: 'M 378.4,652 C 378.4,720 379.6,756 379.9,794',
        a: [378.4, 652],
        b: [379.9, 842],
        w: 1.35,
        hue: '3',
        r: 3.6,
        begin: 2.2
    },
    {
        id: 't3',
        d: 'M 392.2,652 C 392.2,710 387.2,742 383.2,794',
        a: [392.2, 652],
        b: [383.2, 842],
        w: 1,
        hue: '2',
        r: 3.1,
        begin: 3.8
    }
]

const JUNCTION: [number, number] = [380, 794]

/* Each route stops at a pad on its plate rather than at the object standing
   on it: a line that runs to an object crosses the solid it is meant to reach,
   and nothing marks where the run arrives. */
const FAN_LEGS: Array<FluxLeg & { pad: [number, number]; begin: number }> = [
    {
        id: 'n1',
        d: 'M 380,794 Q 362,800 336.3,812.4',
        a: JUNCTION,
        b: [336.3, 812.4],
        pad: [336.3, 812.4],
        begin: 3.45
    },
    {
        id: 'n2',
        d: 'M 380,794 Q 316,822 250.6,878',
        a: JUNCTION,
        b: [250.6, 878],
        pad: [250.6, 878],
        begin: 5.05
    },
    {
        id: 'n4',
        d: 'M 380,794 Q 410,876 417.9,974.6',
        a: JUNCTION,
        b: [417.9, 974.6],
        pad: [417.9, 974.6],
        begin: 6.65
    },
    {
        id: 'n3',
        d: 'M 380,794 Q 398,838 449.8,890.6',
        a: JUNCTION,
        b: [449.8, 890.6],
        pad: [449.8, 890.6],
        begin: 8.25
    }
]

const FluxGrad: FC<{ leg: FluxLeg; from: number; to: number }> = ({
    leg,
    from,
    to
}) => (
    <linearGradient
        id={`fx-${leg.id}`}
        gradientUnits='userSpaceOnUse'
        x1={leg.a[0]}
        y1={leg.a[1]}
        x2={leg.b[0]}
        y2={leg.b[1]}
    >
        <stop offset='0' stopColor='var(--lp-w-flux)' stopOpacity={from} />
        <stop offset='1' stopColor='var(--lp-w-flux)' stopOpacity={to} />
    </linearGradient>
)

/* The bloom reuses the core's gradient at a fraction of its alpha, so a wire
   needs one gradient rather than two and the halo fades with the line. */
const FluxWire: FC<{ leg: FluxLeg; w: number; bloom: number }> = ({
    leg,
    w,
    bloom
}) => (
    <>
        <path
            d={leg.d}
            stroke={`url(#fx-${leg.id})`}
            className='lp-flux-bloom'
            strokeWidth={bloom}
            strokeLinecap='round'
            fill='none'
        />
        <path
            d={leg.d}
            stroke={`url(#fx-${leg.id})`}
            strokeWidth={w}
            strokeLinecap='round'
            fill='none'
        />
    </>
)

/* A packet is a lit bead, not a dot: an aura that sells it as a light source,
   a hot core, and — because animateMotion turns the group along the path — a
   tail that always trails the head however the wire curves. It scales in and
   out of existence rather than blinking on. */
const FluxPacket: FC<{
    d: string
    dur: number
    begin: number
    travel: number
    hue: string
    r: number
}> = ({ d, dur, begin, travel, hue, r }) => {
    const keys = `0;0.05;${(travel - 0.05).toFixed(3)};${travel};1`
    const time = {
        dur: `${dur}s`,
        begin: `${begin}s`,
        repeatCount: 'indefinite'
    }
    return (
        <g className='lp-flux'>
            <g>
                <animateMotion
                    path={d}
                    rotate='auto'
                    keyPoints='0;1;1'
                    keyTimes={`0;${travel};1`}
                    calcMode='linear'
                    {...time}
                />
                <g opacity='0'>
                    <animate
                        attributeName='opacity'
                        values='0;1;1;0;0'
                        keyTimes={keys}
                        {...time}
                    />
                    <animateTransform
                        attributeName='transform'
                        type='scale'
                        values='0.3;1;1;0.35;0.35'
                        keyTimes={keys}
                        {...time}
                    />
                    <ellipse
                        cx={-r * 2.3}
                        cy='0'
                        rx={r * 4.2}
                        ry={r * 2.1}
                        fill={`url(#fx-aura-${hue})`}
                    />
                    <circle r={r * 2.6} fill={`url(#fx-aura-${hue})`} />
                    <circle
                        r={r}
                        fill={
                            hue === 'i'
                                ? 'var(--lp-w-flux)'
                                : `var(--lp-w-c${hue})`
                        }
                    />
                    <circle r={r * 0.3} fill='var(--lp-w-flux-spec)' />
                </g>
            </g>
        </g>
    )
}

/* A ripple in the ground plane. The whole event is compressed into the front
   of the bar by `peak`, so a ring can fire on a six-second clock without
   spending six seconds expanding. */
const FluxRing: FC<{
    c: [number, number]
    r0: number
    r1: number
    dur: number
    begin: number
    peak: number
    op: number
    w: number
}> = ({ c, r0, r1, dur, begin, peak, op, w }) => {
    const time = {
        dur: `${dur}s`,
        begin: `${begin}s`,
        repeatCount: 'indefinite'
    }
    const keys = `0;${peak};1`
    return (
        <ellipse
            className='lp-flux'
            cx={c[0]}
            cy={c[1]}
            rx={r0}
            ry={r0 * GROUND}
            fill='none'
            stroke='var(--lp-w-flux)'
            strokeWidth={w}
            opacity='0'
        >
            <animate
                attributeName='rx'
                values={`${r0};${r1};${r1}`}
                keyTimes={keys}
                {...time}
            />
            <animate
                attributeName='ry'
                values={`${r0 * GROUND};${r1 * GROUND};${r1 * GROUND}`}
                keyTimes={keys}
                {...time}
            />
            <animate
                attributeName='opacity'
                values={`${op};0;0`}
                keyTimes={keys}
                {...time}
            />
        </ellipse>
    )
}

/* Where a run lands: a lit patch on the plate, a rim, and a ripple timed to
   the packet's arrival. */
const FluxPad: FC<{ c: [number, number]; begin: number }> = ({ c, begin }) => (
    <>
        <ellipse cx={c[0]} cy={c[1]} rx='17' ry='9.8' fill='url(#fx-halo)' />
        <ellipse
            cx={c[0]}
            cy={c[1]}
            rx='7.2'
            ry='4.2'
            fill='none'
            stroke='var(--lp-w-flux)'
            strokeOpacity='0.3'
            strokeWidth='0.8'
        />
        <ellipse cx={c[0]} cy={c[1]} rx='2.6' ry='1.6' fill='var(--lp-w-flux)' />
        <FluxRing
            c={c}
            r0={6}
            r1={19}
            dur={FAN}
            begin={begin}
            peak={0.13}
            op={0.7}
            w={1}
        />
    </>
)

/* One aura per hue in flight: the brand for anything below the control plane,
   and the four framework marks above it. */
const FLUX_AURAS: Array<[string, string, number]> = [
    ['i', 'var(--lp-w-flux)', 0.5],
    ['1', 'var(--lp-w-c1)', 0.44],
    ['2', 'var(--lp-w-c2)', 0.44],
    ['3', 'var(--lp-w-c3)', 0.44],
    ['4', 'var(--lp-w-c4)', 0.44]
]

/* The isometric world the hero scrolls through: three stacked planes —
   agent infrastructure on top, the Manyfold control plane in the middle,
   delivery surfaces at the bottom. The scroll loop in ScrollyStage owns
   the camera (translate/scale on the outer group) and the per-plane
   opacity, so nothing here re-renders while the page scrolls. */
export const ScrollyWorld: FC<{
    svgRef: RefObject<SVGSVGElement>
    groupRef: RefObject<SVGGElement>
    layers: WorldLayerRefs
}> = ({ svgRef, groupRef, layers }) => {
    const { t } = useI18n()
    return (
        <svg
            ref={svgRef}
            className='lp-world'
            viewBox='44 -20 688 1095'
            preserveAspectRatio='xMidYMid meet'
            fill='none'
            aria-hidden='true'
        >
            <defs>
                <filter
                    id='lp-blur'
                    x='-80%'
                    y='-80%'
                    width='260%'
                    height='260%'
                >
                    <feGaussianBlur stdDeviation='12' />
                </filter>
            </defs>
            <g ref={groupRef} className='lp-worldg'>
                <defs>
                    <linearGradient
                        id='lp-slabTop'
                        x1='0.1'
                        y1='0'
                        x2='0.9'
                        y2='1'
                    >
                        <stop offset='0' stopColor='var(--lp-w-slab-hi)' />
                        <stop offset='1' stopColor='var(--lp-w-slab-top)' />
                    </linearGradient>
                    <radialGradient id='lp-amb' cx='0.5' cy='0.5' r='0.5'>
                        <stop
                            offset='0'
                            stopColor='var(--lp-info)'
                            stopOpacity='0.11'
                        />
                        <stop
                            offset='0.6'
                            stopColor='var(--lp-info)'
                            stopOpacity='0.03'
                        />
                        <stop
                            offset='1'
                            stopColor='var(--lp-info)'
                            stopOpacity='0'
                        />
                    </radialGradient>
                    <radialGradient id='lp-spill' cx='0.5' cy='0.5' r='0.5'>
                        <stop
                            offset='0'
                            stopColor='var(--lp-info)'
                            stopOpacity='var(--lp-w-spill-opacity)'
                        />
                        <stop
                            offset='1'
                            stopColor='var(--lp-info)'
                            stopOpacity='0'
                        />
                    </radialGradient>
                    {/* Flux material. The aura is objectBoundingBox — a bead
                        is a circle, so its box is square and the gradient
                        needs no user-space anchor. */}
                    {FLUX_AURAS.map(([id, hue, peak]) => (
                        <radialGradient key={id} id={`fx-aura-${id}`}>
                            <stop offset='0' stopColor={hue} stopOpacity={peak} />
                            <stop
                                offset='0.42'
                                stopColor={hue}
                                stopOpacity={peak * 0.28}
                            />
                            <stop offset='1' stopColor={hue} stopOpacity='0' />
                        </radialGradient>
                    ))}
                    {/* Halo and haze: soft light with no filter behind it.
                        A blurred element is re-rasterised on every camera
                        frame; a radial gradient is not. */}
                    <radialGradient id='fx-halo'>
                        <stop
                            offset='0'
                            stopColor='var(--lp-w-flux)'
                            stopOpacity='0.15'
                        />
                        <stop
                            offset='0.5'
                            stopColor='var(--lp-w-flux)'
                            stopOpacity='0.045'
                        />
                        <stop
                            offset='1'
                            stopColor='var(--lp-w-flux)'
                            stopOpacity='0'
                        />
                    </radialGradient>
                    <radialGradient id='fx-haze'>
                        <stop
                            offset='0'
                            stopColor='var(--lp-w-flux)'
                            stopOpacity='0.055'
                        />
                        <stop
                            offset='1'
                            stopColor='var(--lp-w-flux)'
                            stopOpacity='0'
                        />
                    </radialGradient>
                    <radialGradient id='fx-shade'>
                        <stop offset='0' stopColor='#000' stopOpacity='0.18' />
                        <stop offset='1' stopColor='#000' stopOpacity='0' />
                    </radialGradient>
                    {FEED_LEGS.map((leg) => (
                        <FluxGrad key={leg.id} leg={leg} from={0.17} to={0.46} />
                    ))}
                    {TRUNK_LEGS.map((leg) => (
                        <FluxGrad key={leg.id} leg={leg} from={0.52} to={0.2} />
                    ))}
                    {FAN_LEGS.map((leg) => (
                        <FluxGrad key={leg.id} leg={leg} from={0.44} to={0.1} />
                    ))}
                </defs>
                <g className='lp-layer'>
                    <ellipse
                        cx='324'
                        cy='527'
                        rx='372'
                        ry='572'
                        fill='url(#lp-amb)'
                    />
                </g>
                <g
                    className='lp-layer'
                    ref={layers.gC}
                    transform='translate(380 794) scale(1.15) translate(-380 -794) translate(0 -48)'
                >
                    <path
                        d='M 423.3,835.0 L 347.1,879.0 L 347.1,888.0 L 423.3,844.0 Z'
                        fill='var(--lp-w-slab-r)'
                        stroke='none'
                        strokeWidth='0.9'
                    />
                    <path
                        d='M 257.1,827.0 L 347.1,879.0 L 347.1,888.0 L 257.1,836.0 Z'
                        fill='var(--lp-w-slab-l)'
                        stroke='none'
                        strokeWidth='0.9'
                    />
                    <path
                        d='M 333.3,783.0 L 423.3,835.0 L 347.1,879.0 L 257.1,827.0 Z'
                        fill='url(#lp-slabTop)'
                        stroke='var(--lp-w-slab-edge)'
                        strokeWidth='1'
                    />
                    <path
                        d='M 373.1,812.0 L 333.3,835.0 L 333.3,843.0 L 373.1,820.0 Z'
                        fill='var(--lp-w-box-r)'
                        stroke='none'
                        strokeWidth='0.9'
                    />
                    <path
                        d='M 293.5,812.0 L 333.3,835.0 L 333.3,843.0 L 293.5,820.0 Z'
                        fill='var(--lp-w-box-l)'
                        stroke='none'
                        strokeWidth='0.9'
                    />
                    <path
                        d='M 333.3,789.0 L 373.1,812.0 L 333.3,835.0 L 293.5,812.0 Z'
                        fill='var(--lp-w-box-top)'
                        stroke='var(--lp-w-box-edge)'
                        strokeWidth='0.9'
                    />
                    {/* A phone is a slab, so it is built as one: four units thick, with a
                        bezel around the display and a dock to stand it in. */}
                    <path
                        d='M 331.6,816.0 L 321.2,822.0 L 321.2,828.0 L 331.6,822.0 Z'
                        fill='var(--lp-w-box-r)'
                        stroke='none'
                        strokeWidth='0.9'
                    />
                    <path
                        d='M 305.6,813.0 L 321.2,822.0 L 321.2,828.0 L 305.6,819.0 Z'
                        fill='var(--lp-w-box-l)'
                        stroke='none'
                        strokeWidth='0.9'
                    />
                    <path
                        d='M 316.0,807.0 L 331.6,816.0 L 321.2,822.0 L 305.6,813.0 Z'
                        fill='var(--lp-w-box-top)'
                        stroke='var(--lp-w-box-edge)'
                        strokeWidth='0.9'
                    />
                    <path
                        d='M 331.6,762.0 L 328.1,764.0 L 328.1,822.0 L 331.6,820.0 Z'
                        fill='var(--lp-w-box-r)'
                        stroke='none'
                        strokeWidth='0.9'
                    />
                    <path
                        d='M 309.1,749.0 L 331.6,762.0 L 328.1,764.0 L 305.6,751.0 Z'
                        fill='var(--lp-w-box-top)'
                        stroke='var(--lp-w-box-edge)'
                        strokeWidth='0.9'
                    />
                    <path
                        d='M 305.6,751.0 L 328.1,764.0 L 328.1,822.0 L 305.6,809.0 Z'
                        fill='var(--lp-w-box-r)'
                        stroke='var(--lp-w-box-edge)'
                        strokeWidth='0.9'
                    />
                    <g transform='matrix(0.866,0.5,0,1,305.6,751.0)'>
                        <rect
                            x='1.8'
                            y='5'
                            width='22.4'
                            height='48'
                            fill='var(--lp-w-screen)'
                        />
                        <rect
                            x='8'
                            y='2.4'
                            width='10'
                            height='1.6'
                            rx='0.8'
                            fill='var(--lp-w-bar)'
                        />
                        <rect
                            x='7.5'
                            y='54.6'
                            width='11'
                            height='1.5'
                            rx='0.75'
                            fill='var(--lp-w-bar)'
                        />
                        <rect
                            x='4'
                            y='9'
                            width='13'
                            height='6'
                            rx='2'
                            fill='var(--lp-w-bar)'
                        />
                        <rect
                            x='4'
                            y='17.5'
                            width='10'
                            height='5'
                            rx='2'
                            fill='var(--lp-w-bar)'
                        />
                        <rect
                            x='9'
                            y='25.5'
                            width='13'
                            height='6'
                            rx='2'
                            fill='var(--lp-info)'
                        />
                        <rect
                            x='4'
                            y='34'
                            width='15'
                            height='5'
                            rx='2'
                            fill='var(--lp-w-bar)'
                        />
                        <rect
                            className='lp-w-land'
                            x='11'
                            y='42'
                            width='11'
                            height='5'
                            rx='2'
                            fill='var(--lp-info-bg)'
                            stroke='var(--lp-w-led-edge)'
                            strokeWidth='0.7'
                            style={{ animationDelay: '-0.71s' }}
                        />
                        <circle
                            cx='6'
                            cy='44.5'
                            r='1.7'
                            fill='var(--lp-w-c1)'
                        />
                    </g>
                    <path
                        d='M 326.3,905.0 L 255.3,946.0 L 255.3,955.0 L 326.3,914.0 Z'
                        fill='var(--lp-w-slab-r)'
                        stroke='none'
                        strokeWidth='0.9'
                    />
                    <path
                        d='M 148.0,884.0 L 255.3,946.0 L 255.3,955.0 L 148.0,893.0 Z'
                        fill='var(--lp-w-slab-l)'
                        stroke='none'
                        strokeWidth='0.9'
                    />
                    <path
                        d='M 219.0,843.0 L 326.3,905.0 L 255.3,946.0 L 148.0,884.0 Z'
                        fill='url(#lp-slabTop)'
                        stroke='var(--lp-w-slab-edge)'
                        strokeWidth='1'
                    />
                    {/* Your terminal is a machine, not a poster: a deck lying on the plate
                        with the screen hinged up from its back edge. It also drops the
                        plinth every other surface stands on, which is what stops the plane
                        reading as one composition stamped four times. */}
                    <path
                        d='M 271.0,886.0 L 232.9,908.0 L 232.9,913.0 L 271.0,891.0 Z'
                        fill='var(--lp-w-box-r)'
                        stroke='none'
                        strokeWidth='0.9'
                    />
                    <path
                        d='M 177.4,876.0 L 232.9,908.0 L 232.9,913.0 L 177.4,881.0 Z'
                        fill='var(--lp-w-box-l)'
                        stroke='none'
                        strokeWidth='0.9'
                    />
                    <path
                        d='M 215.5,854.0 L 271.0,886.0 L 232.9,908.0 L 177.4,876.0 Z'
                        fill='var(--lp-w-box-top)'
                        stroke='var(--lp-w-box-edge)'
                        strokeWidth='0.9'
                    />
                    <path
                        d='M 215.5,862.0 L 257.1,886.0 L 253.6,888.0 L 212.1,864.0 Z'
                        fill='var(--lp-w-bar)'
                        stroke='none'
                        strokeWidth='0.9'
                    />
                    <path
                        d='M 209.5,865.5 L 251.0,889.5 L 247.6,891.5 L 206.0,867.5 Z'
                        fill='var(--lp-w-bar)'
                        stroke='none'
                        strokeWidth='0.9'
                    />
                    <path
                        d='M 203.4,869.0 L 234.6,887.0 L 231.1,889.0 L 199.9,871.0 Z'
                        fill='var(--lp-w-bar)'
                        stroke='none'
                        strokeWidth='0.9'
                    />
                    <path
                        d='M 206.0,879.5 L 226.8,891.5 L 219.9,895.5 L 199.1,883.5 Z'
                        fill='var(--lp-w-socket)'
                        stroke='var(--lp-w-box-edge)'
                        strokeWidth='0.9'
                    />
                    <path
                        d='M 217.3,855.0 L 269.2,885.0 L 269.2,845.0 L 217.3,815.0 Z'
                        fill='var(--lp-w-chip)'
                        stroke='var(--lp-w-box-edge)'
                        strokeWidth='0.9'
                    />
                    {/* Screen content lives in the screen's own axes. */}
                    <g transform='matrix(0.866,0.5,0,1,217.3,815.0)'>
                        <text
                            x='5'
                            y='11'
                            className='lp-mono'
                            fontSize='7'
                            fill='var(--lp-info)'
                        >
                            {'>_'}
                        </text>
                        <rect
                            x='14'
                            y='6.2'
                            width='28'
                            height='3'
                            fill='var(--lp-w-bar)'
                        />
                        <rect
                            x='5'
                            y='14'
                            width='40'
                            height='3'
                            fill='var(--lp-w-bar)'
                        />
                        <rect
                            className='lp-w-land'
                            x='5'
                            y='20'
                            width='27'
                            height='3'
                            fill='var(--lp-info)'
                            style={{ animationDelay: '-5.51s' }}
                        />
                        <text
                            x='5'
                            y='33'
                            className='lp-mono'
                            fontSize='6'
                            fill='var(--lp-success)'
                        >
                            ✓ {t('web.landing.worldTerminalDone')}
                        </text>
                    </g>
                    <path
                        d='M 622.5,928.0 L 522.1,986.0 L 522.1,995.0 L 622.5,937.0 Z'
                        fill='var(--lp-w-slab-r)'
                        stroke='none'
                        strokeWidth='0.9'
                    />
                    <path
                        d='M 390.4,910.0 L 522.1,986.0 L 522.1,995.0 L 390.4,919.0 Z'
                        fill='var(--lp-w-slab-l)'
                        stroke='none'
                        strokeWidth='0.9'
                    />
                    <path
                        d='M 490.9,852.0 L 622.5,928.0 L 522.1,986.0 L 390.4,910.0 Z'
                        fill='url(#lp-slabTop)'
                        stroke='var(--lp-w-slab-edge)'
                        strokeWidth='1'
                    />
                    {/* Your product arrives on a monitor, not a poster: the cabinet has
                        real thickness, so its side and top edges read, and it stands on a
                        column with the machine that drives it beside it. The desk is kept
                        shallower than its plate so the plate has an apron the delivery wire
                        can land on, clear of every edge. */}
                    <path
                        d='M 556.7,894.0 L 490.9,932.0 L 490.9,942.0 L 556.7,904.0 Z'
                        fill='var(--lp-w-box-r)'
                        stroke='none'
                        strokeWidth='0.9'
                    />
                    <path
                        d='M 425.1,894.0 L 490.9,932.0 L 490.9,942.0 L 425.1,904.0 Z'
                        fill='var(--lp-w-box-l)'
                        stroke='none'
                        strokeWidth='0.9'
                    />
                    <path
                        d='M 490.9,856.0 L 556.7,894.0 L 490.9,932.0 L 425.1,894.0 Z'
                        fill='var(--lp-w-box-top)'
                        stroke='var(--lp-w-box-edge)'
                        strokeWidth='0.9'
                    />
                    <path
                        d='M 503.0,881.0 L 489.2,889.0 L 489.2,901.0 L 503.0,893.0 Z'
                        fill='var(--lp-w-box-r)'
                        stroke='none'
                        strokeWidth='0.9'
                    />
                    <path
                        d='M 484.0,886.0 L 489.2,889.0 L 489.2,901.0 L 484.0,898.0 Z'
                        fill='var(--lp-w-box-l)'
                        stroke='none'
                        strokeWidth='0.9'
                    />
                    <path
                        d='M 497.8,878.0 L 503.0,881.0 L 489.2,889.0 L 484.0,886.0 Z'
                        fill='var(--lp-w-box-top)'
                        stroke='var(--lp-w-box-edge)'
                        strokeWidth='0.9'
                    />
                    {/* The box that drives it, standing on the desk beside the screen. */}
                    <path
                        d='M 548.1,847.0 L 535.1,854.5 L 535.1,898.5 L 548.1,891.0 Z'
                        fill='var(--lp-w-box-r)'
                        stroke='none'
                        strokeWidth='0.9'
                    />
                    <path
                        d='M 517.7,844.5 L 535.1,854.5 L 535.1,898.5 L 517.7,888.5 Z'
                        fill='var(--lp-w-box-l)'
                        stroke='none'
                        strokeWidth='0.9'
                    />
                    <path
                        d='M 530.7,837.0 L 548.1,847.0 L 535.1,854.5 L 517.7,844.5 Z'
                        fill='var(--lp-w-box-top)'
                        stroke='var(--lp-w-box-edge)'
                        strokeWidth='0.9'
                    />
                    <g transform='matrix(-0.866,0.5,0,1,548.1,847.0)'>
                        <rect
                            x='3'
                            y='5'
                            width='9'
                            height='1.6'
                            fill='var(--lp-w-bar)'
                        />
                        <rect
                            x='3'
                            y='8.4'
                            width='9'
                            height='1.6'
                            fill='var(--lp-w-bar)'
                        />
                        <rect
                            x='3'
                            y='11.8'
                            width='9'
                            height='1.6'
                            fill='var(--lp-w-bar)'
                        />
                        <rect
                            x='3'
                            y='18'
                            width='9'
                            height='3'
                            rx='0.7'
                            fill='var(--lp-w-socket)'
                        />
                        <circle
                            cx='4.6'
                            cy='36'
                            r='1.5'
                            fill='var(--lp-info)'
                        />
                    </g>
                    <path
                        d='M 464.9,853.0 L 470.1,856.0 L 470.1,900.0 L 464.9,897.0 Z'
                        fill='var(--lp-w-box-l)'
                        stroke='none'
                        strokeWidth='0.9'
                    />
                    <path
                        d='M 516.9,823.0 L 522.1,826.0 L 470.1,856.0 L 464.9,853.0 Z'
                        fill='var(--lp-w-box-top)'
                        stroke='var(--lp-w-box-edge)'
                        strokeWidth='0.9'
                    />
                    <path
                        d='M 522.1,826.0 L 470.1,856.0 L 470.1,900.0 L 522.1,870.0 Z'
                        fill='var(--lp-w-screen)'
                        stroke='var(--lp-w-box-edge)'
                        strokeWidth='0.9'
                    />
                    <g transform='matrix(-0.866,0.5,0,1,522.1,826.0)'>
                        <rect
                            x='0'
                            y='0'
                            width='60'
                            height='7.5'
                            fill='var(--lp-w-socket)'
                        />
                        <circle
                            cx='5.2'
                            cy='3.8'
                            r='1.3'
                            fill='var(--lp-w-bar)'
                        />
                        <circle
                            cx='9.8'
                            cy='3.8'
                            r='1.3'
                            fill='var(--lp-w-bar)'
                        />
                        <circle
                            cx='14.4'
                            cy='3.8'
                            r='1.3'
                            fill='var(--lp-w-bar)'
                        />
                        <rect
                            x='19'
                            y='1.9'
                            width='28'
                            height='3.7'
                            rx='1.85'
                            fill='var(--lp-w-bar)'
                            opacity='0.55'
                        />
                        <rect
                            x='5'
                            y='11.5'
                            width='40'
                            height='3.2'
                            fill='var(--lp-w-bar)'
                        />
                        <rect
                            x='5'
                            y='17.5'
                            width='14'
                            height='4.5'
                            fill='var(--lp-info)'
                        />
                        <rect
                            x='5'
                            y='25'
                            width='50'
                            height='9.5'
                            fill='var(--lp-w-card)'
                        />
                        <rect
                            x='8'
                            y='27.2'
                            width='30'
                            height='2.4'
                            fill='var(--lp-w-bar)'
                        />
                        <rect
                            x='8'
                            y='31'
                            width='20'
                            height='2.4'
                            fill='var(--lp-w-bar)'
                        />
                        <rect
                            className='lp-w-land'
                            x='5'
                            y='37'
                            width='50'
                            height='5.5'
                            fill='var(--lp-info-bg)'
                            style={{ animationDelay: '-2.31s' }}
                        />
                        <rect
                            x='46'
                            y='38.3'
                            width='6'
                            height='3'
                            fill='var(--lp-info)'
                        />
                        <text
                            x='8.5'
                            y='41.3'
                            className='lp-mono'
                            fontSize='5'
                            fill='var(--lp-success)'
                        >
                            ✓
                        </text>
                    </g>
                    <path
                        d='M 477.0,992.0 L 400.8,1036.0 L 400.8,1045.0 L 477.0,1001.0 Z'
                        fill='var(--lp-w-slab-r)'
                        stroke='none'
                        strokeWidth='0.9'
                    />
                    <path
                        d='M 303.8,980.0 L 400.8,1036.0 L 400.8,1045.0 L 303.8,989.0 Z'
                        fill='var(--lp-w-slab-l)'
                        stroke='none'
                        strokeWidth='0.9'
                    />
                    <path
                        d='M 380.0,936.0 L 477.0,992.0 L 400.8,1036.0 L 303.8,980.0 Z'
                        fill='url(#lp-slabTop)'
                        stroke='var(--lp-w-slab-edge)'
                        strokeWidth='1'
                    />
                    <g transform='translate(-12 -6)'>
                    <path
                        d='M 426.8,971.0 L 378.3,999.0 L 378.3,1007.0 L 426.8,979.0 Z'
                        fill='var(--lp-w-box-r)'
                        stroke='none'
                        strokeWidth='0.9'
                    />
                    <path
                        d='M 329.8,971.0 L 378.3,999.0 L 378.3,1007.0 L 329.8,979.0 Z'
                        fill='var(--lp-w-box-l)'
                        stroke='none'
                        strokeWidth='0.9'
                    />
                    <path
                        d='M 378.3,943.0 L 426.8,971.0 L 378.3,999.0 L 329.8,971.0 Z'
                        fill='var(--lp-w-box-top)'
                        stroke='var(--lp-w-box-edge)'
                        strokeWidth='0.9'
                    />
                    {/* The schedule is a board with a body — a rail on the plinth, the
                        panel standing in it — so its lid and side edge read as thickness
                        instead of the whole thing reading as a sheet of paper. */}
                    <path
                        d='M 412.9,961.0 L 371.4,985.0 L 371.4,991.0 L 412.9,967.0 Z'
                        fill='var(--lp-w-box-r)'
                        stroke='none'
                        strokeWidth='0.9'
                    />
                    <path
                        d='M 359.2,978.0 L 371.4,985.0 L 371.4,991.0 L 359.2,984.0 Z'
                        fill='var(--lp-w-box-l)'
                        stroke='none'
                        strokeWidth='0.9'
                    />
                    <path
                        d='M 400.8,954.0 L 412.9,961.0 L 371.4,985.0 L 359.2,978.0 Z'
                        fill='var(--lp-w-box-top)'
                        stroke='var(--lp-w-box-edge)'
                        strokeWidth='0.9'
                    />
                    <path
                        d='M 364.4,933.0 L 369.6,936.0 L 369.6,982.0 L 364.4,979.0 Z'
                        fill='var(--lp-w-box-l)'
                        stroke='none'
                        strokeWidth='0.9'
                    />
                    <path
                        d='M 402.5,911.0 L 407.7,914.0 L 369.6,936.0 L 364.4,933.0 Z'
                        fill='var(--lp-w-box-top)'
                        stroke='var(--lp-w-box-edge)'
                        strokeWidth='0.9'
                    />
                    <path
                        d='M 407.7,914.0 L 369.6,936.0 L 369.6,982.0 L 407.7,960.0 Z'
                        fill='var(--lp-w-box-top)'
                        stroke='var(--lp-w-box-edge)'
                        strokeWidth='0.9'
                    />
                    <g transform='matrix(-0.866,0.5,0,1,407.7,914.0)'>
                        <rect x='0' y='0' width='44' height='8' fill='var(--lp-info)' />
                        <rect x='4.5' y='11' width='6' height='1.6' fill='var(--lp-w-bar)' />
                        <rect x='14.5' y='11' width='6' height='1.6' fill='var(--lp-w-bar)' />
                        <rect x='24.5' y='11' width='6' height='1.6' fill='var(--lp-w-bar)' />
                        <rect x='34.5' y='11' width='6' height='1.6' fill='var(--lp-w-bar)' />
                        <rect
                            x='4.5'
                            y='16'
                            width='6'
                            height='6'
                            rx='1.4'
                            fill='var(--lp-w-bar)'
                            opacity='0.5'
                        />
                        <rect
                            x='14.5'
                            y='16'
                            width='6'
                            height='6'
                            rx='1.4'
                            fill='var(--lp-w-bar)'
                            opacity='0.5'
                        />
                        <rect
                            x='24.5'
                            y='16'
                            width='6'
                            height='6'
                            rx='1.4'
                            fill='var(--lp-w-bar)'
                            opacity='0.5'
                        />
                        <rect
                            x='34.5'
                            y='16'
                            width='6'
                            height='6'
                            rx='1.4'
                            fill='var(--lp-w-bar)'
                            opacity='0.5'
                        />
                        <rect
                            x='4.5'
                            y='26'
                            width='6'
                            height='6'
                            rx='1.4'
                            fill='var(--lp-w-bar)'
                            opacity='0.5'
                        />
                        <rect
                            x='24.5'
                            y='26'
                            width='6'
                            height='6'
                            rx='1.4'
                            fill='var(--lp-info)'
                        />
                        <rect
                            x='34.5'
                            y='26'
                            width='6'
                            height='6'
                            rx='1.4'
                            fill='var(--lp-w-bar)'
                            opacity='0.5'
                        />
                        <rect
                            x='4.5'
                            y='36'
                            width='6'
                            height='6'
                            rx='1.4'
                            fill='var(--lp-w-bar)'
                            opacity='0.5'
                        />
                        <rect
                            x='14.5'
                            y='36'
                            width='6'
                            height='6'
                            rx='1.4'
                            fill='var(--lp-w-bar)'
                            opacity='0.5'
                        />
                        <rect
                            x='24.5'
                            y='36'
                            width='6'
                            height='6'
                            rx='1.4'
                            fill='var(--lp-w-bar)'
                            opacity='0.5'
                        />
                        <rect
                            x='34.5'
                            y='36'
                            width='6'
                            height='6'
                            rx='1.4'
                            fill='var(--lp-w-bar)'
                            opacity='0.5'
                        />
                        <text
                            x='17.5'
                            y='31.4'
                            className='lp-mono lp-w-land-in'
                            style={{ animationDelay: '-3.91s' }}
                            fontSize='6'
                            fill='var(--lp-success)'
                            textAnchor='middle'
                        >
                            ✓
                        </text>
                    </g>
                    </g>
                    {/* Annotations reveal only while the camera is on this plane; ScrollyStage drives the opacity. */}
                    <g data-notes='c' opacity='0'>
                    <path
                        d='M 512,835 L 512,812 L 524,812'
                        fill='none'
                        stroke='var(--lp-w-lead)'
                        strokeWidth='0.7'
                        opacity='0.45'
                    />
                    <text
                        x='529'
                        y='815'
                        fontSize='10.5'
                        fontWeight='500'
                        letterSpacing='0.005em'
                        fill='var(--lp-w-ground-lab)'
                        textAnchor='start'
                    >
                        {t('web.landing.worldSurfaceProduct')}
                    </text>
                    <text
                        className='lp-mono lp-w-sub'
                        x='550'
                        y='825'
                        fontSize='7.5'
                        letterSpacing='0.11em'
                        fill='var(--lp-w-ground-lab)'
                        opacity='0.62'
                        textAnchor='start'
                    >
                        {t('web.landing.worldSurfaceProductVia')}
                    </text>
                    <path
                        d='M 318,762 L 318,722 L 308,722'
                        fill='none'
                        stroke='var(--lp-w-lead)'
                        strokeWidth='0.7'
                        opacity='0.45'
                    />
                    <text
                        x='303'
                        y='725'
                        fontSize='10.5'
                        fontWeight='500'
                        letterSpacing='0.005em'
                        fill='var(--lp-w-ground-lab)'
                        textAnchor='end'
                    >
                        {t('web.landing.worldSurfaceChat')}
                    </text>
                    <text
                        className='lp-mono lp-w-sub'
                        x='297'
                        y='735'
                        fontSize='7.5'
                        letterSpacing='0.11em'
                        fill='var(--lp-w-ground-lab)'
                        opacity='0.62'
                        textAnchor='end'
                    >
                        {t('web.landing.worldSurfaceChatVia')}
                    </text>
                    <path
                        d='M 224,822 L 224,796 L 212,796'
                        fill='none'
                        stroke='var(--lp-w-lead)'
                        strokeWidth='0.7'
                        opacity='0.45'
                    />
                    <text
                        x='207'
                        y='799'
                        fontSize='10.5'
                        fontWeight='500'
                        letterSpacing='0.005em'
                        fill='var(--lp-w-ground-lab)'
                        textAnchor='end'
                    >
                        {t('web.landing.worldSurfaceTerminal')}
                    </text>
                    <text
                        className='lp-mono lp-w-sub'
                        x='181'
                        y='809'
                        fontSize='7.5'
                        letterSpacing='0.11em'
                        fill='var(--lp-w-ground-lab)'
                        opacity='0.62'
                        textAnchor='end'
                    >
                        {t('web.landing.worldSurfaceTerminalVia')}
                    </text>
                    <path
                        d='M 378,970 L 378,1012 L 398,1012'
                        fill='none'
                        stroke='var(--lp-w-lead)'
                        strokeWidth='0.7'
                        opacity='0.45'
                    />
                    <text
                        x='403'
                        y='1015'
                        fontSize='10.5'
                        fontWeight='500'
                        letterSpacing='0.005em'
                        fill='var(--lp-w-ground-lab)'
                        textAnchor='start'
                    >
                        {t('web.landing.worldSurfaceSchedule')}
                    </text>
                    <text
                        className='lp-mono lp-w-sub'
                        x='421'
                        y='1025'
                        fontSize='7.5'
                        letterSpacing='0.11em'
                        fill='var(--lp-w-ground-lab)'
                        opacity='0.62'
                        textAnchor='start'
                    >
                        {t('web.landing.worldSurfaceScheduleVia')}
                    </text>
                    </g>
                    <g data-layer-title='c' opacity='0'>
                    <text
                        transform='matrix(0.866,0.5,-0.866,0.5,179.1,974.0)'
                        textAnchor='middle'
                        fontSize='16'
                        fontWeight='650'
                        letterSpacing='-0.01em'
                        fill='var(--lp-ink-soft)'
                    >
                        {t('web.landing.worldGroundDelivery')}
                    </text>
                    </g>
                </g>
                <g className='lp-layer' ref={layers.gFlow}>
                    {/* Two soft lights down the trunk — one spilling from
                        under the control plane where the cable passes through
                        it, one hazing the cable itself — so the descent reads
                        as a length rather than as a band of constant value. */}
                    <ellipse
                        cx='378'
                        cy='684'
                        rx='46'
                        ry='17'
                        fill='url(#fx-halo)'
                    />
                    <ellipse
                        cx='378'
                        cy='742'
                        rx='27'
                        ry='88'
                        fill='url(#fx-haze)'
                    />
                    {TRUNK_LEGS.map((leg) => (
                        <FluxWire key={leg.id} leg={leg} w={leg.w} bloom={4.2} />
                    ))}
                    {FAN_LEGS.map((leg) => (
                        <FluxWire key={leg.id} leg={leg} w={1} bloom={3.6} />
                    ))}
                    {FAN_LEGS.map((leg) => (
                        <FluxPad
                            key={leg.id}
                            c={leg.pad}
                            begin={leg.begin + FAN * FAN_T}
                        />
                    ))}
                    {/* The junction the trunk lands on. A puck rather than a
                        box: everything else standing on a plate is a machine,
                        and this is a port. */}
                    <ellipse
                        cx='380'
                        cy='795'
                        rx='36'
                        ry='18'
                        fill='url(#fx-halo)'
                    />
                    <ellipse
                        cx='380'
                        cy='802'
                        rx='20'
                        ry='8.5'
                        fill='url(#fx-shade)'
                    />
                    <FluxRing
                        c={[380, 796.5]}
                        r0={7}
                        r1={30}
                        dur={BEAT}
                        begin={3.384}
                        peak={0.55}
                        op={0.5}
                        w={1.1}
                    />
                    <FluxRing
                        c={[380, 796.5]}
                        r0={7}
                        r1={22}
                        dur={BEAT}
                        begin={3.56}
                        peak={0.55}
                        op={0.3}
                        w={0.9}
                    />
                    <path
                        d='M 370,795.4 L 370,800.6 A 10,5.2 0 0 0 390,800.6 L 390,795.4 A 10,5.2 0 0 1 370,795.4 Z'
                        fill='var(--lp-w-box-r)'
                        stroke='var(--lp-w-box-edge)'
                        strokeWidth='0.9'
                    />
                    <ellipse
                        cx='380'
                        cy='795.4'
                        rx='10'
                        ry='5.2'
                        fill='var(--lp-w-box-top)'
                        stroke='var(--lp-w-box-edge)'
                        strokeWidth='0.9'
                    />
                    <ellipse
                        cx='380'
                        cy='794.6'
                        rx='5.6'
                        ry='2.9'
                        fill='var(--lp-w-flux)'
                    />
                    <ellipse
                        cx='380'
                        cy='794'
                        rx='2.4'
                        ry='1.25'
                        fill='var(--lp-w-flux-spec)'
                    />
                    {TRUNK_LEGS.map((leg) => (
                        <FluxPacket
                            key={leg.id}
                            d={leg.d}
                            dur={BAR}
                            begin={leg.begin}
                            travel={TRUNK_T}
                            hue={leg.hue}
                            r={leg.r}
                        />
                    ))}
                    {/* Below the control plane a run has been normalised, so
                        the fan-out carries the brand hue and not the framework
                        one the trunk still shows. */}
                    {FAN_LEGS.map((leg) => (
                        <FluxPacket
                            key={leg.id}
                            d={leg.d}
                            dur={FAN}
                            begin={leg.begin}
                            travel={FAN_T}
                            hue='i'
                            r={3.2}
                        />
                    ))}
                </g>
                <g className='lp-layer' ref={layers.gB}>
                    <path
                        d='M 639.8,570.0 L 414.7,700.0 L 414.7,711.0 L 639.8,581.0 Z'
                        fill='var(--lp-w-slab-r)'
                        stroke='none'
                        strokeWidth='0.9'
                    />
                    <path
                        d='M 120.2,530.0 L 414.7,700.0 L 414.7,711.0 L 120.2,541.0 Z'
                        fill='var(--lp-w-slab-l)'
                        stroke='none'
                        strokeWidth='0.9'
                    />
                    <path
                        d='M 345.4,400.0 L 639.8,570.0 L 414.7,700.0 L 120.2,530.0 Z'
                        fill='url(#lp-slabTop)'
                        stroke='var(--lp-w-slab-edge)'
                        strokeWidth='1'
                    />
                    <ellipse
                        cx='378'
                        cy='552'
                        rx='140'
                        ry='82'
                        fill='url(#lp-spill)'
                    />
                    <g transform='translate(611.2 0) scale(-1 1)'>
                    <path
                        d='M 303.8,432.0 L 279.6,446.0 L 279.6,486.0 L 303.8,472.0 Z'
                        fill='var(--lp-w-box-r)'
                        stroke='none'
                        strokeWidth='0.9'
                    />
                    <path
                        d='M 255.4,432.0 L 279.6,446.0 L 279.6,486.0 L 255.4,472.0 Z'
                        fill='var(--lp-w-box-l)'
                        stroke='none'
                        strokeWidth='0.9'
                    />
                    <path
                        d='M 279.6,418.0 L 303.8,432.0 L 279.6,446.0 L 255.4,432.0 Z'
                        fill='var(--lp-w-box-top)'
                        stroke='var(--lp-w-box-edge)'
                        strokeWidth='0.9'
                    />
                    <line
                        x1='258.1'
                        y1='466.9'
                        x2='276.8'
                        y2='477.7'
                        stroke='var(--lp-w-box-edge)'
                        strokeWidth='0.8'
                    />
                    <line
                        x1='263.7'
                        y1='473.9'
                        x2='271.2'
                        y2='478.3'
                        stroke='var(--lp-w-lead-dot)'
                        strokeWidth='1.6'
                        strokeLinecap='round'
                    />
                    <line
                        x1='258.1'
                        y1='453.6'
                        x2='276.8'
                        y2='464.4'
                        stroke='var(--lp-w-box-edge)'
                        strokeWidth='0.8'
                    />
                    <line
                        x1='263.7'
                        y1='460.5'
                        x2='271.2'
                        y2='464.9'
                        stroke='var(--lp-w-lead-dot)'
                        strokeWidth='1.6'
                        strokeLinecap='round'
                    />
                    <line
                        x1='258.1'
                        y1='440.3'
                        x2='276.8'
                        y2='451.1'
                        stroke='var(--lp-w-box-edge)'
                        strokeWidth='0.8'
                    />
                    <line
                        x1='263.7'
                        y1='447.2'
                        x2='271.2'
                        y2='451.6'
                        stroke='var(--lp-w-lead-dot)'
                        strokeWidth='1.6'
                        strokeLinecap='round'
                    />
                    </g>
                    <g transform='translate(611.2 0) scale(-1 1)'>
                    <path
                        d='M 329.8,447.0 L 305.6,461.0 L 305.6,501.0 L 329.8,487.0 Z'
                        fill='var(--lp-w-box-r)'
                        stroke='none'
                        strokeWidth='0.9'
                    />
                    <path
                        d='M 281.4,447.0 L 305.6,461.0 L 305.6,501.0 L 281.4,487.0 Z'
                        fill='var(--lp-w-box-l)'
                        stroke='none'
                        strokeWidth='0.9'
                    />
                    <path
                        d='M 305.6,433.0 L 329.8,447.0 L 305.6,461.0 L 281.4,447.0 Z'
                        fill='var(--lp-w-box-top)'
                        stroke='var(--lp-w-box-edge)'
                        strokeWidth='0.9'
                    />
                    <line
                        x1='284.1'
                        y1='481.9'
                        x2='302.8'
                        y2='492.7'
                        stroke='var(--lp-w-box-edge)'
                        strokeWidth='0.8'
                    />
                    <line
                        x1='289.7'
                        y1='488.9'
                        x2='297.2'
                        y2='493.3'
                        stroke='var(--lp-w-lead-dot)'
                        strokeWidth='1.6'
                        strokeLinecap='round'
                    />
                    <line
                        x1='284.1'
                        y1='468.6'
                        x2='302.8'
                        y2='479.4'
                        stroke='var(--lp-w-box-edge)'
                        strokeWidth='0.8'
                    />
                    <line
                        x1='289.7'
                        y1='475.5'
                        x2='297.2'
                        y2='479.9'
                        stroke='var(--lp-w-lead-dot)'
                        strokeWidth='1.6'
                        strokeLinecap='round'
                    />
                    <line
                        x1='284.1'
                        y1='455.3'
                        x2='302.8'
                        y2='466.1'
                        stroke='var(--lp-w-box-edge)'
                        strokeWidth='0.8'
                    />
                    <line
                        x1='289.7'
                        y1='462.2'
                        x2='297.2'
                        y2='466.6'
                        stroke='var(--lp-w-lead-dot)'
                        strokeWidth='1.6'
                        strokeLinecap='round'
                    />
                    </g>
                    <g transform='translate(611.2 0) scale(-1 1)'>
                    <path
                        d='M 355.7,462.0 L 331.5,476.0 L 331.5,516.0 L 355.7,502.0 Z'
                        fill='var(--lp-w-box-r)'
                        stroke='none'
                        strokeWidth='0.9'
                    />
                    <path
                        d='M 307.3,462.0 L 331.5,476.0 L 331.5,516.0 L 307.3,502.0 Z'
                        fill='var(--lp-w-box-l)'
                        stroke='none'
                        strokeWidth='0.9'
                    />
                    <path
                        d='M 331.5,448.0 L 355.7,462.0 L 331.5,476.0 L 307.3,462.0 Z'
                        fill='var(--lp-w-box-top)'
                        stroke='var(--lp-w-box-edge)'
                        strokeWidth='0.9'
                    />
                    <line
                        x1='310.1'
                        y1='496.9'
                        x2='328.7'
                        y2='507.6'
                        stroke='var(--lp-w-box-edge)'
                        strokeWidth='0.8'
                    />
                    <line
                        x1='315.7'
                        y1='503.9'
                        x2='323.1'
                        y2='508.2'
                        stroke='var(--lp-w-lead-dot)'
                        strokeWidth='1.6'
                        strokeLinecap='round'
                    />
                    <line
                        x1='310.1'
                        y1='483.6'
                        x2='328.7'
                        y2='494.3'
                        stroke='var(--lp-w-box-edge)'
                        strokeWidth='0.8'
                    />
                    <line
                        x1='315.7'
                        y1='490.5'
                        x2='323.1'
                        y2='494.8'
                        stroke='var(--lp-w-lead-dot)'
                        strokeWidth='1.6'
                        strokeLinecap='round'
                    />
                    <line
                        x1='310.1'
                        y1='470.3'
                        x2='328.7'
                        y2='481.0'
                        stroke='var(--lp-w-box-edge)'
                        strokeWidth='0.8'
                    />
                    <line
                        x1='315.7'
                        y1='477.2'
                        x2='323.1'
                        y2='481.5'
                        stroke='var(--lp-w-lead-dot)'
                        strokeWidth='1.6'
                        strokeLinecap='round'
                    />
                    </g>
                    <path
                        d='M 241.5,524.0 L 199.9,548.0 L 199.9,554.0 L 241.5,530.0 Z'
                        fill='var(--lp-w-box-r)'
                        stroke='none'
                        strokeWidth='0.9'
                    />
                    <path
                        d='M 158.3,524.0 L 199.9,548.0 L 199.9,554.0 L 158.3,530.0 Z'
                        fill='var(--lp-w-box-l)'
                        stroke='none'
                        strokeWidth='0.9'
                    />
                    <path
                        d='M 199.9,500.0 L 241.5,524.0 L 199.9,548.0 L 158.3,524.0 Z'
                        fill='var(--lp-w-box-top)'
                        stroke='var(--lp-w-box-edge)'
                        strokeWidth='0.9'
                    />
                    <Toolbox x={199.9} y={524} />
                    <path
                        d='M 421.6,494.0 L 373.1,522.0 L 373.1,580.0 L 421.6,552.0 Z'
                        fill='var(--lp-w-box-r)'
                        stroke='none'
                        strokeWidth='0.9'
                    />
                    <path
                        d='M 324.6,494.0 L 373.1,522.0 L 373.1,580.0 L 324.6,552.0 Z'
                        fill='var(--lp-w-box-l)'
                        stroke='none'
                        strokeWidth='0.9'
                    />
                    <path
                        d='M 373.1,466.0 L 421.6,494.0 L 373.1,522.0 L 324.6,494.0 Z'
                        fill='var(--lp-w-box-accent)'
                        stroke='var(--lp-w-box-edge)'
                        strokeWidth='0.9'
                    />
                    <circle
                        cx='373.9'
                        cy='487.9'
                        r='26'
                        fill='var(--lp-info)'
                        opacity='var(--lp-w-glow-opacity)'
                        filter='url(#lp-blur)'
                    />
                    {/* The mark is painted on the cube's left face, not on a
                        tile floating above it: a framed badge reads as a
                        sticker laid on the drawing, a mark on a face belongs
                        to the body. The matrix is that face's own axes —
                        horizontal (0.866, 0.5), vertical (0, 1) — so the logo
                        lies in the isometric plane instead of facing the
                        viewer. Two weights of one colour, the way BrandMark
                        is drawn everywhere else; --lp-info already carries the
                        per-theme step, so it reads on both faces.
                        Sized and centred on the mark's ink box (x 10→122.5,
                        y 15→80 of the 135×100 viewBox), not on the viewBox —
                        the glyph only fills 83% × 65% of it, so centring on
                        the box lands it high and reads a size too small. */}
                    <g
                        transform='matrix(0.866,0.5,0,1,327.7,505.5) scale(0.368)'
                        fill='var(--lp-info)'
                    >
                        <polygon points='10,80 35,15 47.5,15 22.5,80' />
                        <polygon
                            points='35,15 60,80 47.5,15 72.5,80'
                            opacity='0.45'
                        />
                        <polygon points='60,80 85,15 72.5,80 97.5,15' />
                        <polygon
                            points='85,15 110,80 97.5,15 122.5,80'
                            opacity='0.45'
                        />
                    </g>
                    <path
                        d='M 530.7,549.0 L 487.4,574.0 L 487.4,618.0 L 530.7,593.0 Z'
                        fill='var(--lp-w-box-r)'
                        stroke='none'
                        strokeWidth='0.9'
                    />
                    <path
                        d='M 444.1,549.0 L 487.4,574.0 L 487.4,618.0 L 444.1,593.0 Z'
                        fill='var(--lp-w-box-l)'
                        stroke='none'
                        strokeWidth='0.9'
                    />
                    <path
                        d='M 487.4,524.0 L 530.7,549.0 L 487.4,574.0 L 444.1,549.0 Z'
                        fill='var(--lp-w-box-top)'
                        stroke='var(--lp-w-box-edge)'
                        strokeWidth='0.9'
                    />
                    <line
                        x1='527.0'
                        y1='587.2'
                        x2='491.1'
                        y2='607.8'
                        stroke='var(--lp-w-box-edge)'
                        strokeWidth='0.8'
                    />
                    <circle
                        className='lp-w-led'
                        style={{ animationDelay: '0.0s' }}
                        cx='495.3'
                        cy='601.7'
                        r='1.6'
                        fill='var(--lp-info)'
                    />
                    <line
                        x1='527.0'
                        y1='578.2'
                        x2='491.1'
                        y2='598.8'
                        stroke='var(--lp-w-box-edge)'
                        strokeWidth='0.8'
                    />
                    <circle
                        className='lp-w-led'
                        style={{ animationDelay: '-0.9s' }}
                        cx='495.3'
                        cy='592.7'
                        r='1.6'
                        fill='var(--lp-success)'
                    />
                    <line
                        x1='527.0'
                        y1='569.2'
                        x2='491.1'
                        y2='589.8'
                        stroke='var(--lp-w-box-edge)'
                        strokeWidth='0.8'
                    />
                    <circle
                        className='lp-w-led'
                        style={{ animationDelay: '-1.8s' }}
                        cx='495.3'
                        cy='583.7'
                        r='1.6'
                        fill='var(--lp-success)'
                    />
                    <line
                        x1='527.0'
                        y1='560.2'
                        x2='491.1'
                        y2='580.8'
                        stroke='var(--lp-w-box-edge)'
                        strokeWidth='0.8'
                    />
                    <circle
                        className='lp-w-led'
                        style={{ animationDelay: '-2.7s' }}
                        cx='495.3'
                        cy='574.7'
                        r='1.6'
                        fill='var(--lp-success)'
                    />
                    <path
                        d='M 355.8,573.0 L 310.8,599.0 L 310.8,608.0 L 355.8,582.0 Z'
                        fill='var(--lp-w-box-r)'
                        stroke='none'
                        strokeWidth='0.9'
                    />
                    <path
                        d='M 245.0,561.0 L 310.8,599.0 L 310.8,608.0 L 245.0,570.0 Z'
                        fill='var(--lp-w-box-l)'
                        stroke='none'
                        strokeWidth='0.9'
                    />
                    <path
                        d='M 290.0,535.0 L 355.8,573.0 L 310.8,599.0 L 245.0,561.0 Z'
                        fill='var(--lp-w-box-top)'
                        stroke='var(--lp-w-box-edge)'
                        strokeWidth='0.9'
                    />
                    <line
                        x1='271.7'
                        y1='554.3'
                        x2='300.5'
                        y2='555.7'
                        stroke='var(--lp-w-lead)'
                        strokeWidth='1'
                        opacity='0.6'
                    />
                    <line
                        x1='300.5'
                        y1='555.7'
                        x2='296.9'
                        y2='576.5'
                        stroke='var(--lp-w-lead)'
                        strokeWidth='1'
                        opacity='0.6'
                    />
                    <line
                        x1='296.9'
                        y1='576.5'
                        x2='330.1'
                        y2='576.6'
                        stroke='var(--lp-w-lead)'
                        strokeWidth='1'
                        opacity='0.6'
                    />
                    <circle
                        cx='271.7'
                        cy='554.3'
                        r='4.4'
                        fill='var(--lp-w-c1)'
                        stroke='var(--lp-w-box-top)'
                        strokeWidth='1.1'
                    />
                    <circle
                        cx='300.5'
                        cy='555.7'
                        r='4.4'
                        fill='var(--lp-w-c2)'
                        stroke='var(--lp-w-box-top)'
                        strokeWidth='1.1'
                    />
                    <circle
                        cx='296.9'
                        cy='576.5'
                        r='4.4'
                        fill='var(--lp-w-c3)'
                        stroke='var(--lp-w-box-top)'
                        strokeWidth='1.1'
                    />
                    <circle
                        cx='330.1'
                        cy='576.6'
                        r='4.4'
                        fill='var(--lp-w-c4)'
                        stroke='var(--lp-w-box-top)'
                        strokeWidth='1.1'
                    />
                    <circle r='2.4' fill='var(--lp-info)' opacity='0'>
                        <animate
                            attributeName='opacity'
                            values='0;1;0'
                            dur='2.4s'
                            begin='0.0s'
                            repeatCount='indefinite'
                        />
                        <animate
                            attributeName='cx'
                            values='271.7;300.5'
                            dur='2.4s'
                            begin='0.0s'
                            repeatCount='indefinite'
                        />
                        <animate
                            attributeName='cy'
                            values='554.3;555.7'
                            dur='2.4s'
                            begin='0.0s'
                            repeatCount='indefinite'
                        />
                    </circle>
                    <circle r='2.4' fill='var(--lp-info)' opacity='0'>
                        <animate
                            attributeName='opacity'
                            values='0;1;0'
                            dur='2.4s'
                            begin='0.5s'
                            repeatCount='indefinite'
                        />
                        <animate
                            attributeName='cx'
                            values='300.5;296.9'
                            dur='2.4s'
                            begin='0.5s'
                            repeatCount='indefinite'
                        />
                        <animate
                            attributeName='cy'
                            values='555.7;576.5'
                            dur='2.4s'
                            begin='0.5s'
                            repeatCount='indefinite'
                        />
                    </circle>
                    <circle r='2.4' fill='var(--lp-info)' opacity='0'>
                        <animate
                            attributeName='opacity'
                            values='0;1;0'
                            dur='2.4s'
                            begin='1.0s'
                            repeatCount='indefinite'
                        />
                        <animate
                            attributeName='cx'
                            values='296.9;330.1'
                            dur='2.4s'
                            begin='1.0s'
                            repeatCount='indefinite'
                        />
                        <animate
                            attributeName='cy'
                            values='576.5;576.6'
                            dur='2.4s'
                            begin='1.0s'
                            repeatCount='indefinite'
                        />
                    </circle>
                    <g transform='translate(38 0)'>
                    <path
                        d='M 425.1,644.0 L 378.3,671.0 L 378.3,683.0 L 425.1,656.0 Z'
                        fill='var(--lp-w-box-r)'
                        stroke='none'
                        strokeWidth='0.9'
                    />
                    <path
                        d='M 331.5,644.0 L 378.3,671.0 L 378.3,683.0 L 331.5,656.0 Z'
                        fill='var(--lp-w-box-l)'
                        stroke='none'
                        strokeWidth='0.9'
                    />
                    <path
                        d='M 378.3,617.0 L 425.1,644.0 L 378.3,671.0 L 331.5,644.0 Z'
                        fill='var(--lp-w-box-top)'
                        stroke='var(--lp-w-box-edge)'
                        strokeWidth='0.9'
                    />
                    {/* Usage lives on a board with a body: a base rail on the plinth and a
                        panel standing in it, so its lid and side edge carry the depth. */}
                    <path
                        d='M 412.9,635.0 L 373.1,658.0 L 373.1,664.0 L 412.9,641.0 Z'
                        fill='var(--lp-w-box-r)'
                        stroke='none'
                        strokeWidth='0.9'
                    />
                    <path
                        d='M 361.0,651.0 L 373.1,658.0 L 373.1,664.0 L 361.0,657.0 Z'
                        fill='var(--lp-w-box-l)'
                        stroke='none'
                        strokeWidth='0.9'
                    />
                    <path
                        d='M 400.8,628.0 L 412.9,635.0 L 373.1,658.0 L 361.0,651.0 Z'
                        fill='var(--lp-w-box-top)'
                        stroke='var(--lp-w-box-edge)'
                        strokeWidth='0.9'
                    />
                    <path
                        d='M 369.6,616.0 L 374.8,619.0 L 374.8,659.0 L 369.6,656.0 Z'
                        fill='var(--lp-w-box-l)'
                        stroke='none'
                        strokeWidth='0.9'
                    />
                    <path
                        d='M 409.5,593.0 L 414.7,596.0 L 374.8,619.0 L 369.6,616.0 Z'
                        fill='var(--lp-w-box-top)'
                        stroke='var(--lp-w-box-edge)'
                        strokeWidth='0.9'
                    />
                    <path
                        d='M 414.7,596.0 L 374.8,619.0 L 374.8,659.0 L 414.7,636.0 Z'
                        fill='var(--lp-w-screen)'
                        stroke='var(--lp-w-box-edge)'
                        strokeWidth='0.9'
                    />
                    <g transform='matrix(-0.866,0.5,0,1,414.7,596.0)'>
                        <rect x='4' y='4' width='24' height='3' fill='var(--lp-w-bar)' />
                        <text
                            x='42'
                            y='10'
                            className='lp-mono'
                            fontSize='9'
                            fontWeight='600'
                            fill='var(--lp-info)'
                            textAnchor='end'
                        >
                            $
                        </text>
                        <rect x='7' y='23' width='5' height='10' fill='var(--lp-w-bar)' />
                        <rect x='15' y='17' width='5' height='16' fill='var(--lp-w-bar)' />
                        <rect x='23' y='20' width='5' height='13' fill='var(--lp-w-bar)' />
                        <rect
                        className='lp-w-meter'
                        x='31'
                        y='12'
                        width='5'
                        height='21'
                        fill='var(--lp-info)'
                    />
                        <rect x='4' y='33' width='36' height='1' fill='var(--lp-w-bar)' />
                    </g>
                    </g>
                    {/* Annotations reveal only while the camera is on this plane; ScrollyStage drives the opacity. */}
                    <g data-notes='b' opacity='0'>
                    <path
                        d='M 267,458 L 267,424 L 257,424'
                        fill='none'
                        stroke='var(--lp-w-lead)'
                        strokeWidth='0.7'
                        opacity='0.45'
                    />
                    <text
                        x='252'
                        y='427'
                        fontSize='10.5'
                        fontWeight='500'
                        letterSpacing='0.005em'
                        fill='var(--lp-w-ground-lab)'
                        textAnchor='end'
                    >
                        {t('web.landing.worldPlaneSessions')}
                    </text>
                    <path
                        d='M 518,543 L 518,516 L 530,516'
                        fill='none'
                        stroke='var(--lp-w-lead)'
                        strokeWidth='0.7'
                        opacity='0.45'
                    />
                    <text
                        x='535'
                        y='519'
                        fontSize='10.5'
                        fontWeight='500'
                        letterSpacing='0.005em'
                        fill='var(--lp-w-ground-lab)'
                        textAnchor='start'
                    >
                        {t('web.landing.worldPlaneModels')}
                    </text>
                    <path
                        d='M 182,507 L 182,572 L 172,572'
                        fill='none'
                        stroke='var(--lp-w-lead)'
                        strokeWidth='0.7'
                        opacity='0.45'
                    />
                    <text
                        x='167'
                        y='575'
                        fontSize='10.5'
                        fontWeight='500'
                        letterSpacing='0.005em'
                        fill='var(--lp-w-ground-lab)'
                        textAnchor='end'
                    >
                        {t('web.landing.worldPlaneSkills')}
                    </text>
                    <path
                        d='M 430,645 L 430,668 L 440,668'
                        fill='none'
                        stroke='var(--lp-w-lead)'
                        strokeWidth='0.7'
                        opacity='0.45'
                    />
                    <text
                        x='445'
                        y='671'
                        fontSize='10.5'
                        fontWeight='500'
                        letterSpacing='0.005em'
                        fill='var(--lp-w-ground-lab)'
                        textAnchor='start'
                    >
                        {t('web.landing.worldPlaneUsage')}
                    </text>
                    <path
                        d='M 415,505 L 415,484 L 427,484'
                        fill='none'
                        stroke='var(--lp-w-lead)'
                        strokeWidth='0.7'
                        opacity='0.45'
                    />
                    <text
                        x='432'
                        y='487'
                        fontSize='10.5'
                        fontWeight='500'
                        letterSpacing='0.005em'
                        fill='var(--lp-w-ground-lab)'
                        textAnchor='start'
                    >
                        {t('web.landing.worldPlaneOrchestration')}
                    </text>
                    <text
                        className='lp-mono lp-w-sub'
                        x='445'
                        y='497'
                        fontSize='7.5'
                        letterSpacing='0.11em'
                        fill='var(--lp-w-ground-lab)'
                        opacity='0.62'
                        textAnchor='start'
                    >
                        {t('web.landing.worldPlaneOrchestrationSub')}
                    </text>
                    </g>
                    <g data-layer-title='b' opacity='0'>
                    <text
                        transform='matrix(0.866,0.5,-0.866,0.5,179.1,614.0)'
                        textAnchor='middle'
                        fontSize='16'
                        fontWeight='650'
                        letterSpacing='-0.01em'
                        fill='var(--lp-info)'
                    >
                        {t('web.landing.worldGroundPlane')}
                    </text>
                    </g>
                </g>
                <g className='lp-layer' ref={layers.gFeed}>
                    {/* Light leaking from under each agent plate, where its
                        wire passes through. The wire starts above the plate
                        and is hidden by it, so without the spill it would
                        appear to begin in mid-air. */}
                    {FEED_LEGS.map((leg) => (
                        <ellipse
                            key={leg.id}
                            cx={leg.spill[0]}
                            cy={leg.spill[1]}
                            rx='24'
                            ry='10'
                            fill='url(#fx-halo)'
                        />
                    ))}
                    {FEED_LEGS.map((leg) => (
                        <FluxWire key={leg.id} leg={leg} w={1.05} bloom={3.8} />
                    ))}
                    {/* The port on the Manyfold cube's own top face: where
                        every framework's run arrives and stops being a
                        framework's run. The ring ratio is the cube face's, so
                        the ripple travels across it in plane. */}
                    <ellipse
                        cx='373.1'
                        cy='494'
                        rx='24'
                        ry='13.5'
                        fill='url(#fx-halo)'
                    />
                    <FluxRing
                        c={[373.1, 494]}
                        r0={8}
                        r1={30}
                        dur={1.2}
                        begin={2.16}
                        peak={0.62}
                        op={0.42}
                        w={1}
                    />
                    <FluxRing
                        c={[373.1, 494]}
                        r0={8}
                        r1={24}
                        dur={1.2}
                        begin={2.34}
                        peak={0.62}
                        op={0.26}
                        w={0.85}
                    />
                    <ellipse
                        cx='373.1'
                        cy='494'
                        rx='7'
                        ry='4'
                        fill='var(--lp-w-flux)'
                        opacity='0.9'
                    />
                    <ellipse
                        cx='373.1'
                        cy='493.4'
                        rx='3'
                        ry='1.7'
                        fill='var(--lp-w-flux-spec)'
                    />
                    {FEED_LEGS.map((leg, i) => (
                        <FluxPacket
                            key={leg.id}
                            d={leg.d}
                            dur={BAR}
                            begin={i * 1.2}
                            travel={FEED_T}
                            hue={leg.hue}
                            r={3.4}
                        />
                    ))}
                </g>
                <g
                    className='lp-layer'
                    ref={layers.gA}
                    transform='translate(0 32)'
                >
                    <path
                        d='M 477.0,136.0 L 340.2,215.0 L 340.2,224.0 L 477.0,145.0 Z'
                        fill='var(--lp-w-slab-r)'
                        stroke='none'
                        strokeWidth='0.9'
                    />
                    <path
                        d='M 212.0,141.0 L 340.2,215.0 L 340.2,224.0 L 212.0,150.0 Z'
                        fill='var(--lp-w-slab-l)'
                        stroke='none'
                        strokeWidth='0.9'
                    />
                    <path
                        d='M 348.9,62.0 L 477.0,136.0 L 340.2,215.0 L 212.0,141.0 Z'
                        fill='url(#lp-slabTop)'
                        stroke='var(--lp-w-slab-edge)'
                        strokeWidth='1'
                    />
                    <Workstation
                        x={343.7}
                        y={64}
                        Logo={ClaudeCodeColor}
                        beat={0}
                    />
                    <Workstation x={407.8} y={95} Logo={CodexColor} beat={3} />
                    <Workstation
                        x={284.8}
                        y={98}
                        Logo={GeminiCLIColor}
                        beat={5}
                    />
                    <Workstation
                        x={348.9}
                        y={129}
                        Logo={OpenClawColor}
                        beat={1}
                    />
                    <path
                        d='M 307.3,210.0 L 236.3,251.0 L 236.3,260.0 L 307.3,219.0 Z'
                        fill='var(--lp-w-slab-r)'
                        stroke='none'
                        strokeWidth='0.9'
                    />
                    <path
                        d='M 130.6,190.0 L 236.3,251.0 L 236.3,260.0 L 130.6,199.0 Z'
                        fill='var(--lp-w-slab-l)'
                        stroke='none'
                        strokeWidth='0.9'
                    />
                    <path
                        d='M 201.6,149.0 L 307.3,210.0 L 236.3,251.0 L 130.6,190.0 Z'
                        fill='url(#lp-slabTop)'
                        stroke='var(--lp-w-slab-edge)'
                        strokeWidth='1'
                    />
                    <Workstation
                        x={199.9}
                        y={151}
                        Logo={HermesAgentMono}
                        mono
                        size={63}
                        scale={0.95}
                        beat={4}
                    />
                    <path
                        d='M 204.2,195.5 L 192.1,202.5 L 192.1,205.5 L 204.2,198.5 Z'
                        fill='var(--lp-w-box-r)'
                        stroke='none'
                        strokeWidth='0.9'
                    />
                    <path
                        d='M 155.7,181.5 L 192.1,202.5 L 192.1,205.5 L 155.7,184.5 Z'
                        fill='var(--lp-w-box-l)'
                        stroke='none'
                        strokeWidth='0.9'
                    />
                    <path
                        d='M 167.9,174.5 L 204.2,195.5 L 192.1,202.5 L 155.7,181.5 Z'
                        fill='var(--lp-w-box-top)'
                        stroke='var(--lp-w-box-edge)'
                        strokeWidth='0.9'
                    />
                    <path
                        d='M 253.6,215.0 L 241.5,222.0 L 241.5,232.0 L 253.6,225.0 Z'
                        fill='var(--lp-w-box-r)'
                        stroke='none'
                        strokeWidth='0.9'
                    />
                    <path
                        d='M 229.4,215.0 L 241.5,222.0 L 241.5,232.0 L 229.4,225.0 Z'
                        fill='var(--lp-w-box-l)'
                        stroke='none'
                        strokeWidth='0.9'
                    />
                    <path
                        d='M 241.5,208.0 L 253.6,215.0 L 241.5,222.0 L 229.4,215.0 Z'
                        fill='var(--lp-w-box-top)'
                        stroke='var(--lp-w-box-edge)'
                        strokeWidth='0.9'
                    />
                    <circle
                        cx='241.5'
                        cy='208.0'
                        r='7'
                        fill='var(--lp-w-box-top)'
                        stroke='var(--lp-w-box-edge)'
                        strokeWidth='0.9'
                    />
                    <path
                        d='M 626.0,224.0 L 535.9,276.0 L 535.9,285.0 L 626.0,233.0 Z'
                        fill='var(--lp-w-slab-r)'
                        stroke='none'
                        strokeWidth='0.9'
                    />
                    <path
                        d='M 414.7,206.0 L 535.9,276.0 L 535.9,285.0 L 414.7,215.0 Z'
                        fill='var(--lp-w-slab-l)'
                        stroke='none'
                        strokeWidth='0.9'
                    />
                    <path
                        d='M 504.7,154.0 L 626.0,224.0 L 535.9,276.0 L 414.7,206.0 Z'
                        fill='url(#lp-slabTop)'
                        stroke='var(--lp-w-slab-edge)'
                        strokeWidth='1'
                    />
                    <path
                        d='M 544.6,127.0 L 506.5,149.0 L 506.5,211.0 L 544.6,189.0 Z'
                        fill='var(--lp-w-box-r)'
                        stroke='none'
                        strokeWidth='0.9'
                    />
                    <path
                        d='M 468.4,127.0 L 506.5,149.0 L 506.5,211.0 L 468.4,189.0 Z'
                        fill='var(--lp-w-box-l)'
                        stroke='none'
                        strokeWidth='0.9'
                    />
                    <path
                        d='M 506.5,105.0 L 544.6,127.0 L 506.5,149.0 L 468.4,127.0 Z'
                        fill='var(--lp-w-box-top)'
                        stroke='var(--lp-w-box-edge)'
                        strokeWidth='0.9'
                    />
                    <line
                        x1='470.0'
                        y1='176.4'
                        x2='503.6'
                        y2='195.8'
                        stroke='var(--lp-w-box-edge)'
                        strokeWidth='0.8'
                    />
                    <circle
                        cx='499.5'
                        cy='190.2'
                        r='1.5'
                        fill='var(--lp-success)'
                    />
                    <line
                        x1='470.0'
                        y1='167.4'
                        x2='503.6'
                        y2='186.8'
                        stroke='var(--lp-w-box-edge)'
                        strokeWidth='0.8'
                    />
                    <circle
                        cx='499.5'
                        cy='181.2'
                        r='1.5'
                        fill='var(--lp-success)'
                    />
                    <line
                        x1='470.0'
                        y1='158.4'
                        x2='503.6'
                        y2='177.8'
                        stroke='var(--lp-w-box-edge)'
                        strokeWidth='0.8'
                    />
                    <circle
                        cx='499.5'
                        cy='172.2'
                        r='1.5'
                        fill='var(--lp-success)'
                    />
                    <line
                        x1='470.0'
                        y1='149.4'
                        x2='503.6'
                        y2='168.8'
                        stroke='var(--lp-w-box-edge)'
                        strokeWidth='0.8'
                    />
                    <circle
                        cx='499.5'
                        cy='163.2'
                        r='1.5'
                        fill='var(--lp-success)'
                    />
                    <line
                        x1='470.0'
                        y1='140.4'
                        x2='503.6'
                        y2='159.8'
                        stroke='var(--lp-w-box-edge)'
                        strokeWidth='0.8'
                    />
                    <circle
                        cx='499.5'
                        cy='154.2'
                        r='1.5'
                        fill='var(--lp-success)'
                    />
                    <Workstation
                        x={537.7}
                        y={182}
                        Logo={DifyColor}
                        flip
                        scale={1.0}
                        beat={2}
                    />
                    <path
                        d='M 499.5,299.0 L 412.9,349.0 L 412.9,358.0 L 499.5,308.0 Z'
                        fill='var(--lp-w-slab-r)'
                        stroke='none'
                        strokeWidth='0.9'
                    />
                    <path
                        d='M 284.8,275.0 L 412.9,349.0 L 412.9,358.0 L 284.8,284.0 Z'
                        fill='var(--lp-w-slab-l)'
                        stroke='none'
                        strokeWidth='0.9'
                    />
                    <path
                        d='M 371.4,225.0 L 499.5,299.0 L 412.9,349.0 L 284.8,275.0 Z'
                        fill='url(#lp-slabTop)'
                        stroke='var(--lp-w-slab-edge)'
                        strokeWidth='1'
                    />
                    <Workstation
                        x={376.6}
                        y={227}
                        Logo={ClaudeCodeColor}
                        flip
                        beat={6}
                    />
                    <path
                        d='M 452.8,298.0 L 423.3,315.0 L 423.3,325.0 L 452.8,308.0 Z'
                        fill='var(--lp-w-box-r)'
                        stroke='none'
                        strokeWidth='0.9'
                    />
                    <path
                        d='M 385.2,293.0 L 423.3,315.0 L 423.3,325.0 L 385.2,303.0 Z'
                        fill='var(--lp-w-box-l)'
                        stroke='none'
                        strokeWidth='0.9'
                    />
                    <path
                        d='M 414.7,276.0 L 452.8,298.0 L 423.3,315.0 L 385.2,293.0 Z'
                        fill='var(--lp-w-box-top)'
                        stroke='var(--lp-w-box-edge)'
                        strokeWidth='0.9'
                    />
                    <path
                        d='M 390.4,296.0 L 397.4,300.0 L 397.4,284.0 L 390.4,280.0 Z'
                        fill='var(--lp-w-socket)'
                        stroke='var(--lp-w-box-edge)'
                        strokeWidth='0.9'
                    />
                    <circle
                        cx='394.2'
                        cy='287.8'
                        r='1.7'
                        fill='var(--lp-w-c4)'
                    />
                    <path
                        d='M 401.7,302.5 L 408.6,306.5 L 408.6,290.5 L 401.7,286.5 Z'
                        fill='var(--lp-w-socket)'
                        stroke='var(--lp-w-box-edge)'
                        strokeWidth='0.9'
                    />
                    <circle
                        cx='405.5'
                        cy='294.3'
                        r='1.7'
                        fill='var(--lp-w-ghost)'
                    />
                    <path
                        d='M 412.9,309.0 L 419.9,313.0 L 419.9,297.0 L 412.9,293.0 Z'
                        fill='var(--lp-w-socket)'
                        stroke='var(--lp-w-box-edge)'
                        strokeWidth='0.9'
                    />
                    <circle
                        cx='416.8'
                        cy='300.8'
                        r='1.7'
                        fill='var(--lp-w-ghost)'
                    />
                    <line
                        x1='387.0'
                        y1='274.0'
                        x2='400.8'
                        y2='282.0'
                        stroke='var(--lp-w-c4)'
                        strokeWidth='2'
                        strokeLinecap='round'
                    />
                    {/* Annotations reveal only while the camera is on this plane; ScrollyStage drives the opacity. */}
                    <g data-notes='a' opacity='0'>
                    <path
                        d='M 338,72 L 338,46 L 328,46'
                        fill='none'
                        stroke='var(--lp-w-lead)'
                        strokeWidth='0.7'
                        opacity='0.45'
                    />
                    <text
                        x='323'
                        y='49'
                        fontSize='10.5'
                        fontWeight='500'
                        letterSpacing='0.005em'
                        fill='var(--lp-w-ground-lab)'
                        textAnchor='end'
                    >
                        {t('web.landing.worldRuntimeSandbox')}
                    </text>
                    <text
                        className='lp-mono lp-w-sub'
                        x='310'
                        y='59'
                        fontSize='7.5'
                        letterSpacing='0.11em'
                        fill='var(--lp-w-ground-lab)'
                        opacity='0.62'
                        textAnchor='end'
                    >
                        {t('web.landing.worldRuntimeSandboxSub')}
                    </text>
                    <path
                        d='M 536,127 L 536,58 L 526,58'
                        fill='none'
                        stroke='var(--lp-w-lead)'
                        strokeWidth='0.7'
                        opacity='0.45'
                    />
                    <text
                        x='521'
                        y='61'
                        fontSize='10.5'
                        fontWeight='500'
                        letterSpacing='0.005em'
                        fill='var(--lp-w-ground-lab)'
                        textAnchor='end'
                    >
                        {t('web.landing.worldRuntimeCloud')}
                    </text>
                    <text
                        className='lp-mono lp-w-sub'
                        x='569'
                        y='71'
                        fontSize='7.5'
                        letterSpacing='0.11em'
                        fill='var(--lp-w-ground-lab)'
                        opacity='0.62'
                        textAnchor='end'
                    >
                        {t('web.landing.worldRuntimeCloudSub')}
                    </text>
                    <path
                        d='M 215,172 L 215,150 L 205,150'
                        fill='none'
                        stroke='var(--lp-w-lead)'
                        strokeWidth='0.7'
                        opacity='0.45'
                    />
                    <text
                        x='200'
                        y='153'
                        fontSize='10.5'
                        fontWeight='500'
                        letterSpacing='0.005em'
                        fill='var(--lp-w-ground-lab)'
                        textAnchor='end'
                    >
                        {t('web.landing.worldRuntimeOwn')}
                    </text>
                    <text
                        className='lp-mono lp-w-sub'
                        x='152'
                        y='163'
                        fontSize='7.5'
                        letterSpacing='0.11em'
                        fill='var(--lp-w-ground-lab)'
                        opacity='0.62'
                        textAnchor='end'
                    >
                        {t('web.landing.worldRuntimeOwnSub')}
                    </text>
                    <path
                        d='M 395,300 L 395,313 L 405,313'
                        fill='none'
                        stroke='var(--lp-w-lead)'
                        strokeWidth='0.7'
                        opacity='0.45'
                    />
                    <text
                        x='410'
                        y='316'
                        fontSize='10.5'
                        fontWeight='500'
                        letterSpacing='0.005em'
                        fill='var(--lp-w-ground-lab)'
                        textAnchor='start'
                    >
                        {t('web.landing.worldRuntimeExternal')}
                    </text>
                    <text
                        className='lp-mono lp-w-sub'
                        x='418'
                        y='326'
                        fontSize='7.5'
                        letterSpacing='0.11em'
                        fill='var(--lp-w-ground-lab)'
                        opacity='0.62'
                        textAnchor='start'
                    >
                        {t('web.landing.worldRuntimeExternalSub')}
                    </text>
                    </g>
                    <g data-layer-title='a' opacity='0'>
                    <text
                        transform='matrix(0.866,0.5,-0.866,0.5,179.1,274.0)'
                        textAnchor='middle'
                        fontSize='16'
                        fontWeight='650'
                        letterSpacing='-0.01em'
                        fill='var(--lp-ink-soft)'
                    >
                        {t('web.landing.worldGroundRuntime')}
                    </text>
                    </g>
                </g>
            </g>
        </svg>
    )
}
