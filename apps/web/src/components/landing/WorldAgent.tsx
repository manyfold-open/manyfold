import type { CSSProperties, FC, ReactNode } from 'react'

/* The world's agent figure and the clocks it runs on, lifted out of
   ScrollyWorld so a second surface can stand the same bot somewhere else
   rather than redraw it: the platform is the constant across the site, and a
   near-copy of this figure would drift from it on the first change. The
   animation classes it uses are scoped to `.landing-root`, not to the world,
   so the figure works anywhere in the marketing register. */

/* What a head can carry: a @lobehub/icons component or the local NarraNexus
   mark. Both take the same four props and the world needs none of the rest of
   lobehub's icon surface — but it has to be a bare call signature rather than
   an `FC`, because `FC` carries a `propTypes` field no `IconType` satisfies. */
export type WorldMark = (props: {
    size?: number
    x?: number
    y?: number
    style?: CSSProperties
}) => ReactNode

/* Every agent in the world is the same figure: a blank head carrying its
   framework's own mark, a body wearing the run slot, two feet, and an
   antenna whose lamp is lit green while the agent is working. The mark is
   the only thing that differs between them — the platform is the constant,
   the framework is the variable.
   The figure is drawn before the desk it belongs to, so the desk cuts it at
   the waist: an agent works behind its desk, it does not stand on it. */
/* Every station is handed the same clocks on a different phase, so the plane
   never moves in unison; negative, so nothing waits for a cycle on load. */
export const phase = (beat: number, period: number, shift = 0): string =>
    `${(-(beat * period) / 3.7 - shift).toFixed(2)}s`

/* One clock for the whole act of writing a line: the screen's active line, the
   body's tap and the head's nod all run on it. */
export const WRITE = 3.1

/* The idle for a figure that is standing in the open rather than working at a
   desk: two small hops and then a rest, on twice the world's 1.6s beat. */
export const HOP = 3.2

export const WorldAgent: FC<{
    x: number
    y: number
    scale: number
    Logo: WorldMark
    /* Mono marks paint themselves `currentColor`; give them the page ink so
       they read on both plates. */
    mono?: boolean
    /* Phase offset, so seven agents do not breathe in unison. */
    beat?: number
    /* Which idle the figure runs. 'work' is the world's own: the body presses
       down and the head nods, which is what an agent behind a desk does.
       'hop' is for a figure standing in the open, where pressing down at
       nothing reads as a twitch. */
    motion?: 'work' | 'hop'
}> = ({ x, y, scale, Logo, mono = false, beat = 0, motion = 'work' }) => (
    <g transform={`translate(${x},${y}) scale(${scale})`}>
        {/* Outside the animated group: a cast shadow belongs to the ground,
            not to the figure. Inside it, it would leave the floor with every
            hop and get squashed along with the body. */}
        <ellipse
            className={
                motion === 'hop' ? 'lp-w-cast lp-w-cast-hop' : 'lp-w-cast'
            }
            cx='0'
            cy='2'
            rx='11.5'
            ry='3.4'
            fill='#000'
            opacity='0.16'
            style={{ animationDelay: phase(beat, HOP) }}
        />
        <g
            className={motion === 'hop' ? 'lp-w-hop' : 'lp-w-tap'}
            style={{
                animationDelay: phase(beat, motion === 'hop' ? HOP : WRITE)
            }}
        >
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
                className={motion === 'hop' ? undefined : 'lp-w-nod'}
                style={
                    motion === 'hop'
                        ? undefined
                        : { animationDelay: phase(beat, WRITE) }
                }
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
